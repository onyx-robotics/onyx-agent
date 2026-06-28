import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type {
  LocalResearchCampaignExperimentLoggedRecord,
  ResearchHypothesisPlan,
  ResearchSetupFile,
} from "../protocol"

import type {
  ApiCampaign,
  ApiCampaignExperiment,
  ApiHypothesis,
  ApiKnowledge,
  ApiSession,
  ApiSessionState,
  ApiSummary,
  ApiWorker,
} from "./api"
import {
  onyxStateDir,
  readState,
  updateState,
  withOnyxLock,
  type LastRunRecord,
  type LastRunSelector,
} from "./outbox"
import { acquireFileResourceLease } from "./resource-locks"

export type ResearchSyncEventStatus = "pending" | "acked" | "conflict"

export type ResearchSyncEvent = {
  eventId: string
  sequence: number
  type: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
  status: ResearchSyncEventStatus
  attempts: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type LocalCampaign = ApiCampaign & {
  status: "active" | "completed" | "archived"
  projectPath: string
  setup: ResearchSetupFile | Record<string, unknown>
  humanFeedback: string | null
  bestExperimentId: string | null
  createdAt: string
  updatedAt: string
}

export type LocalWorkflowRunStatus =
  | "running"
  | "paused"
  | "blocked"
  | "abandoned"
  | "superseded"
  | "failed"
  | "checks_failed"
  | "setup_violation"
  | "succeeded"

export type LocalWorkflowStepStatus =
  | "pending"
  | "paused"
  | "running"
  | "passed"
  | "failed"
  | "skipped"

export type LocalWorkflowRun = {
  id: string
  campaignId: string | null
  campaignName: string
  projectPath: string
  runRef: string
  baseCommitSha: string
  resultCommitSha: string | null
  resultRef: string
  setupHash: string
  status: LocalWorkflowRunStatus
  currentStepIndex: number
  metrics: Record<string, number>
  blockReason: string | null
  createdAt: string
  startedAt: string
  completedAt: string | null
  updatedAt: string
  sessionId?: string
  workerId?: string
  hypothesisId?: string
}

export type WorkflowRunSelector = {
  campaignName?: string
  projectPath?: string
  sessionId?: string
  workerId?: string
  hypothesisId?: string
  statuses?: LocalWorkflowRunStatus[]
}

export type LocalWorkflowStep = {
  runId: string
  stepId: string
  stepIndex: number
  kind: "agent" | "run"
  toolId: string | null
  status: LocalWorkflowStepStatus
  attempt: number
  exitCode: number | null
  timedOut: boolean
  outputSummary: string | null
  metrics: Record<string, number>
  logPath: string | null
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}

type LocalSummaryKind = ApiSummary["summaryKind"]
type LocalKnowledgeKind = ApiKnowledge["kind"]

export type LocalDiscardedAttempt = {
  runRef: string
  campaignId: string | null
  campaignName: string
  projectPath: string
  sessionId: string | null
  workerId: string | null
  hypothesisId: string | null
  resultCommitSha: string | null
  resultRef: string | null
  reason: string
  manifestPath: string | null
  logPath: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type AcceptOrDiscardExperimentResult =
  | {
      outcome: "accepted"
      experiment: ApiCampaignExperiment
      idempotent: boolean
    }
  | {
      outcome: "discarded"
      discarded: LocalDiscardedAttempt
      idempotent: boolean
    }

type LocalSessionRecord = {
  session: ApiSession
  campaign: ApiCampaign
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
  experiments: ApiCampaignExperiment[]
  summaries: ApiSummary[]
  knowledge: ApiKnowledge[]
}

function nowIso() {
  return new Date().toISOString()
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160) || "item"
}

async function runtimeDir(root: string) {
  const dir = join(await onyxStateDir(root), "runtime")
  await mkdir(dir, { recursive: true })
  return dir
}

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true })
  return path
}

async function jsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

async function campaignsPath(root: string) {
  return join(await runtimeDir(root), "campaigns.json")
}

async function sessionsDir(root: string) {
  return ensureDir(join(await runtimeDir(root), "sessions"))
}

async function workflowRunsDir(root: string) {
  return ensureDir(join(await onyxStateDir(root), "workflow-runs"))
}

async function attemptsDir(root: string) {
  return ensureDir(join(await onyxStateDir(root), "attempts"))
}

async function siteIdPath(root: string) {
  return join(await runtimeDir(root), "site-id")
}

async function readCampaigns(root: string) {
  return jsonFile<Record<string, LocalCampaign>>(await campaignsPath(root), {})
}

async function writeCampaigns(root: string, campaigns: Record<string, LocalCampaign>) {
  await writeJson(await campaignsPath(root), campaigns)
}

function campaignKey(projectPath: string, name: string) {
  return `${projectPath}\0${name}`
}

function campaignFromInput({
  id = randomUUID(),
  projectId = "local",
  name,
  description = null,
  projectPath,
  baseCommitSha,
  setup = {},
  metricName,
  metricUnit = null,
  metricDirection,
  humanFeedback = null,
  promotionRefName = null,
  status = "active",
  createdAt = nowIso(),
  updatedAt = nowIso(),
  bestExperimentId = null,
  bestMetricValue = null,
  bestCommitSha = null,
  experimentCount = 0,
}: {
  id?: string
  projectId?: string
  name: string
  description?: string | null
  projectPath: string
  baseCommitSha: string
  setup?: ResearchSetupFile | Record<string, unknown>
  metricName: string
  metricUnit?: string | null
  metricDirection: "maximize" | "minimize"
  humanFeedback?: string | null
  promotionRefName?: string | null
  status?: "active" | "completed" | "archived"
  createdAt?: string
  updatedAt?: string
  bestExperimentId?: string | null
  bestMetricValue?: number | null
  bestCommitSha?: string | null
  experimentCount?: number
}): LocalCampaign {
  return {
    id,
    projectId,
    name,
    description,
    parentCampaignId: null,
    projectPath,
    baseCommitSha,
    setup,
    metricName,
    metricUnit,
    metricDirection,
    humanFeedback,
    promotionRefName,
    status,
    bestExperimentId,
    bestMetricValue,
    bestCommitSha,
    experimentCount,
    lastExperimentAt: null,
    createdAt,
    updatedAt,
  }
}

function defaultSession({
  id = randomUUID(),
  campaignId,
  name,
  workerTarget,
  experimentTarget = null,
  deadlineAt = null,
  schedulerSiteId = null,
  metadata = {},
}: {
  id?: string
  campaignId: string
  name: string
  workerTarget: number | null
  experimentTarget?: number | null
  deadlineAt?: string | null
  schedulerSiteId?: string | null
  metadata?: Record<string, unknown>
}): ApiSession {
  const at = nowIso()
  return {
    id,
    campaignId,
    name,
    status: "running",
    workerTarget,
    experimentTarget,
    acceptedExperimentCount: 0,
    remainingExperimentCount:
      experimentTarget === null ? null : Math.max(0, experimentTarget),
    deadlineAt,
    terminalReason: null,
    schedulerSiteId,
    finalizationStatus: "running",
    metadata,
    startedAt: at,
    completedAt: null,
    createdAt: at,
    updatedAt: at,
  }
}

function defaultHypothesis({
  id = randomUUID(),
  campaignId,
  createdBySessionId = null,
  plan,
  name,
  description,
  baseCommitSha,
  metadata = {},
}: {
  id?: string
  campaignId: string
  createdBySessionId?: string | null
  plan: ResearchHypothesisPlan
  name?: string
  description?: string | null
  baseCommitSha?: string | null
  metadata?: Record<string, unknown>
}): ApiHypothesis {
  const at = nowIso()
  return {
    id,
    campaignId,
    createdBySessionId,
    name: (name ?? plan.focus.slice(0, 80)) || `hypothesis-${id.slice(0, 8)}`,
    description: description ?? plan.statement,
    status: "active",
    baseCommitSha: baseCommitSha ?? "",
    bestExperimentId: null,
    bestMetricValue: null,
    lastWorkedAt: null,
    plan,
    metadata,
    createdAt: at,
    updatedAt: at,
  }
}

async function sessionPath(root: string, sessionId: string) {
  return join(await sessionsDir(root), `${safeSegment(sessionId)}.json`)
}

async function readSessionRecord(root: string, sessionId: string) {
  const record = await jsonFile<LocalSessionRecord | null>(
    await sessionPath(root, sessionId),
    null
  )
  if (!record) throw new Error(`Local research session ${sessionId} not found`)
  return record
}

async function writeSessionRecord(root: string, record: LocalSessionRecord) {
  await writeJson(await sessionPath(root, record.session.id), record)
}

function attemptPathForRunRef(root: string, runRef: string) {
  return attemptsDir(root).then((dir) => join(dir, `${safeSegment(runRef)}.json`))
}

async function workflowRunDir(root: string, id: string) {
  return ensureDir(join(await workflowRunsDir(root), safeSegment(id)))
}

async function workflowRunPath(root: string, id: string) {
  return join(await workflowRunDir(root, id), "run.json")
}

async function workflowStepsPath(root: string, id: string) {
  return join(await workflowRunDir(root, id), "steps.json")
}

async function listJsonFiles<T>(dir: string): Promise<T[]> {
  const files = await readdir(dir).catch(() => [])
  const values: T[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const value = await jsonFile<T | null>(join(dir, file), null)
    if (value) values.push(value)
  }
  return values
}

function matchesAttempt(record: LastRunRecord, selector: LastRunSelector) {
  return (
    (!selector.runRef || record.runRef === selector.runRef) &&
    (!selector.campaignName || record.campaignName === selector.campaignName) &&
    (selector.projectPath === undefined || record.projectPath === selector.projectPath) &&
    (!selector.sessionId || record.sessionId === selector.sessionId) &&
    (!selector.workerId || record.workerId === selector.workerId) &&
    (!selector.hypothesisId || record.hypothesisId === selector.hypothesisId)
  )
}

function matchesWorkflowRun(run: LocalWorkflowRun, selector: WorkflowRunSelector) {
  return (
    (!selector.campaignName || run.campaignName === selector.campaignName) &&
    (selector.projectPath === undefined || run.projectPath === selector.projectPath) &&
    (!selector.sessionId || run.sessionId === selector.sessionId) &&
    (!selector.workerId || run.workerId === selector.workerId) &&
    (!selector.hypothesisId || run.hypothesisId === selector.hypothesisId) &&
    (!selector.statuses || selector.statuses.includes(run.status))
  )
}

export async function researchDbPath(root: string) {
  return join(await runtimeDir(root), "runtime-state.json")
}

export async function getResearchSiteId(root: string) {
  const path = await siteIdPath(root)
  try {
    const existing = (await readFile(path, "utf8")).trim()
    if (existing) return existing
  } catch {
    // The site id is created lazily on first use.
  }
  const id = randomUUID()
  await writeFile(path, `${id}\n`, "utf8")
  return id
}

export async function assertLocalSessionSchedulerSite(_input: {
  root: string
  sessionId: string
  schedulerSiteId?: string | null
}) {
  void _input
  return
}

export async function setActiveLocalCampaign({
  root,
  projectPath,
  campaignName,
}: {
  root: string
  projectPath: string
  campaignName: string
}) {
  await updateState(root, (state) => {
    state.projectPath = projectPath
    state.activeCampaign = campaignName
  })
}

export async function getActiveLocalCampaignName(root: string) {
  return (await readState(root).catch(() => null))?.activeCampaign ?? null
}

export async function createLocalCampaign(input: {
  root: string
  name: string
  description?: string | null
  projectPath: string
  baseCommitSha: string
  setup: ResearchSetupFile
  metricName: string
  metricUnit?: string | null
  metricDirection: "maximize" | "minimize"
  humanFeedback?: string | null
  promotionRefName?: string | null
}) {
  return withOnyxLock(input.root, "runtime-campaigns", async () => {
    const campaigns = await readCampaigns(input.root)
    const key = campaignKey(input.projectPath, input.name)
    const existing = campaigns[key]
    const campaign = campaignFromInput({
      id: existing?.id,
      projectId: existing?.projectId ?? "local",
      createdAt: existing?.createdAt,
      ...input,
    })
    campaigns[key] = campaign
    await writeCampaigns(input.root, campaigns)
    await setActiveLocalCampaign({
      root: input.root,
      projectPath: input.projectPath,
      campaignName: input.name,
    })
    return campaign
  })
}

export async function cacheLocalCampaign({
  root,
  campaign,
  projectPath,
  setup = {},
}: {
  root: string
  campaign: ApiCampaign
  projectPath: string
  setup?: ResearchSetupFile | Record<string, unknown>
}) {
  return withOnyxLock(root, "runtime-campaigns", async () => {
    const campaigns = await readCampaigns(root)
    const key = campaignKey(projectPath, campaign.name)
    const local = campaignFromInput({
      id: campaign.id,
      projectId: campaign.projectId,
      name: campaign.name,
      description: campaign.description,
      projectPath,
      baseCommitSha: campaign.baseCommitSha,
      setup,
      metricName: campaign.metricName,
      metricUnit: campaign.metricUnit,
      metricDirection: campaign.metricDirection,
      promotionRefName: campaign.promotionRefName,
      status: campaign.status ?? "active",
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      bestExperimentId: campaign.bestExperimentId ?? null,
      bestMetricValue: campaign.bestMetricValue,
      bestCommitSha: campaign.bestCommitSha,
      experimentCount: campaign.experimentCount,
    })
    campaigns[key] = local
    await writeCampaigns(root, campaigns)
    return local
  })
}

export async function completeLocalCampaign({
  root,
  campaignId,
}: {
  root: string
  campaignId: string
}) {
  const campaigns = await readCampaigns(root)
  const entry = Object.entries(campaigns).find(([, campaign]) => campaign.id === campaignId)
  if (!entry) throw new Error("Local campaign not found")
  const [key, campaign] = entry
  campaigns[key] = { ...campaign, status: "completed", updatedAt: nowIso() }
  await writeCampaigns(root, campaigns)
  return campaigns[key]
}

export async function localCampaignByName({
  root,
  projectPath,
  name,
}: {
  root: string
  projectPath: string
  name: string
}) {
  return (await readCampaigns(root))[campaignKey(projectPath, name)] ?? null
}

export async function localCampaignById(root: string, campaignId: string) {
  return (
    Object.values(await readCampaigns(root)).find((campaign) => campaign.id === campaignId) ??
    null
  )
}

export async function listLocalCampaigns(root: string) {
  return Object.values(await readCampaigns(root)).filter(
    (campaign) => campaign.status !== "archived"
  )
}

export async function deleteLocalCampaignWithTombstone({
  root,
  projectPath,
  name,
}: {
  root: string
  projectPath: string
  name: string
  reason?: string | null
}) {
  const campaigns = await readCampaigns(root)
  const key = campaignKey(projectPath, name)
  const campaign = campaigns[key]
  if (!campaign) throw new Error(`Local campaign ${name} not found`)
  delete campaigns[key]
  await writeCampaigns(root, campaigns)
  return { campaignId: campaign.id, deletedExperimentCount: 0 }
}

export async function createLocalSession({
  root,
  campaignId,
  name,
  workerTarget,
  hypotheses = [],
  metadata = {},
  experimentTarget = null,
  deadlineAt = null,
  schedulerSiteId = null,
}: {
  root: string
  campaignId: string
  name: string
  workerTarget: number
  hypotheses?: ResearchHypothesisPlan[]
  metadata?: Record<string, unknown>
  experimentTarget?: number | null
  deadlineAt?: string | null
  schedulerSiteId?: string | null
}) {
  const campaign = (await localCampaignById(root, campaignId)) ??
    campaignFromInput({
      id: campaignId,
      name: `campaign-${campaignId.slice(0, 8)}`,
      projectPath: "",
      baseCommitSha: "",
      metricName: "score",
      metricDirection: "maximize",
    })
  const session = defaultSession({
    campaignId,
    name,
    workerTarget,
    experimentTarget,
    deadlineAt,
    schedulerSiteId,
    metadata,
  })
  const createdHypotheses = hypotheses.map((plan, index) =>
    defaultHypothesis({
      campaignId,
      createdBySessionId: session.id,
      plan,
      name: `hypothesis-${index + 1}`,
      baseCommitSha: campaign.baseCommitSha,
    })
  )
  const record: LocalSessionRecord = {
    session,
    campaign,
    hypotheses: createdHypotheses,
    workers: [],
    experiments: [],
    summaries: [],
    knowledge: [],
  }
  await writeSessionRecord(root, record)
  await updateState(root, (state) => {
    state.sessions = state.sessions ?? {}
    state.sessions![session.id] = {
      ...(state.sessions![session.id] ?? {}),
      campaignName: campaign.name,
      campaignId,
      status: session.status,
      experimentTarget,
      acceptedExperimentCount: 0,
      remainingExperimentCount: session.remainingExperimentCount,
      deadlineAt,
      schedulerSiteId,
    }
    if (state.activeCampaign) {
      const key = `${campaign.projectPath}\0${state.activeCampaign}`
      state.campaigns = state.campaigns ?? {}
      state.campaigns[key] = {
        ...(state.campaigns[key] ?? {}),
        sessionId: session.id,
        campaignId,
      }
    }
  }).catch(() => {})
  return { session, hypotheses: createdHypotheses }
}

export async function cacheResearchSessionState({
  root,
  campaign,
  session,
  hypotheses = [],
  workers = [],
  experiments = [],
  summaries = [],
  knowledge = [],
}: {
  root: string
  campaign: ApiCampaign
  session: ApiSession
  hypotheses?: ApiHypothesis[]
  workers?: ApiWorker[]
  experiments?: ApiCampaignExperiment[]
  summaries?: ApiSummary[]
  knowledge?: ApiKnowledge[]
}) {
  const existing = await readSessionRecord(root, session.id).catch(() => null)
  const record: LocalSessionRecord = {
    campaign,
    session,
    hypotheses: hypotheses.length > 0 ? hypotheses : (existing?.hypotheses ?? []),
    workers: workers.length > 0 ? workers : (existing?.workers ?? []),
    experiments: experiments.length > 0 ? experiments : (existing?.experiments ?? []),
    summaries: summaries.length > 0 ? summaries : (existing?.summaries ?? []),
    knowledge: knowledge.length > 0 ? knowledge : (existing?.knowledge ?? []),
  }
  await writeSessionRecord(root, record)
  await updateState(root, (state) => {
    state.sessions = state.sessions ?? {}
    state.sessions![session.id] = {
      ...(state.sessions![session.id] ?? {}),
      campaignName: campaign.name,
      campaignId: campaign.id,
      status: session.status,
      experimentTarget: session.experimentTarget,
      acceptedExperimentCount: session.acceptedExperimentCount,
      remainingExperimentCount: session.remainingExperimentCount,
      deadlineAt: session.deadlineAt,
      schedulerSiteId: session.schedulerSiteId,
    }
    const key = campaignKey(
      (campaign as ApiCampaign & { projectPath?: string }).projectPath ?? "",
      campaign.name
    )
    state.campaigns = state.campaigns ?? {}
    state.campaigns[key] = {
      ...(state.campaigns[key] ?? {}),
      campaignId: campaign.id,
      sessionId: session.id,
    }
  }).catch(() => {})
  return record
}

export async function createLocalHypothesis(input: {
  root: string
  campaignId: string
  createdBySessionId?: string | null
  plan: ResearchHypothesisPlan
  name?: string
  description?: string | null
  baseCommitSha?: string | null
  metadata?: Record<string, unknown>
}) {
  const hypothesis = defaultHypothesis(input)
  if (input.createdBySessionId) {
    const record = await readSessionRecord(input.root, input.createdBySessionId).catch(() => null)
    if (record) {
      record.hypotheses.push(hypothesis)
      await writeSessionRecord(input.root, record)
    }
  }
  return hypothesis
}

export async function getLocalSessionState(root: string, sessionId: string): Promise<ApiSessionState> {
  const record = await readSessionRecord(root, sessionId)
  return { ...record, latestExperiments: record.experiments, bestExperiment: record.experiments[0] ?? null, updatedAt: nowIso() }
}

export async function listLocalHypotheses(root: string, campaignId: string) {
  const sessions = await listJsonFiles<LocalSessionRecord>(await sessionsDir(root))
  return sessions.flatMap((session) => session.hypotheses).filter((hypothesis) => hypothesis.campaignId === campaignId)
}

export async function registerLocalWorker({
  root,
  campaignId,
  sessionId,
  hypothesisId,
  workerName,
  agentKind,
  runtime = "local",
  metadata = {},
}: {
  root: string
  campaignId: string
  sessionId?: string | null
  hypothesisId: string
  workerName: string
  agentKind: string
  runtime?: "local" | "hosted"
  metadata?: Record<string, unknown>
}) {
  const at = nowIso()
  const worker: ApiWorker = {
    id: randomUUID(),
    campaignId,
    sessionId: sessionId ?? null,
    hypothesisId,
    workerName,
    agentKind,
    runtime,
    status: "registered",
    currentExperimentId: null,
    phase: null,
    progressMessage: null,
    gitLabel: null,
    lastSeenAt: at,
    startedAt: at,
    metadata,
    createdAt: at,
    updatedAt: at,
  }
  if (sessionId) {
    const record = await readSessionRecord(root, sessionId).catch(() => null)
    if (record) {
      record.workers.push(worker)
      await writeSessionRecord(root, record)
    }
  }
  return worker
}

export async function recordLocalWorkerHeartbeat({
  root,
  workerId,
  status = "running",
  sessionId,
  hypothesisId,
  experimentId,
  phase,
  progressMessage,
  gitLabel,
  metadata = {},
}: {
  root: string
  workerId: string
  status?: ApiWorker["status"]
  sessionId?: string | null
  hypothesisId?: string | null
  experimentId?: string | null
  phase?: string | null
  event?: string | null
  progressMessage?: string | null
  gitLabel?: string | null
  resourceStats?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  if (!sessionId) throw new Error("Local worker heartbeat requires sessionId")
  const record = await readSessionRecord(root, sessionId)
  const existing = record.workers.find((worker) => worker.id === workerId)
  const at = nowIso()
  const worker: ApiWorker = {
    ...(existing ?? {
      id: workerId,
      campaignId: record.session.campaignId,
      sessionId,
      hypothesisId: hypothesisId ?? record.hypotheses[0]?.id ?? "",
      workerName: `worker-${workerId.slice(0, 8)}`,
      agentKind: "unknown",
      runtime: "local" as const,
      currentExperimentId: null,
      startedAt: at,
      createdAt: at,
    }),
    status,
    sessionId,
    hypothesisId: hypothesisId ?? existing?.hypothesisId ?? "",
    currentExperimentId: experimentId ?? null,
    phase: phase ?? null,
    progressMessage: progressMessage ?? null,
    gitLabel: gitLabel ?? null,
    lastSeenAt: at,
    metadata: { ...(existing?.metadata ?? {}), ...metadata },
    updatedAt: at,
  }
  record.workers = [...record.workers.filter((item) => item.id !== workerId), worker]
  await writeSessionRecord(root, record)
  return worker
}

export async function stopLocalSession({
  root,
  sessionId,
  status,
  finalizationStatus,
  terminalReason,
  metadata,
}: {
  root: string
  sessionId: string
  status: ApiSession["status"]
  finalizationStatus?: ApiSession["finalizationStatus"] | null
  terminalReason?: ApiSession["terminalReason"] | null
  reason?: string | null
  metadata?: Record<string, unknown>
}) {
  const record = await readSessionRecord(root, sessionId)
  record.session = {
    ...record.session,
    status,
    finalizationStatus: finalizationStatus ?? record.session.finalizationStatus,
    terminalReason: terminalReason ?? record.session.terminalReason,
    metadata: { ...record.session.metadata, ...(metadata ?? {}) },
    completedAt: status === "running" || status === "stop_requested" ? record.session.completedAt : nowIso(),
    updatedAt: nowIso(),
  }
  await writeSessionRecord(root, record)
  return record.session
}

export async function acceptOrDiscardLocalExperiment({
  record,
}: {
  root: string
  record: LocalResearchCampaignExperimentLoggedRecord
  manifestPath?: string | null
  logPath?: string | null
  metadata?: Record<string, unknown>
}): Promise<AcceptOrDiscardExperimentResult> {
  const at = nowIso()
  const experiment: ApiCampaignExperiment = {
    id: randomUUID(),
    campaignId: "",
    sessionId: record.sessionId ?? null,
    hypothesisId: record.hypothesisId ?? null,
    workerId: record.workerId ?? null,
    acceptedIndex: null,
    runRef: record.runRef,
    name: record.name,
    description: record.description ?? null,
    baseCommitSha: record.baseCommitSha,
    resultCommitSha: record.resultCommitSha,
    resultRef: record.resultRef,
    status: record.status,
    setupCompliance: record.setupCompliance,
    gitStatus: "pending",
    gitVerifiedAt: null,
    gitStatusReason: null,
    primaryMetricName: record.primaryMetricName,
    primaryMetricValue: record.primaryMetricValue,
    secondaryMetrics: record.metrics,
    artifactRefs: {},
    agentNotes: record.agentNotes,
    checks: record.checks
      ? {
          status: record.checks.status,
          durationMs: record.checks.durationMs ?? null,
          outputSummary: record.checks.outputSummary ?? null,
        }
      : null,
    durationMs: record.durationMs ?? null,
    outputSummary: record.outputSummary ?? null,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    createdAt: record.createdAt ?? at,
    updatedAt: at,
  }
  return { outcome: "accepted", experiment, idempotent: false }
}

export async function logLocalExperiment(input: {
  root: string
  record: LocalResearchCampaignExperimentLoggedRecord
}) {
  const result = await acceptOrDiscardLocalExperiment(input)
  if (result.outcome === "discarded") throw new Error(result.discarded.reason)
  return result.experiment
}

export async function listLocalExperimentHistory(
  _root: string,
  _options: { campaignName?: string; limit?: number } = {}
): Promise<LocalResearchCampaignExperimentLoggedRecord[]> {
  void _root
  void _options
  return []
}

export async function markExperimentRefsVerified(_input: {
  root: string
  refs: Array<{ runRef: string; commitSha: string; ref: string }>
}) {
  void _input
}

export async function applyRemoteExperimentGitStatuses(_input: {
  root: string
  experiments: ApiCampaignExperiment[]
}) {
  void _input
}

export async function applyRemoteProjectionDeltas(_input: {
  root: string
  deltas: {
    campaigns: ApiCampaign[]
    sessions: ApiSession[]
    hypotheses: ApiHypothesis[]
    workers: ApiWorker[]
    experiments: ApiCampaignExperiment[]
    summaries: ApiSummary[]
    knowledge: ApiKnowledge[]
  }
}) {
  void _input
}

export async function writeLocalAttempt({
  root,
  record,
}: {
  root: string
  record: LastRunRecord
}) {
  await writeJson(await attemptPathForRunRef(root, record.runRef), record)
}

export async function readLocalAttempt(root: string, selector: LastRunSelector) {
  return (await listLocalAttempts(root, selector))[0] ?? null
}

export async function listLocalAttempts(root: string, selector: LastRunSelector = {}) {
  const attempts = await listJsonFiles<LastRunRecord>(await attemptsDir(root))
  return attempts
    .filter((attempt) => matchesAttempt(attempt, selector))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function clearLocalAttempt(root: string, selector: LastRunSelector) {
  if (selector.runRef) {
    await unlink(await attemptPathForRunRef(root, selector.runRef)).catch(() => {})
    return
  }
  const attempt = await readLocalAttempt(root, selector)
  if (attempt) await unlink(await attemptPathForRunRef(root, attempt.runRef)).catch(() => {})
}

export async function upsertWorkflowRun({
  root,
  run,
}: {
  root: string
  run: LocalWorkflowRun
}) {
  await writeJson(await workflowRunPath(root, run.id), {
    ...run,
    updatedAt: nowIso(),
  })
}

export async function readWorkflowRun(root: string, id: string) {
  return jsonFile<LocalWorkflowRun | null>(await workflowRunPath(root, id), null)
}

export async function listWorkflowRuns(root: string, selector: WorkflowRunSelector = {}) {
  const dirs = await readdir(await workflowRunsDir(root)).catch(() => [])
  const runs: LocalWorkflowRun[] = []
  for (const dir of dirs) {
    const run = await jsonFile<LocalWorkflowRun | null>(
      join(await workflowRunsDir(root), dir, "run.json"),
      null
    )
    if (run && matchesWorkflowRun(run, selector)) runs.push(run)
  }
  return runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function readLatestActiveWorkflowRun(input: {
  root: string
  campaignName: string
  projectPath: string
}) {
  return (
    await listWorkflowRuns(input.root, {
      campaignName: input.campaignName,
      projectPath: input.projectPath,
      statuses: ["running", "paused"],
    })
  )[0] ?? null
}

export async function readLatestBlockedWorkflowRun(input: {
  root: string
  campaignName: string
  projectPath: string
}) {
  return (
    await listWorkflowRuns(input.root, {
      campaignName: input.campaignName,
      projectPath: input.projectPath,
      statuses: ["blocked"],
    })
  )[0] ?? null
}

export async function readLatestWorkflowRun(input: {
  root: string
  campaignName: string
  projectPath: string
}) {
  return (
    await listWorkflowRuns(input.root, {
      campaignName: input.campaignName,
      projectPath: input.projectPath,
    })
  )[0] ?? null
}

export async function abandonBlockedWorkflowRunsForSession({
  root,
  sessionId,
  workerId = null,
  hypothesisId = null,
  reason,
}: {
  root: string
  sessionId: string
  workerId?: string | null
  hypothesisId?: string | null
  reason: string
}) {
  const runs = await listWorkflowRuns(root, {
    sessionId,
    ...(workerId ? { workerId } : {}),
    ...(hypothesisId ? { hypothesisId } : {}),
    statuses: ["blocked"],
  })
  for (const run of runs) {
    await upsertWorkflowRun({
      root,
      run: {
        ...run,
        status: "abandoned",
        blockReason: run.blockReason ? `${run.blockReason}; ${reason}` : reason,
        completedAt: run.completedAt ?? nowIso(),
      },
    })
  }
  return runs.map((run) => run.runRef)
}

export async function upsertWorkflowStep({
  root,
  step,
}: {
  root: string
  step: LocalWorkflowStep
}) {
  const steps = await listWorkflowSteps(root, step.runId)
  const next = [
    ...steps.filter((item) => item.stepId !== step.stepId),
    { ...step, updatedAt: nowIso() },
  ].sort((left, right) => left.stepIndex - right.stepIndex)
  await writeJson(await workflowStepsPath(root, step.runId), next)
}

export async function listWorkflowSteps(root: string, runId: string) {
  return jsonFile<LocalWorkflowStep[]>(await workflowStepsPath(root, runId), [])
}

export async function upsertLocalSummary(input: {
  root: string
  campaignId: string
  sessionId?: string
  hypothesisId?: string
  authoredByWorkerId?: string
  summaryKind: LocalSummaryKind
  title: string
  body: string
  isCurrent?: boolean
  metadata?: Record<string, unknown>
}) {
  const at = nowIso()
  return {
    id: randomUUID(),
    campaignId: input.campaignId,
    sessionId: input.sessionId ?? null,
    hypothesisId: input.hypothesisId ?? null,
    authoredByWorkerId: input.authoredByWorkerId ?? null,
    summaryKind: input.summaryKind,
    title: input.title,
    body: input.body,
    isCurrent: input.isCurrent ?? true,
    metadata: input.metadata ?? {},
    createdAt: at,
    updatedAt: at,
  } satisfies ApiSummary
}

export async function listLocalSummaries(
  _root: string,
  _campaignId: string
): Promise<ApiSummary[]> {
  void _root
  void _campaignId
  return []
}

export async function createLocalKnowledge(input: {
  root: string
  campaignId: string
  sessionId?: string
  hypothesisId?: string
  authoredByWorkerId?: string
  experimentId?: string
  kind: LocalKnowledgeKind
  title: string
  body: string
  confidence?: number | null
  metadata?: Record<string, unknown>
}) {
  const at = nowIso()
  return {
    id: randomUUID(),
    campaignId: input.campaignId,
    sessionId: input.sessionId ?? null,
    hypothesisId: input.hypothesisId ?? null,
    authoredByWorkerId: input.authoredByWorkerId ?? null,
    experimentId: input.experimentId ?? null,
    kind: input.kind,
    title: input.title,
    body: input.body,
    confidence: input.confidence ?? null,
    metadata: input.metadata ?? {},
    createdAt: at,
    updatedAt: at,
  } satisfies ApiKnowledge
}

export async function listLocalKnowledge(
  _root: string,
  _campaignId: string
): Promise<ApiKnowledge[]> {
  void _root
  void _campaignId
  return []
}

export async function pendingResearchSyncEvents(
  _root: string,
  _limit = 100
): Promise<ResearchSyncEvent[]> {
  void _root
  void _limit
  return []
}

export async function markResearchSyncAcked(_input: {
  root: string
  eventId: string
  serverStatus: string
  serverEntityId?: string | null
  details?: Record<string, unknown>
}) {
  void _input
}

export async function applyRemoteTombstones(_input: { root: string; tombstones: unknown[] }) {
  void _input
}

export async function applyProjectDeletions(_input: { root: string; deletions: unknown }) {
  void _input
}

export async function markResearchSyncError(_input: {
  root: string
  eventIds: string[]
  message: string
}) {
  void _input
}

export async function markResearchSyncConflict(_input: {
  root: string
  eventId: string
  message: string
}) {
  void _input
}

export async function pendingResearchSyncCount(_root: string) {
  void _root
  return 0
}

export async function oldestPendingResearchSyncAgeMs(_root: string) {
  void _root
  return null
}

export async function researchSyncConflictCount(_root: string) {
  void _root
  return 0
}

export async function listResearchSyncConflicts(
  _root: string
): Promise<ResearchSyncEvent[]> {
  void _root
  return []
}

export async function retryResearchSyncConflicts(_root: string) {
  void _root
  return 0
}

export async function upsertWorkerLaunch(_input: {
  root: string
  launch: {
    sessionId: string
    hypothesisId: string
    workerId: string
    status: string
    worktree?: string | null
    branchName?: string | null
    promptPath?: string | null
    logPath?: string | null
    activityLogPath?: string | null
    manifestPath?: string | null
    exitCode?: number | null
    signal?: string | null
    timedOut?: boolean
    startupTimedOut?: boolean
    lastOutputAt?: string | null
    finalizationStatus?: string | null
    error?: string | null
    metadata?: Record<string, unknown>
    startedAt?: string | null
    completedAt?: string | null
  }
}) {
  void _input
}

export async function researchSyncStatus(_root: string) {
  void _root
  return {
    path: null,
    pending: 0,
    conflicts: 0,
    oldestPendingAgeMs: null,
    lastAckedAt: null,
  }
}

export async function researchDbDoctor(_root: string) {
  void _root
  return { ok: true, sqlite: false }
}

export async function acquireLocalResourceLease(input: {
  root: string
  resourceName: string
  slots: number
  timeoutMs: number
  leaseMs: number
  ownerId: string
  metadata?: Record<string, unknown>
}) {
  return acquireFileResourceLease(input)
}

export async function renewLocalResourceLease(_input: {
  root: string
  resourceName: string
  ownerId: string
  leaseMs: number
}) {
  void _input
  return
}

export async function cleanupExpiredResourceLeases(_root: string) {
  void _root
}

export async function listLocalResourceLeases(_root: string) {
  void _root
  return []
}

export async function localBriefMarkdown() {
  return "Remote research brief is available through `onyx research brief`."
}

export type LocalResearchBrief = {
  markdown: string
  campaign: LocalCampaign | null
  session: ApiSession | null
  hypothesis: ApiHypothesis | null
  latestExperiments: ApiCampaignExperiment[]
  summaries: ApiSummary[]
  knowledge: ApiKnowledge[]
}

export async function localResearchBrief(): Promise<LocalResearchBrief> {
  return {
    markdown: "Remote research brief is available through `onyx research brief`.",
    campaign: null,
    session: null,
    hypothesis: null,
    latestExperiments: [],
    summaries: [],
    knowledge: [],
  }
}

export async function campaignRecordToLocal(record: LocalResearchCampaignExperimentLoggedRecord) {
  return record
}

export async function createCampaignFromSetup(input: Parameters<typeof createLocalCampaign>[0]) {
  return createLocalCampaign(input)
}
