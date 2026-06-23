import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  researchHypothesisPlanSchema,
  type ResearchHypothesisPlan,
} from "../protocol"
import { optionValues, type Args } from "../lib/args"
import { commandExpLog, commandExpRun } from "./exp"
import {
  getCampaignBrief,
  getCampaignOverview,
  getResearchSessionState,
  listProjectCampaigns,
  reconcileCampaign,
  stopCampaignSession,
  syncResearchPresence,
  resolveProject,
  type ApiCampaign,
  type ApiHypothesis,
  type ApiSummary,
  type ApiWorker,
} from "../lib/api"
import {
  readSetupFile,
  readValidationFile,
  setupPath,
  validationMatchesSetup,
  validationPath,
  type ResearchSetupFile,
} from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, git, gitResult, repoRoot, repositoryUrl } from "../lib/git"
import { onyxStateDir, readState, withOnyxLock, writeState } from "../lib/outbox"
import { campaignStateKey, onyxPath, resolveProjectPath } from "../lib/project"
import {
  pathExists,
  runStreamingProcess,
  type ProcessResult,
  type StreamingProcessResult,
} from "../lib/process"
import {
  abandonBlockedWorkflowRunsForSession,
  cacheLocalCampaign,
  applyRemoteExperimentGitStatuses,
  completeLocalCampaign,
  createLocalHypothesis,
  createLocalKnowledge,
  createLocalSession,
  getActiveLocalCampaignName,
  getLocalSessionState,
  listLocalAttempts,
  listLocalExperimentHistory,
  listLocalKnowledge,
  listLocalSummaries,
  listResearchSyncConflicts,
  localBriefMarkdown,
  localCampaignByName,
  pendingResearchSyncCount,
  pendingResearchSyncEvents,
  researchSyncConflictCount,
  recordLocalWorkerHeartbeat,
  registerLocalWorker,
  getResearchSiteId,
  researchDbPath,
  stopLocalSession,
  upsertWorkerLaunch,
  upsertLocalSummary,
} from "../lib/research-db"
import { assertSetupCommitted } from "../lib/setup-git"
import { flushOutbox } from "../lib/sync"
import { protectedToolPaths } from "../lib/tools"
import { formatAge } from "../lib/tui"
import {
  buildWorkerInvocation,
  preflightWorkerInvocation,
  readWorkerLaunchManifests,
  workerEnvironment,
  workerGitWritableRoots,
  workerLaunchPaths,
  writeWorkerOnyxShim,
  writeWorkerLaunchManifest,
  type WorkerFinalizationManifest,
  type WorkerFinalizationStatus,
  type WorkerInvocation,
  type WorkerLaunchManifest,
  type WorkerOnyxShim,
} from "../lib/worker-launcher"
import { renderHypothesisWorkerPrompt } from "../lib/worker-prompt"

const MAX_WORKER_SHUTDOWN_CUSHION_MS = 90_000
const MIN_WORKER_SHUTDOWN_CUSHION_MS = 15_000
const MAX_WORKER_HARD_STOP_GRACE_MS = 30_000
const DEFAULT_FIRST_ATTEMPT_WARNING_MS = 180_000
const MAX_LOCAL_SUPERVISOR_WORKERS = 100

function positiveIntegerOption(args: Args, name: string, fallback: number) {
  const raw = args.options[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return value
}

function optionalPositiveIntegerOption(args: Args, name: string) {
  const raw = args.options[name]
  if (raw === undefined) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return value
}

function positiveNumberOption(args: Args, name: string, fallback: number) {
  const raw = args.options[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`)
  }
  return value
}

function nonnegativeNumberOption(args: Args, name: string, fallback: number) {
  const raw = args.options[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a nonnegative number`)
  }
  return value
}

function workerShutdownCushionMs(budgetMs: number) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return 0
  return Math.min(
    MAX_WORKER_SHUTDOWN_CUSHION_MS,
    Math.max(MIN_WORKER_SHUTDOWN_CUSHION_MS, Math.floor(budgetMs * 0.15)),
    Math.floor(budgetMs / 2)
  )
}

function workerHardStopGraceMs(shutdownCushionMs: number) {
  if (!Number.isFinite(shutdownCushionMs) || shutdownCushionMs <= 0) return 0
  return Math.min(
    MAX_WORKER_HARD_STOP_GRACE_MS,
    Math.floor(shutdownCushionMs / 2)
  )
}

async function hypothesisPlansOption(args: Args) {
  const json = args.options["hypotheses"]
  if (!json) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(
      `--hypotheses must be an inline JSON array, for example --hypotheses '[{"focus":"...","statement":"..."}]'. ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--hypotheses must be an inline JSON array")
  }
  return parsed.map((plan) => researchHypothesisPlanSchema.parse(plan))
}

const INLINE_HYPOTHESIS_PLAN_OPTIONS = [
  "focus",
  "hypothesis",
  "starting-point",
  "avoid",
  "success",
  "give-up",
]

function hasInlineHypothesisPlanOptions(args: Args) {
  return INLINE_HYPOTHESIS_PLAN_OPTIONS.some((option) => args.options[option])
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function setupAwareHypothesisDefaults({
  setup,
  projectPath,
}: {
  setup: ResearchSetupFile | null
  projectPath: string
}) {
  const metricName = setup?.metric.name ?? "target_metric"
  const direction =
    setup?.metric.direction === "maximize"
      ? "increase"
      : setup?.metric.direction === "minimize"
        ? "decrease"
        : "improve"
  const scope = setup?.scope.editable.length
    ? setup.scope.editable
    : [setup?.projectPath || projectPath || "."]
  const protectedPaths = setup?.scope.protected.length
    ? setup.scope.protected
    : ["onyx/setup.json", "onyx/validation.json", "onyx/onyx.md", "onyx/tools/"]
  return {
    metricName,
    direction,
    scope,
    protectedPaths,
    startingPoints: uniqueStrings([
      "Review recent experiments, hypothesis summaries, and shared knowledge before editing.",
      ...scope,
    ]),
    successSignals: [
      `METRIC ${metricName} moves in the desired direction.`,
      "Required setup validation and runtime checks remain passing.",
    ],
    giveUpSignals: [
      "The hypothesis requires edits outside the declared scope.",
      `Repeated measured attempts fail to ${direction} ${metricName}.`,
    ],
  }
}

async function hypothesisPlanOption(
  args: Args,
  context?: {
    setup: ResearchSetupFile | null
    projectPath: string
  }
): Promise<ResearchHypothesisPlan> {
  const planPath = args.options.plan
  const hasInline = hasInlineHypothesisPlanOptions(args)
  if (planPath && hasInline) {
    throw new Error(
      "Use either --plan <json-file> or inline plan flags, not both."
    )
  }
  if (planPath) {
    const parsed: unknown = JSON.parse(await readFile(planPath, "utf8"))
    if (Array.isArray(parsed)) {
      throw new Error(
        "--plan must point to one hypothesis-plan JSON object, not an array."
      )
    }
    return researchHypothesisPlanSchema.parse(parsed)
  }
  const focus = args.options.focus
  const hypothesis = args.options.hypothesis
  if (!focus || !hypothesis) {
    throw new Error(
      "Pass --plan <json-file>, or pass --focus <text> and --hypothesis <text>."
    )
  }
  const defaults = setupAwareHypothesisDefaults({
    setup: context?.setup ?? null,
    projectPath: context?.projectPath ?? "",
  })
  const startingPoints = optionValues(args, "starting-point")
  const avoidList = optionValues(args, "avoid")
  const successSignals = optionValues(args, "success")
  const giveUpSignals = optionValues(args, "give-up")
  return researchHypothesisPlanSchema.parse({
    focus,
    statement: hypothesis,
    startingPoints:
      startingPoints.length > 0 ? startingPoints : defaults.startingPoints,
    avoidList: uniqueStrings([...avoidList, ...defaults.protectedPaths]),
    successSignals:
      successSignals.length > 0 ? successSignals : defaults.successSignals,
    giveUpSignals:
      giveUpSignals.length > 0 ? giveUpSignals : defaults.giveUpSignals,
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeFileSegment(value: string) {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  )
}

function workerBudgetOptions({
  maxIterations,
  maxMinutes,
}: {
  maxIterations: number
  maxMinutes: number
}) {
  return ` --max-iterations ${maxIterations} --max-minutes ${maxMinutes}`
}

function workerAgentOption(args: Args) {
  const agentKind = args.options.agent ?? "codex"
  if (agentKind !== "codex" && agentKind !== "claude") {
    throw new Error("--agent must be codex or claude")
  }
  return agentKind
}

async function createWorkerTempDir({
  root,
  sessionId,
  workerId,
}: {
  root: string
  sessionId: string
  workerId: string
}) {
  const dir = join(
    await onyxStateDir(root),
    "worker-tmp",
    safeFileSegment(sessionId),
    safeFileSegment(workerId)
  )
  await mkdir(dir, { recursive: true })
  return dir
}

function jsonTextFragments(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const fragments: string[] = []
  for (const key of ["result", "text", "delta"]) {
    if (typeof record[key] === "string") fragments.push(record[key] as string)
  }
  const content = record.content
  if (Array.isArray(content)) {
    for (const item of content) fragments.push(...jsonTextFragments(item))
  }
  const message = record.message
  if (message && typeof message === "object") {
    fragments.push(...jsonTextFragments(message))
  }
  return fragments
}

export function summarizeWorkerOutput(result: StreamingProcessResult) {
  const finalFragments: string[] = []
  const jsonFragments: string[] = []
  const plainLines: string[] = []
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const resultText =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).result
          : null
      if (typeof resultText === "string") {
        finalFragments.push(resultText)
        continue
      }
      const fragments = jsonTextFragments(parsed)
      if (fragments.length > 0) jsonFragments.push(...fragments)
    } catch {
      plainLines.push(trimmed)
    }
  }

  const parsed = (finalFragments.length > 0 ? finalFragments : jsonFragments)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .join("\n")
    .trim()
  if (parsed) return parsed.slice(-4000)

  const plain = plainLines.join("\n").trim()
  if (plain) return plain.slice(-4000)

  const raw = result.stdout.trim()
  return raw ? raw.slice(-1200) : null
}

const SUMMARY_KINDS = [
  "campaign_brief",
  "session_brief",
  "hypothesis_summary",
  "transfer_brief",
  "setup_notes",
] as const

type SummaryKind = ApiSummary["summaryKind"]

type ResearchLaunchSuggestion =
  | {
      kind: "launch_worker"
      command: string
      sessionId: string
      hypothesisId: string
      hypothesisName: string
      reason: string
    }
  | {
      kind: "add_hypothesis"
      command: string
      sessionId: string
      reason: string
    }

function summaryKindOption(args: Args, fallback: SummaryKind): SummaryKind {
  const kind = args.options.kind ?? fallback
  if (!SUMMARY_KINDS.includes(kind as SummaryKind)) {
    const hint =
      kind === "hypothesis" ? " Did you mean hypothesis_summary?" : ""
    throw new Error(
      `--kind must be campaign_brief, session_brief, hypothesis_summary, transfer_brief, or setup_notes.${hint}`
    )
  }
  return kind as SummaryKind
}

function workerIsActive(worker: Pick<ApiWorker, "status">) {
  return ["idle", "running", "stale"].includes(worker.status)
}

function workerIsCompleted(worker: Pick<ApiWorker, "status">) {
  return worker.status === "completed"
}

function terminalStatusFromManifest(
  manifest: WorkerLaunchManifest
): ApiWorker["status"] | null {
  if (manifest.status === "completed") return "completed"
  if (manifest.status === "failed") return "failed"
  if (manifest.status === "stopped") return "stopped"
  return null
}

async function reconcileTerminalWorkerManifests({
  root,
  sessionId,
  workers,
  manifests,
}: {
  root: string
  sessionId: string
  workers: ApiWorker[]
  manifests: WorkerLaunchManifest[]
}) {
  const workersById = new Map(workers.map((worker) => [worker.id, worker]))
  let repaired = 0
  for (const manifest of manifests) {
    const status = terminalStatusFromManifest(manifest)
    if (!status) continue
    const worker = workersById.get(manifest.workerId)
    if (!worker || worker.sessionId !== sessionId || !workerIsActive(worker)) {
      continue
    }
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status,
      sessionId,
      hypothesisId: worker.hypothesisId,
      phase: status,
      event: "manifest_reconciled",
      progressMessage: `Worker manifest shows ${status}`,
      gitLabel:
        manifest.finalization?.commitSha ??
        manifest.finalization?.measurementBaseCommitSha ??
        worker.gitLabel,
      metadata: {
        manifestPath: manifest.manifestPath,
        reconciledFrom: "worker-manifest",
      },
    })
    repaired += 1
  }
  return repaired
}

function launchSuggestionsForSession({
  sessionId,
  sessionStatus,
  openSlots,
  stopping,
  hypotheses,
  workers,
}: {
  sessionId: string | null
  sessionStatus: string | null
  openSlots: number | null
  stopping: boolean
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
}): ResearchLaunchSuggestion[] {
  if (
    !sessionId ||
    sessionStatus !== "running" ||
    openSlots === null ||
    openSlots <= 0 ||
    stopping
  ) {
    return []
  }

  const activeHypotheses = hypotheses.filter(
    (hypothesis) => hypothesis.status === "active"
  )
  const launchable = activeHypotheses.filter((hypothesis) => {
    const relatedWorkers = workers.filter(
      (worker) => worker.hypothesisId === hypothesis.id
    )
    return (
      !hypothesis.lastWorkedAt &&
      !relatedWorkers.some(workerIsActive) &&
      !relatedWorkers.some(workerIsCompleted)
    )
  })

  if (launchable.length > 0) {
    return launchable.slice(0, openSlots).map((hypothesis) => ({
      kind: "launch_worker" as const,
      command: `onyx worker run --session ${sessionId} --hypothesis ${hypothesis.id}`,
      sessionId,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      reason: "active hypothesis has not been worked and has no active worker",
    }))
  }

  const allExistingWorked =
    activeHypotheses.length > 0 &&
    activeHypotheses.every((hypothesis) => {
      const relatedWorkers = workers.filter(
        (worker) => worker.hypothesisId === hypothesis.id
      )
      return Boolean(hypothesis.lastWorkedAt) || relatedWorkers.length > 0
    })

  if (activeHypotheses.length === 0 || allExistingWorked) {
    return [
      {
        kind: "add_hypothesis" as const,
        command:
          "onyx research hypothesis add --campaign <name> --focus <focus> --hypothesis <statement>",
        sessionId,
        reason:
          activeHypotheses.length === 0
            ? "no active hypotheses are available for open worker slots"
            : "open worker slots remain, but existing active hypotheses have already been worked",
      },
    ]
  }

  return []
}

function chooseSupervisorHypothesis({
  hypotheses,
  workers,
  reservations = [],
}: {
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
  reservations?: LaunchReservation[]
}) {
  const activeHypotheses = hypotheses.filter(
    (hypothesis) => hypothesis.status === "active"
  )
  if (activeHypotheses.length === 0) return null

  const activeWorkers = workers.filter(workerIsActive)
  const completedWorkers = workers.filter(workerIsCompleted)
  const reservedCountFor = (hypothesisId: string) =>
    reservations.filter(
      (reservation) => reservation.hypothesisId === hypothesisId
    ).length
  const activeCountFor = (hypothesisId: string) =>
    activeWorkers.filter((worker) => worker.hypothesisId === hypothesisId)
      .length + reservedCountFor(hypothesisId)
  const neverWorked = activeHypotheses.find((hypothesis) => {
    const relatedActive = activeWorkers.some(
      (worker) => worker.hypothesisId === hypothesis.id
    )
    const relatedCompleted = completedWorkers.some(
      (worker) => worker.hypothesisId === hypothesis.id
    )
    const relatedReserved = reservations.some(
      (reservation) => reservation.hypothesisId === hypothesis.id
    )
    return (
      !hypothesis.lastWorkedAt &&
      !relatedActive &&
      !relatedCompleted &&
      !relatedReserved
    )
  })
  if (neverWorked) return neverWorked

  return activeHypotheses
    .slice()
    .sort((left, right) => {
      const leftActive = activeCountFor(left.id)
      const rightActive = activeCountFor(right.id)
      if (leftActive !== rightActive) return leftActive - rightActive
      const leftWorked = left.lastWorkedAt ? Date.parse(left.lastWorkedAt) : 0
      const rightWorked = right.lastWorkedAt
        ? Date.parse(right.lastWorkedAt)
        : 0
      return leftWorked - rightWorked
    })[0]
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function optionalUuid(value: string | undefined, label: string) {
  if (value === undefined) return undefined
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID, not "${value}".`)
  }
  return value
}

function createSyncSupervisor({
  root,
  args,
  intervalMs,
}: {
  root: string
  args: Args
  intervalMs: number
}) {
  let running: Promise<void> | null = null
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const run = () => {
    if (running) return running
    running = flushOutbox(root, args, { quiet: true })
      .then(() => undefined)
      .catch((error) => {
        console.warn(
          `Background sync skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
      .finally(() => {
        running = null
      })
    return running
  }

  timer = setInterval(() => {
    if (!stopped) void run()
  }, intervalMs)

  return {
    request() {
      if (!stopped) void run()
    },
    async drain(timeoutMs: number) {
      stopped = true
      if (timer) clearInterval(timer)
      const deadline = Date.now() + timeoutMs
      do {
        await run()
        const pending = await pendingResearchSyncCount(root)
        if (pending === 0) return 0
        await sleep(Math.min(1000, Math.max(0, deadline - Date.now())))
      } while (Date.now() < deadline)
      return pendingResearchSyncCount(root)
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}

function createPresenceSupervisor({
  root,
  args,
  sessionId,
  projectPath,
  intervalMs,
}: {
  root: string
  args: Args
  sessionId: string
  projectPath: string
  intervalMs: number
}) {
  const lastSent = new Map<string, string>()
  let running: Promise<void> | null = null
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const snapshot = async () => {
    if (args.options.offline === "true") return
    const state = await getLocalSessionState(root, sessionId)
    const manifests = await readWorkerLaunchManifests(root, sessionId)
    const manifestByWorker = new Map(
      manifests.map((manifest) => [manifest.workerId, manifest])
    )
    const observedAt = new Date().toISOString()
    const workers = state.workers
      .filter((worker) => worker.sessionId === sessionId)
      .map((worker) => {
        const manifest = manifestByWorker.get(worker.id)
        const metadata = manifest
          ? {
              workerLogPath: manifest.logPath,
              workerActivityLogPath: manifest.activityLogPath,
              workerPromptPath: manifest.promptPath,
              manifestPath: manifest.manifestPath,
              finalizationStatus:
                manifest.finalization?.finalizationStatus ?? null,
            }
          : {}
        return {
          id: worker.id,
          status: worker.status,
          phase: worker.phase,
          progressMessage: worker.progressMessage,
          gitLabel: worker.gitLabel,
          lastOutputAt: manifest?.lastOutputAt ?? null,
          metadata,
          observedAt,
        }
      })
      .filter((worker) => {
        const signature = JSON.stringify({ ...worker, observedAt: undefined })
        const active = ["idle", "running", "stale"].includes(worker.status)
        const changed = lastSent.get(worker.id) !== signature
        if (active || changed) {
          lastSent.set(worker.id, signature)
          return true
        }
        return false
      })
    if (workers.length === 0) return
    await syncResearchPresence(
      {
        siteId: await getResearchSiteId(root),
        repositoryUrl: await repositoryUrl(root, args.options["repository-url"]),
        projectPath,
        sessionId,
        workers,
      },
      args
    )
  }

  const run = () => {
    if (running) return running
    running = snapshot()
      .catch((error) => {
        if (!stopped) {
          console.warn(
            `Presence sync skipped: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      })
      .finally(() => {
        running = null
      })
    return running
  }

  timer = setInterval(() => {
    if (!stopped) void run()
  }, intervalMs)

  return {
    request() {
      if (!stopped) void run()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      await run().catch(() => {})
    },
  }
}

async function drainFinalSync({
  root,
  args,
  timeoutMs,
}: {
  root: string
  args: Args
  timeoutMs: number
}) {
  const deadline = Date.now() + timeoutMs
  let accepted = 0
  let offline = false
  do {
    const result = await flushOutbox(root, args, { quiet: true })
    accepted += result.flushed
    offline = offline || result.offline
    if (result.pending === 0 || result.offline) break
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)

  const [pending, conflicts] = await Promise.all([
    pendingResearchSyncCount(root).catch(() => 0),
    researchSyncConflictCount(root).catch(() => 0),
  ])
  const [firstConflict] = await listResearchSyncConflicts(root).catch(() => [])
  const [firstPendingError] = (
    await pendingResearchSyncEvents(root, 20).catch(() => [])
  ).filter((event) => event.lastError)
  return {
    accepted,
    pending,
    conflicts,
    offline,
    firstFailed: firstConflict ?? firstPendingError ?? null,
  }
}

function printFinalSyncReport(
  report: Awaited<ReturnType<typeof drainFinalSync>>
) {
  console.log(
    `final sync: accepted=${report.accepted} pending=${report.pending} conflicts=${report.conflicts}${
      report.offline ? " offline=true" : ""
    }`
  )
  if (report.firstFailed) {
    console.warn(
      `first failed sync event: ${report.firstFailed.type}/${report.firstFailed.entityType}/${report.firstFailed.entityId}: ${
        report.firstFailed.lastError ?? "sync conflict"
      }`
    )
  }
}

async function campaignForName(
  root: string,
  args: Args,
  options: { persistState?: boolean } = {}
) {
  const persistState = options.persistState ?? true
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const campaignName =
    args.options.campaign ??
    state.activeCampaign ??
    (await getActiveLocalCampaignName(root)) ??
    args.options.name
  if (!campaignName) {
    throw new Error(
      "Pass --campaign <name> or run `onyx campaign use --name <name>`."
    )
  }

  const key = campaignStateKey(projectPath, campaignName)
  const localCampaign = await localCampaignByName({
    root,
    projectPath,
    name: campaignName,
  })
  if (localCampaign) {
    if (persistState) {
      state.projectPath = projectPath
      state.activeCampaign = localCampaign.name
      state.campaigns = state.campaigns ?? {}
      state.campaigns[key] = {
        ...state.campaigns[key],
        campaignId: localCampaign.id,
        projectPath,
        baseCommitSha: localCampaign.baseCommitSha,
        description: localCampaign.description,
        metricName: localCampaign.metricName,
        metricUnit: localCampaign.metricUnit,
        metricDirection: localCampaign.metricDirection,
        promotionRefName: localCampaign.promotionRefName,
      }
      await writeState(root, state)
    }
    return {
      projectPath,
      campaign: localCampaign,
      overview: {
        campaign: localCampaign,
        summaries: await listLocalSummaries(root, localCampaign.id),
        knowledge: await listLocalKnowledge(root, localCampaign.id),
        latestExperiments: [],
        workers: [],
        hypotheses: [],
      },
    }
  }

  const cached = state.campaigns?.[key]
  if (cached?.campaignId) {
    try {
      const overview = await getCampaignOverview(cached.campaignId, args)
      const campaign = overview.campaign
      if (persistState) {
        state.projectPath = projectPath
        state.activeCampaign = campaign.name
        state.campaigns = state.campaigns ?? {}
        state.campaigns[key] = {
          ...state.campaigns[key],
          campaignId: campaign.id,
          projectPath,
          baseCommitSha: campaign.baseCommitSha,
          description: campaign.description,
          metricName: campaign.metricName,
          metricUnit: campaign.metricUnit,
          metricDirection: campaign.metricDirection,
          promotionRefName: campaign.promotionRefName,
        }
        await writeState(root, state)
        await cacheLocalCampaign({
          root,
          campaign,
          projectPath,
          setup: state.campaigns[key]?.setup ?? {},
        }).catch(() => null)
      }
      return { projectPath, campaign, overview }
    } catch {
      // Fall back to repository/project resolution; the cached campaign may
      // have been deleted or the local state may point at another API target.
    }
  }

  let projectId: string
  try {
    const project = await resolveProject(root, args)
    projectId = project.id
  } catch (error) {
    if (!state.projectId) throw error
    projectId = state.projectId
  }
  const campaigns = await listProjectCampaigns(projectId, args)
  const campaign = campaigns.find(
    (candidate) => candidate.name === campaignName
  )
  if (!campaign) {
    throw new Error(`Campaign ${campaignName} was not found.`)
  }

  const overview = await getCampaignOverview(campaign.id, args)
  if (persistState) {
    state.projectId = projectId
    state.projectPath = projectPath
    state.activeCampaign = campaign.name
    state.campaigns = state.campaigns ?? {}
    state.campaigns[key] = {
      ...state.campaigns[key],
      campaignId: campaign.id,
      projectPath,
      baseCommitSha: campaign.baseCommitSha,
      description: campaign.description,
      metricName: campaign.metricName,
      metricUnit: campaign.metricUnit,
      metricDirection: campaign.metricDirection,
      promotionRefName: campaign.promotionRefName,
    }
    await writeState(root, state)
    await cacheLocalCampaign({
      root,
      campaign: overview.campaign,
      projectPath,
      setup: state.campaigns[key]?.setup ?? {},
    }).catch(() => null)
  }

  return { projectPath, campaign: overview.campaign, overview }
}

async function assertLocalSetupReady(root: string, projectPath: string) {
  const setup = await readSetupFile(root, projectPath)
  const cheapFailures = await recheckCheapSetupReadiness({
    root,
    projectPath,
    setup,
  })
  if (cheapFailures.length > 0) {
    throw new Error(
      `Setup preflight failed: ${cheapFailures.join("; ")}. Run \`onyx setup validate\`.`
    )
  }

  const validation = await readValidationFile(root, projectPath)
  if (!validation) {
    throw new Error(
      `Missing ${onyxPath(root, projectPath, "validation.json")}. Run \`onyx setup validate\` before starting research.`
    )
  }
  if (!validationMatchesSetup({ setup, validation })) {
    throw new Error(
      `${onyxPath(root, projectPath, "validation.json")} is stale for the current setup. Run \`onyx setup validate\`, review any blocking checks, then commit the setup surface.`
    )
  }
  const failing = validation.checks.filter((check) => check.status === "failed")
  if (failing.length > 0) {
    throw new Error(
      [
        "Setup validation has blocking failure(s):",
        ...failing.map((check) => `- ${check.id}: ${check.message}`),
        "Run `onyx setup validate`, fix the listed setup files/tools, and commit the setup surface before `onyx research start`.",
      ].join("\n")
    )
  }
  return { setup, validation }
}

async function recheckCheapSetupReadiness({
  root,
  projectPath,
  setup,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
}) {
  const failures: string[] = []

  if (setup.projectPath !== projectPath) {
    failures.push(
      `expected projectPath "${projectPath}" but setup has "${setup.projectPath}"`
    )
  }

  const metricSteps = setup.workflow.filter((step) => step.metric)
  if (metricSteps.length !== 1) {
    failures.push("workflow must have exactly one metric step")
  }

  const instructionsPath = onyxPath(root, projectPath, "onyx.md")
  if (!(await pathExists(instructionsPath))) {
    failures.push("missing onyx/onyx.md")
  } else {
    const instructions = await readFile(instructionsPath, "utf8")
    if (instructions.trim().length < 40) {
      failures.push("onyx/onyx.md has too little guidance")
    }
  }

  return failures
}

async function writeBrief({
  root,
  campaignId,
  sessionId,
  hypothesis,
  workerId,
  args,
}: {
  root: string
  campaignId: string
  sessionId: string
  hypothesis: ApiHypothesis
  workerId?: string
  args: Args
}) {
  const markdown =
    (await localBriefMarkdown({
      root,
      campaignId,
      sessionId,
      hypothesisId: hypothesis.id,
    }).catch(() => null)) ??
    (await getCampaignBrief(campaignId, args).then((brief) => brief.markdown))
  const dir = join(await onyxStateDir(root), "briefs", sessionId)
  await mkdir(dir, { recursive: true })
  const suffix = workerId
    ? `${safeFileSegment(workerId).slice(0, 12)}`
    : safeFileSegment(hypothesis.id).slice(0, 12)
  const path = join(dir, `${safeFileSegment(hypothesis.name)}-${suffix}.md`)
  await writeFile(path, `${markdown}\n`, "utf8")
  return path
}

async function writeSessionState({
  root,
  sessionId,
  hypothesis,
  args,
}: {
  root: string
  sessionId: string
  hypothesis: ApiHypothesis
  args: Args
}) {
  const dir = join(await onyxStateDir(root), "session-state", sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${hypothesis.id}.json`)
  const state = await getLocalSessionState(root, sessionId).catch(() =>
    getResearchSessionState(sessionId, args)
  )
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  return path
}

async function refreshSessionStateFiles({
  root,
  sessionId,
  args,
}: {
  root: string
  sessionId: string
  args: Args
}) {
  const state = await getLocalSessionState(root, sessionId).catch(() =>
    getResearchSessionState(sessionId, args)
  )
  const dir = join(await onyxStateDir(root), "session-state", sessionId)
  await mkdir(dir, { recursive: true })
  await Promise.all(
    state.hypotheses.map((hypothesis) =>
      writeFile(
        join(dir, `${hypothesis.id}.json`),
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8"
      )
    )
  )
}

async function ensureWorktree({
  root,
  hypothesis,
  sessionId,
  workerId,
}: {
  root: string
  hypothesis: ApiHypothesis
  sessionId: string
  workerId: string
}) {
  const branch = workerBranchName({ sessionId, workerId })
  const dir = join(
    await onyxStateDir(root),
    "worktrees",
    sessionId,
    workerId
  )
  if (!(await pathExists(dir))) {
    await withOnyxLock(root, "git-worktree", async () => {
      if (await pathExists(dir)) return
      await mkdir(join(await onyxStateDir(root), "worktrees", sessionId), {
        recursive: true,
      })
      await git(
        ["worktree", "add", "-B", branch, dir, hypothesis.baseCommitSha],
        root
      )
    })
  }
  return { dir, branch }
}

function workerBranchName({
  sessionId,
  workerId,
}: {
  sessionId: string
  workerId: string
}) {
  return ["onyx", safeBranchSegment(sessionId), safeBranchSegment(workerId)].join(
    "/"
  )
}

async function commitIfNeeded(worktree: string, hypothesis: ApiHypothesis) {
  const status = await git(["status", "--porcelain"], worktree)
  if (!status.trim()) {
    return { commitSha: await currentCommit(worktree), changed: false }
  }
  await git(["add", "-A"], worktree)
  await git(
    ["commit", "-m", `onyx: ${hypothesis.name} research attempt`],
    worktree
  )
  return { commitSha: await currentCommit(worktree), changed: true }
}

async function localExperimentCommitSetFor({
  root,
  campaignName,
  hypothesisId,
}: {
  root: string
  campaignName: string
  hypothesisId: string
}) {
  const [experiments, attempts] = await Promise.all([
    listLocalExperimentHistory(root).catch(() => []),
    listLocalAttempts(root).catch(() => []),
  ])
  const commits = new Set<string>()
  for (const record of [...experiments, ...attempts]) {
    if (
      record.campaignName === campaignName &&
      record.hypothesisId === hypothesisId &&
      record.resultCommitSha
    ) {
      commits.add(record.resultCommitSha)
    }
  }
  return commits
}

async function hasWorkerLoggedAttempt({
  root,
  workerId,
}: {
  root: string
  workerId: string
}) {
  const [experiments, attempts] = await Promise.all([
    listLocalExperimentHistory(root).catch(() => []),
    listLocalAttempts(root).catch(() => []),
  ])
  return [...experiments, ...attempts].some(
    (record) => record.workerId === workerId
  )
}

type FinalizationCommitAnalysis =
  | {
      kind: "already_logged"
      unloggedCommits: string[]
      measurementBaseCommitSha: null
      reason: null
    }
  | {
      kind: "single_unlogged_head"
      unloggedCommits: string[]
      measurementBaseCommitSha: string
      reason: null
    }
  | {
      kind: "salvage_only"
      unloggedCommits: string[]
      measurementBaseCommitSha: null
      reason: string
    }

async function analyzeFinalizationCommits({
  worktree,
  baseCommitSha,
  headCommitSha,
  loggedCommits,
}: {
  worktree: string
  baseCommitSha: string
  headCommitSha: string
  loggedCommits: Set<string>
}): Promise<FinalizationCommitAnalysis> {
  if (loggedCommits.has(headCommitSha)) {
    return {
      kind: "already_logged",
      unloggedCommits: [],
      measurementBaseCommitSha: null,
      reason: null,
    }
  }

  let commits: string[]
  try {
    commits = (await git(["rev-list", "--reverse", `${baseCommitSha}..${headCommitSha}`], worktree))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    return {
      kind: "salvage_only",
      unloggedCommits: [headCommitSha],
      measurementBaseCommitSha: null,
      reason: `Unable to inspect commits between hypothesis base and worker HEAD: ${errorMessage(error)}`,
    }
  }

  const unloggedCommits = commits.filter((commit) => !loggedCommits.has(commit))
  if (
    unloggedCommits.length === 1 &&
    unloggedCommits[0] === headCommitSha
  ) {
    const parentLine = await git(["rev-list", "--parents", "-n", "1", headCommitSha], worktree)
    const [, parentCommitSha] = parentLine.trim().split(/\s+/)
    if (!parentCommitSha) {
      return {
        kind: "salvage_only",
        unloggedCommits,
        measurementBaseCommitSha: null,
        reason: "Unable to find a parent commit for the unlogged worker HEAD.",
      }
    }
    return {
      kind: "single_unlogged_head",
      unloggedCommits,
      measurementBaseCommitSha: parentCommitSha,
      reason: null,
    }
  }

  return {
    kind: "salvage_only",
    unloggedCommits,
    measurementBaseCommitSha: null,
    reason:
      unloggedCommits.length === 0
        ? "Worker HEAD was not locally logged, but no unlogged commit range could be measured safely."
        : `Worker HEAD contains ${unloggedCommits.length} unlogged commits; finalization only measures exactly one unlogged HEAD commit.`,
  }
}

async function withoutProcessExitCode<T>(fn: () => Promise<T>) {
  const previous = process.exitCode
  process.exitCode = undefined
  try {
    return await fn()
  } finally {
    process.exitCode = previous
  }
}

export async function finalizeHypothesisAttempt({
  root,
  worktree,
  campaign,
  hypothesis,
  sessionId,
  workerId,
  workerBranch,
  args,
  workerFailed,
}: {
  root: string
  worktree: string
  campaign: ApiCampaign
  hypothesis: ApiHypothesis
  sessionId: string
  workerId: string
  workerBranch: string
  args: Args
  workerFailed: boolean
}): Promise<WorkerFinalizationManifest> {
  const manifest: WorkerFinalizationManifest = {
    attempted: false,
    salvaged: workerFailed,
    finalizationStatus: "none",
    commitSha: null,
    measurementBaseCommitSha: null,
    unloggedCommitCount: 0,
    workerBranchPushStatus: "not_attempted",
    rootDriftStatus: "not_checked",
    error: null,
  }

  try {
    const headBefore = await currentCommit(worktree)
    const dirty = (await git(["status", "--porcelain"], worktree)).trim()
    const hasResult =
      (Boolean(dirty) && dirty.length > 0) ||
      headBefore !== hypothesis.baseCommitSha
    if (!hasResult) {
      const rootStatus = await mainWorktreeStatus(root)
      manifest.rootDriftStatus = rootStatus ? "dirty" : "clean"
      if (rootStatus) {
        manifest.error = `main checkout changed during worker run:\n${rootStatus}`
      }
      return manifest
    }

    manifest.attempted = true
    const commit = await commitIfNeeded(worktree, hypothesis)
    manifest.commitSha = commit.commitSha

    const loggedCommits = await localExperimentCommitSetFor({
      root,
      campaignName: campaign.name,
      hypothesisId: hypothesis.id,
    })
    const analysis = await analyzeFinalizationCommits({
      worktree,
      baseCommitSha: hypothesis.baseCommitSha,
      headCommitSha: commit.commitSha,
      loggedCommits,
    })
    manifest.unloggedCommitCount = analysis.unloggedCommits.length
    manifest.measurementBaseCommitSha = analysis.measurementBaseCommitSha

    if (analysis.kind === "already_logged") {
      manifest.finalizationStatus = "already_logged"
    } else if (analysis.kind === "salvage_only") {
      manifest.finalizationStatus = "salvaged_unmeasured"
      manifest.salvaged = true
      manifest.error = analysis.reason
    } else {
      const measurementBaseCommitSha = analysis.measurementBaseCommitSha
      let measurementError: string | null = null
      let measuredRunRef: string | null = null
      await withoutProcessExitCode(() =>
        commandExpRun({
          positional: ["exp", "run"],
          options: {
            ...args.options,
            cwd: worktree,
            campaign: campaign.name,
            base: measurementBaseCommitSha,
            hypothesis: hypothesis.id,
            session: sessionId,
            worker: workerId,
            timeout: "120",
            "checks-timeout": "120",
          },
        })
      )
        .then((result) => {
          measuredRunRef = result?.runRef ?? null
        })
        .catch((error) => {
          measurementError = errorMessage(error)
          manifest.error = measurementError
        })
      await withoutProcessExitCode(() =>
        commandExpLog({
          positional: ["exp", "log"],
          options: {
            ...args.options,
            cwd: worktree,
            campaign: campaign.name,
            base: measurementBaseCommitSha,
            hypothesis: hypothesis.id,
            session: sessionId,
            worker: workerId,
            ...(measuredRunRef ? { "run-ref": measuredRunRef } : {}),
            ...(measurementError
              ? { status: "failed", "allow-unmeasured": "true" }
              : {}),
            name: `${hypothesis.name}-final-${commit.commitSha.slice(0, 7)}`,
            description: workerFailed
              ? `Best-effort salvage from ${hypothesis.name} after worker process failure.`
              : `Final ${hypothesis.name} worker result.`,
            "agent-notes": JSON.stringify({
              finalizedBy: "onyx worker harness",
              workerFailed,
              measurementError,
              hypothesis: hypothesis.name,
              measurementBaseCommitSha,
              unloggedCommitCount: analysis.unloggedCommits.length,
            }),
          },
        })
      )
        .then(() => {
          manifest.finalizationStatus = "measured_and_logged"
        })
        .catch((error) => {
          manifest.finalizationStatus = "failed"
          manifest.error = [
            manifest.error,
            `experiment log failed: ${errorMessage(error)}`,
          ]
            .filter(Boolean)
            .join("; ")
        })
    }

    const workerBranchPush = await gitResult(
      ["push", "origin", `HEAD:refs/heads/${workerBranch}`],
      worktree
    )
    if (workerBranchPush.code === 0 && !workerBranchPush.timedOut) {
      manifest.workerBranchPushStatus = "pushed"
    } else {
      manifest.workerBranchPushStatus = "failed"
      manifest.error =
        workerBranchPush.stderr.trim() ||
        workerBranchPush.stdout.trim() ||
        "worker branch push failed"
    }

    const rootStatus = await mainWorktreeStatus(root)
    manifest.rootDriftStatus = rootStatus ? "dirty" : "clean"
    if (rootStatus) {
      manifest.error = [
        manifest.error,
        `main checkout changed during worker run:\n${rootStatus}`,
      ]
        .filter(Boolean)
        .join("; ")
    }

    return manifest
  } catch (error) {
    manifest.finalizationStatus = "failed"
    manifest.error = errorMessage(error)
    return manifest
  }
}

async function writeWorkerPrompt({
  root,
  worktree,
  projectPath,
  campaign,
  setup,
  sessionId,
  hypothesis,
  workerId,
  workerBranch,
  briefPath,
  sessionStatePath,
  maxIterations,
  endTimeMs,
}: {
  root: string
  worktree: string
  projectPath: string
  campaign: ApiCampaign
  setup: ResearchSetupFile
  sessionId: string
  hypothesis: ApiHypothesis
  workerId: string
  workerBranch: string
  briefPath: string
  sessionStatePath: string | null
  maxIterations: number
  endTimeMs: number
}) {
  const dir = join(await onyxStateDir(root), "worker-prompts", sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(
    dir,
    `${safeFileSegment(hypothesis.name)}-${safeFileSegment(workerId).slice(0, 12)}.md`
  )
  const protectedPaths = await protectedToolPaths(root, projectPath)
  const nowMs = Date.now()
  const budgetRemainingMs = Math.max(0, endTimeMs - nowMs)
  const shutdownCushionMs = workerShutdownCushionMs(budgetRemainingMs)
  const researchDeadlineMs = Math.max(nowMs, endTimeMs - shutdownCushionMs)
  const shutdownDeadlineMs = Math.max(nowMs, endTimeMs)
  const minutesRemaining = Math.max(0, Math.ceil(budgetRemainingMs / 60_000))
  const markdown = renderHypothesisWorkerPrompt({
    briefPath,
    campaignName: campaign.name,
    goal: setup.goal ?? campaign.description ?? "not specified",
    hypothesisId: hypothesis.id,
    hypothesisName: hypothesis.name,
    hypothesisPlan: hypothesis.plan,
    maxIterations,
    metricLabel: `${campaign.metricName}${campaign.metricUnit ? ` (${campaign.metricUnit})` : ""}, ${campaign.metricDirection}`,
    minutesRemaining,
    protectedPaths,
    projectRoot: projectPath ? join(worktree, projectPath) : worktree,
    researchDeadlineIso: new Date(researchDeadlineMs).toISOString(),
    setupFilePath: setupPath(worktree, projectPath),
    shutdownCushionSeconds: Math.ceil(shutdownCushionMs / 1000),
    shutdownDeadlineIso: new Date(shutdownDeadlineMs).toISOString(),
    validationFilePath: validationPath(worktree, projectPath),
    researchSpecPath: onyxPath(worktree, projectPath, "onyx.md"),
    sessionId,
    sessionStatePath,
    worktreeRoot: worktree,
    workerBranch,
  })

  await writeFile(path, `${markdown}\n`, "utf8")
  return {
    path,
    markdown,
    researchDeadlineMs,
    shutdownDeadlineMs,
    shutdownCushionMs,
  }
}

function processFailure(
  result: ProcessResult | StreamingProcessResult,
  label: string
) {
  if (result.timedOut) return `${label} timed out`
  if (result.code === 0) return null
  return `${label} failed (${result.code ?? "signal"}): ${
    result.stderr.trim() || result.stdout.trim() || "no output"
  }`
}

async function harnessShouldStopSession({
  root,
  sessionId,
  args,
}: {
  root: string
  sessionId: string
  args: Args
}) {
  const state = await readState(root).catch(() => null)
  if (state?.sessions?.[sessionId]?.stopRequested) return true
  const localSessionState = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
  if (localSessionState && localSessionState.session.status !== "running") {
    return true
  }
  const remote = await getResearchSessionState(sessionId, args).catch(
    () => null
  )
  return Boolean(
    remote &&
    (remote.session.status === "stop_requested" ||
      remote.session.status === "stopped" ||
      remote.session.status === "completed" ||
      remote.session.status === "failed")
  )
}

async function withWorkerHeartbeat<T>({
  root,
  workerId,
  sessionId,
  hypothesisId,
  phase,
  progressMessage,
  metadata,
  quiet = false,
  consoleEveryMs = 30_000,
  run,
}: {
  root: string
  workerId: string
  sessionId: string
  hypothesisId: string
  phase: string
  progressMessage: string | (() => string)
  metadata?: () => Record<string, unknown>
  quiet?: boolean
  consoleEveryMs?: number
  run: () => Promise<T>
}): Promise<T> {
  let lastConsoleAt = 0
  const timer = setInterval(() => {
    const message =
      typeof progressMessage === "function"
        ? progressMessage()
        : progressMessage
    const heartbeat = {
      root,
      workerId,
      status: "running" as const,
      sessionId,
      hypothesisId,
      phase,
      event: "heartbeat",
      progressMessage: message,
      metadata: metadata?.(),
    }
    void recordLocalWorkerHeartbeat(heartbeat).catch(() => {})
    if (!quiet && Date.now() - lastConsoleAt >= consoleEveryMs) {
      lastConsoleAt = Date.now()
      console.log(`worker progress: ${message}`)
    }
  }, 10_000)

  try {
    return await run()
  } finally {
    clearInterval(timer)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function mainWorktreeStatus(root: string) {
  return (await git(["status", "--porcelain"], root)).trim()
}

function finalizationLoggedExperiment(status: WorkerFinalizationStatus) {
  return status === "measured_and_logged"
}

function finalizationStatusLabel(status: WorkerFinalizationStatus) {
  switch (status) {
    case "none":
      return "no result changes"
    case "already_logged":
      return "already logged"
    case "measured_and_logged":
      return "measured and logged"
    case "salvaged_unmeasured":
      return "salvaged without measurement"
    case "failed":
      return "failed"
  }
}

async function assertMainWorktreeClean(root: string, label: string) {
  const status = await mainWorktreeStatus(root)
  if (!status) return
  throw new Error(
    `Main checkout must be clean ${label}. Commit, stash, or reset these changes before launching workers:\n${status}`
  )
}

function workerProgress({
  hypothesisName,
  logPath,
  activityLogPath,
  lastOutputAt,
}: {
  hypothesisName: string
  logPath: string
  activityLogPath?: string | null
  lastOutputAt: string | null
}) {
  const output = lastOutputAt
    ? `last output ${formatAge(lastOutputAt, Date.now())} ago`
    : "no output yet"
  return `${hypothesisName} worker running; ${output}; log ${logPath}${
    activityLogPath ? `; activity ${activityLogPath}` : ""
  }`
}

function workerMetadata({
  invocation,
  manifest,
}: {
  invocation: WorkerInvocation
  manifest: WorkerLaunchManifest
}) {
  return {
    launcher: invocation.agentKind,
    workerLogPath: manifest.logPath,
    workerActivityLogPath: manifest.activityLogPath,
    workerPromptPath: manifest.promptPath,
    lastOutputAt: manifest.lastOutputAt,
    version: manifest.version,
    onyxShimPath: manifest.onyxShimPath,
    addedWritableRoots: manifest.addedWritableRoots,
    preflight: manifest.preflight,
  }
}

async function persistWorkerLaunchState({
  root,
  manifest,
  workerBranch,
}: {
  root: string
  manifest: WorkerLaunchManifest
  workerBranch: string
}) {
  await writeWorkerLaunchManifest(manifest)
  await upsertWorkerLaunch({
    root,
    launch: {
      workerId: manifest.workerId,
      sessionId: manifest.sessionId,
      hypothesisId: manifest.hypothesisId,
      status: manifest.status,
      worktree: manifest.cwd,
      branchName: workerBranch,
      promptPath: manifest.promptPath,
      logPath: manifest.logPath,
      activityLogPath: manifest.activityLogPath,
      manifestPath: manifest.manifestPath,
      exitCode: manifest.exitCode,
      signal: manifest.signal,
      timedOut: manifest.timedOut,
      startupTimedOut: manifest.startupTimedOut,
      lastOutputAt: manifest.lastOutputAt,
      finalizationStatus: manifest.finalization?.finalizationStatus ?? null,
      error: manifest.error ?? manifest.finalization?.error ?? null,
      metadata: {
        agentKind: manifest.agentKind,
        command: manifest.command,
        args: manifest.args,
        onyxShimPath: manifest.onyxShimPath,
        addedWritableRoots: manifest.addedWritableRoots,
      },
      startedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
    },
  })
}

type HypothesisRunResult = {
  hypothesis: ApiHypothesis
  workerId?: string
  resultCommitSha?: string
  status: "completed" | "failed" | "stopped"
  error?: string
}

async function runHypothesisOnce({
  root,
  projectPath,
  campaign,
  setup,
  sessionId,
  hypothesis,
  workerCommand,
  agentKind,
  maxIterations,
  endTimeMs,
  hardEndTimeMs,
  workerTimeoutMs,
  startupTimeoutMs,
  stopGraceMs,
  quiet,
  syncSupervisor,
  onRegistered,
  args,
}: {
  root: string
  projectPath: string
  campaign: ApiCampaign
  setup: ResearchSetupFile
  sessionId: string
  hypothesis: ApiHypothesis
  workerCommand?: string
  agentKind: string
  maxIterations: number
  endTimeMs: number
  hardEndTimeMs: number
  workerTimeoutMs: number
  startupTimeoutMs: number
  stopGraceMs: number
  quiet: boolean
  syncSupervisor: ReturnType<typeof createSyncSupervisor>
  onRegistered?: (worker: { workerId: string; hypothesisId: string }) => void
  args: Args
}): Promise<HypothesisRunResult> {
  let workerId: string | undefined
  let resultCommitSha: string | undefined
  let workerBranch = "unknown"
  let launchManifest: WorkerLaunchManifest | null = null
  let workerShim: WorkerOnyxShim | null = null
  let workerTempDir: string | null = null
  const cleanupWorkerTempDir = async () => {
    if (!workerTempDir) return
    await rm(workerTempDir, { recursive: true, force: true }).catch(() => {})
    workerTempDir = null
  }

  try {
    const effectiveAgentKind = workerCommand ? "custom" : agentKind
    const worker = await registerLocalWorker({
      root,
      campaignId: campaign.id,
      sessionId,
      hypothesisId: hypothesis.id,
      workerName: `${hypothesis.name}-${effectiveAgentKind}`,
      agentKind: effectiveAgentKind,
      runtime: "local",
    })
    workerId = worker.id
    onRegistered?.({ workerId: worker.id, hypothesisId: hypothesis.id })
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "running",
      sessionId,
      hypothesisId: hypothesis.id,
      phase: "preflight",
      event: "hypothesis_started",
      progressMessage: `Preparing ${hypothesis.name} worker preflight`,
    })

    const worktreeInfo = await ensureWorktree({
      root,
      hypothesis,
      sessionId,
      workerId: worker.id,
    })
    const worktree = worktreeInfo.dir
    workerBranch = worktreeInfo.branch
    await emitEvent(root, {
      type: "hypothesis_started",
      campaignName: campaign.name,
      campaignId: campaign.id,
      sessionId,
      workerId: worker.id,
      hypothesisId: hypothesis.id,
      message: hypothesis.name,
    })

    const [briefPath, sessionStatePath] = await Promise.all([
      writeBrief({
        root,
        campaignId: campaign.id,
        sessionId,
        hypothesis,
        workerId: worker.id,
        args,
      }),
      writeSessionState({ root, sessionId, hypothesis, args }).catch(
        () => null
      ),
    ])
    const prompt = await writeWorkerPrompt({
      root,
      worktree,
      projectPath,
      campaign,
      setup,
      sessionId,
      hypothesis,
      workerId: worker.id,
      workerBranch,
      briefPath,
      sessionStatePath,
      maxIterations,
      endTimeMs,
    })
    workerShim = await writeWorkerOnyxShim({ root, sessionId })
    workerTempDir = await createWorkerTempDir({
      root,
      sessionId,
      workerId: worker.id,
    })
    const workerBaseEnv = workerEnvironment({
      baseEnv: process.env,
      shim: workerShim,
    })
    const workerRunEnv = {
      ...workerBaseEnv,
      ONYX_CAMPAIGN_ID: campaign.id,
      ONYX_CAMPAIGN_NAME: campaign.name,
      ONYX_SESSION_ID: sessionId,
      ONYX_HYPOTHESIS_ID: hypothesis.id,
      ONYX_HYPOTHESIS_NAME: hypothesis.name,
      ONYX_WORKER_BRANCH: workerBranch,
      ONYX_WORKER_ID: worker.id,
      ONYX_RESEARCH_DB: await researchDbPath(root),
      ONYX_BRIEF_FILE: briefPath,
      ONYX_WORKER_PROMPT_FILE: prompt.path,
      ONYX_WORKTREE_ROOT: worktree,
      ONYX_PROJECT_ROOT: projectPath ? join(worktree, projectPath) : worktree,
      ONYX_SETUP_FILE: setupPath(worktree, projectPath),
      ONYX_VALIDATION_FILE: validationPath(worktree, projectPath),
      ONYX_RESEARCH_SPEC_FILE: onyxPath(worktree, projectPath, "onyx.md"),
      TMPDIR: workerTempDir,
      TMP: workerTempDir,
      TEMP: workerTempDir,
      ONYX_RESEARCH_DEADLINE_AT: new Date(
        prompt.researchDeadlineMs
      ).toISOString(),
      ONYX_SHUTDOWN_DEADLINE_AT: new Date(
        prompt.shutdownDeadlineMs
      ).toISOString(),
      ONYX_SHUTDOWN_CUSHION_SECONDS: String(
        Math.ceil(prompt.shutdownCushionMs / 1000)
      ),
      ...(sessionStatePath
        ? { ONYX_SESSION_STATE_FILE: sessionStatePath }
        : {}),
    }
    const addedWritableRoots = workerCommand
      ? []
      : await workerGitWritableRoots(worktree)
    const invocation = buildWorkerInvocation({
      agentKind,
      workerCommand,
      worktree,
      prompt: prompt.markdown,
      addedWritableRoots,
    })
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "running",
      sessionId,
      hypothesisId: hypothesis.id,
      phase: "reading_context",
      event: "context_ready",
      progressMessage: `Worker context files are ready for ${hypothesis.name}`,
    })
    const preflight = await preflightWorkerInvocation(invocation, {
      cwd: worktree,
      env: workerRunEnv,
      campaignName: campaign.name,
      sessionId,
    })
    const launchPaths = await workerLaunchPaths({
      root,
      sessionId,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
    })
    launchManifest = {
      schemaVersion: 1,
      agentKind: invocation.agentKind,
      command: invocation.command,
      args: invocation.redactedArgs,
      onyxShimPath: workerShim.onyxPath,
      addedWritableRoots: invocation.addedWritableRoots,
      cwd: worktree,
      promptPath: prompt.path,
      logPath: launchPaths.logPath,
      activityLogPath: launchPaths.activityLogPath,
      manifestPath: launchPaths.manifestPath,
      sessionId,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
      workerName: worker.workerName,
      version: preflight.version,
      startedAt: new Date().toISOString(),
      lastOutputAt: null,
      completedAt: null,
      status: "starting",
      exitCode: null,
      signal: null,
      timedOut: false,
      startupTimedOut: false,
      error: null,
      preflight,
      finalization: null,
    }
    await persistWorkerLaunchState({ root, manifest: launchManifest, workerBranch })
    console.log(`worker: ${worker.id}`)
    console.log(`hypothesis: ${hypothesis.id} ${hypothesis.name}`)
    console.log(`worktree: ${worktree}`)
    console.log(`manifest: ${launchPaths.manifestPath}`)
    console.log(`raw log: ${launchPaths.logPath}`)
    console.log(`activity log: ${launchPaths.activityLogPath}`)
    const firstAttemptWarningMs =
      nonnegativeNumberOption(
        args,
        "first-attempt-warning-seconds",
        DEFAULT_FIRST_ATTEMPT_WARNING_MS / 1000
      ) * 1000
    let firstAttemptWarningTimer: ReturnType<typeof setTimeout> | null = null
    if (firstAttemptWarningMs > 0) {
      firstAttemptWarningTimer = setTimeout(() => {
        void hasWorkerLoggedAttempt({ root, workerId: worker.id })
          .then((hasAttempt) => {
            if (hasAttempt) return
            return recordLocalWorkerHeartbeat({
              root,
              workerId: worker.id,
              status: "running",
              sessionId,
              hypothesisId: hypothesis.id,
              phase: "first_attempt",
              event: "first_attempt_delayed",
              progressMessage:
                "No logged workflow attempt yet; worker may still be orienting or sweeping.",
              metadata: {
                warningAfterSeconds: Math.round(firstAttemptWarningMs / 1000),
              },
            })
          })
          .catch(() => {})
      }, firstAttemptWarningMs)
      firstAttemptWarningTimer.unref?.()
    }
    const workerResult = await withWorkerHeartbeat({
      root,
      workerId: worker.id,
      sessionId,
      hypothesisId: hypothesis.id,
      phase: "first_attempt",
      progressMessage: () =>
        workerProgress({
          hypothesisName: hypothesis.name,
          logPath: launchManifest?.logPath ?? launchPaths.logPath,
          activityLogPath:
            launchManifest?.activityLogPath ?? launchPaths.activityLogPath,
          lastOutputAt: launchManifest?.lastOutputAt ?? null,
        }),
      metadata: () =>
        launchManifest
          ? workerMetadata({ invocation, manifest: launchManifest })
          : {},
      run: () =>
        runStreamingProcess(invocation.command, invocation.args, {
          cwd: worktree,
          timeoutMs: Math.max(
            1,
            Math.min(workerTimeoutMs, hardEndTimeMs - Date.now())
          ),
          startupTimeoutMs,
          killGraceMs: 5000,
          logPath: launchPaths.logPath,
          activityLogPath: launchPaths.activityLogPath,
          logHeader: [
            `# agent: ${invocation.agentKind}`,
            `# prompt: ${prompt.path}`,
            `# worker: ${worker.id}`,
            `# hypothesis: ${hypothesis.id}`,
          ].join("\n"),
          stdin: invocation.stdin,
          env: workerRunEnv,
          cancel: {
            graceMs: stopGraceMs,
            pollMs: 5000,
            shouldCancel: () =>
              harnessShouldStopSession({ root, sessionId, args }),
          },
          onOutput: ({ at }) => {
            if (!launchManifest) return
            launchManifest = {
              ...launchManifest,
              status: "running",
              lastOutputAt: at,
            }
            void persistWorkerLaunchState({
              root,
              manifest: launchManifest,
              workerBranch,
            }).catch(() => {})
          },
        }),
      quiet,
    })
    if (firstAttemptWarningTimer) clearTimeout(firstAttemptWarningTimer)
    const stoppedByHarness = workerResult.cancelled
    if (launchManifest) {
      launchManifest = {
        ...launchManifest,
        completedAt: new Date().toISOString(),
        status: stoppedByHarness
          ? "stopped"
          : workerResult.code === 0
            ? "completed"
            : "failed",
        exitCode: workerResult.code,
        signal: workerResult.signal,
        timedOut: workerResult.timedOut,
        startupTimedOut: workerResult.startupTimedOut,
        lastOutputAt: workerResult.lastOutputAt,
      }
      await persistWorkerLaunchState({ root, manifest: launchManifest, workerBranch })
    }
    const workerFailure = processFailure(
      workerResult,
      `Worker process for ${hypothesis.name}`
    )
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "running",
      sessionId,
      hypothesisId: hypothesis.id,
      phase: "finalizing",
      event: "finalization_started",
      progressMessage: `Finalizing ${hypothesis.name} worker output`,
      gitLabel: resultCommitSha ?? null,
    })
    const finalization = await finalizeHypothesisAttempt({
      root,
      worktree,
      campaign,
      hypothesis,
      sessionId,
      workerId: worker.id,
      workerBranch,
      args,
      workerFailed: Boolean(workerFailure) || stoppedByHarness,
    })
    if (finalization.commitSha) resultCommitSha = finalization.commitSha
    if (launchManifest) {
      launchManifest = {
        ...launchManifest,
        finalization,
      }
      await persistWorkerLaunchState({ root, manifest: launchManifest, workerBranch })
    }
    if (finalizationLoggedExperiment(finalization.finalizationStatus)) {
      syncSupervisor.request()
    }
    if (finalization.rootDriftStatus === "dirty") {
      throw new Error(
        finalization.error ??
          "Main checkout changed during worker run; see worker manifest."
      )
    }

    if (stoppedByHarness) {
      await recordLocalWorkerHeartbeat({
        root,
        workerId: worker.id,
        status: "stopped",
        sessionId,
        hypothesisId: hypothesis.id,
        phase: "stopped",
        event: "stop_requested",
        progressMessage: `${hypothesis.name} stopped after session stop request`,
        gitLabel: resultCommitSha,
      })
      await upsertLocalSummary({
        root,
        campaignId: campaign.id,
        sessionId,
        hypothesisId: hypothesis.id,
        authoredByWorkerId: worker.id,
        summaryKind: "hypothesis_summary",
        title: `${hypothesis.name} worker stopped`,
        body: [
          `Outcome: stopped`,
          `Latest commit: ${resultCommitSha ?? "n/a"}`,
          `Finalization: ${finalizationStatusLabel(finalization.finalizationStatus)}`,
          finalization.workerBranchPushStatus === "failed"
            ? `Worker branch push failed: ${finalization.error ?? "unknown error"}`
            : `Worker branch push: ${finalization.workerBranchPushStatus}`,
          finalization.error ? `Finalization note: ${finalization.error}` : "",
          `Worker manifest: ${launchManifest?.manifestPath ?? "n/a"}`,
          `Worker activity log: ${launchManifest?.activityLogPath ?? "n/a"}`,
          `Worker raw log: ${launchManifest?.logPath ?? "n/a"}`,
        ]
          .filter(Boolean)
          .join("\n"),
        isCurrent: false,
        metadata: {
          authoredBy: "worker-harness",
          outcome: "stopped",
          resultCommitSha: resultCommitSha ?? null,
          finalization,
        },
      })
      await cleanupWorkerTempDir()
      return {
        hypothesis,
        workerId: worker.id,
        resultCommitSha,
        status: "stopped",
      }
    }

    if (workerFailure) {
      throw new Error(
        `${workerFailure}. ${
          finalization.attempted
            ? `Best-effort finalization ${finalizationStatusLabel(finalization.finalizationStatus)} for ${finalization.commitSha ?? "unknown commit"}. `
            : ""
        }See worker log: ${launchManifest?.logPath ?? launchPaths.logPath}`
      )
    }

    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "completed",
      sessionId,
      hypothesisId: hypothesis.id,
      phase: "completed",
      event: "hypothesis_completed",
      progressMessage: `${hypothesis.name} completed`,
      gitLabel: resultCommitSha,
    })
    await upsertLocalSummary({
      root,
      campaignId: campaign.id,
      sessionId,
      hypothesisId: hypothesis.id,
      authoredByWorkerId: worker.id,
      summaryKind: "hypothesis_summary",
      title: `${hypothesis.name} worker finalization`,
      body: [
        `Outcome: completed`,
        `Latest commit: ${resultCommitSha ?? "n/a"}`,
        `Finalization: ${finalizationStatusLabel(finalization.finalizationStatus)}`,
        finalization.workerBranchPushStatus === "failed"
          ? `Worker branch push failed: ${finalization.error ?? "unknown error"}`
          : `Worker branch push: ${finalization.workerBranchPushStatus}`,
        finalization.error ? `Finalization note: ${finalization.error}` : "",
        `Worker manifest: ${launchManifest?.manifestPath ?? "n/a"}`,
        `Worker activity log: ${launchManifest?.activityLogPath ?? "n/a"}`,
        `Worker raw log: ${launchManifest?.logPath ?? "n/a"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      isCurrent: false,
      metadata: {
        authoredBy: "worker-harness",
        outcome: "completed",
        resultCommitSha: resultCommitSha ?? null,
        finalization,
      },
    })
    await cleanupWorkerTempDir()
    return {
      hypothesis,
      workerId: worker.id,
      resultCommitSha,
      status: "completed",
    }
  } catch (error) {
    const message = errorMessage(error)
    if (launchManifest) {
      launchManifest = {
        ...launchManifest,
        completedAt: new Date().toISOString(),
        status: "failed",
        error: message,
      }
      await persistWorkerLaunchState({
        root,
        manifest: launchManifest,
        workerBranch,
      }).catch(() => {})
    }
    if (workerId) {
      const metadata = launchManifest
        ? {
            workerLogPath: launchManifest.logPath,
            workerActivityLogPath: launchManifest.activityLogPath,
            workerPromptPath: launchManifest.promptPath,
            lastOutputAt: launchManifest.lastOutputAt,
            launcher: launchManifest.agentKind,
          }
        : undefined
      await recordLocalWorkerHeartbeat({
        root,
        workerId,
        status: "failed",
        sessionId,
        hypothesisId: hypothesis.id,
        phase: "failed",
        event: "worker_failed",
        progressMessage: message.slice(0, 1000),
        gitLabel: resultCommitSha ?? null,
        metadata,
      }).catch(() => {})
    }
    if (workerId) {
      await upsertLocalSummary({
        root,
        campaignId: campaign.id,
        sessionId,
        hypothesisId: hypothesis.id,
        authoredByWorkerId: workerId,
        summaryKind: "hypothesis_summary",
        title: `${hypothesis.name} worker finalization failed`,
        body: [
          `Outcome: failed`,
          `Error: ${message}`,
          resultCommitSha ? `Latest commit: ${resultCommitSha}` : "",
          launchManifest?.manifestPath
            ? `Worker manifest: ${launchManifest.manifestPath}`
            : "",
          launchManifest?.activityLogPath
            ? `Worker activity log: ${launchManifest.activityLogPath}`
            : "",
          launchManifest?.logPath
            ? `Worker raw log: ${launchManifest.logPath}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        isCurrent: false,
        metadata: {
          authoredBy: "worker-harness",
          outcome: "failed",
          resultCommitSha: resultCommitSha ?? null,
        },
      })
    }
    await cleanupWorkerTempDir()
    return {
      hypothesis,
      workerId,
      resultCommitSha,
      status: "failed",
      error: message,
    }
  }
}

export async function commandResearchStart(args: Args) {
  const root = await repoRoot()
  const { campaign, projectPath } = await campaignForName(root, args)
  await assertLocalSetupReady(root, projectPath)
  await assertSetupCommitted({
    root,
    projectPath,
    baseCommitSha: campaign.baseCommitSha,
    requireBaseMatchesHead: true,
  })

  const workerTargetOption = args.options.workers ?? args.options.agents
  const maxIterations = positiveIntegerOption(args, "max-iterations", 10)
  const maxMinutes = positiveNumberOption(args, "max-minutes", 120)
  const hypotheses = await hypothesisPlansOption(args)
  const workerTarget =
    workerTargetOption === undefined && hypotheses
      ? hypotheses.length
      : positiveIntegerOption(args, "workers", Number(workerTargetOption ?? 1))
  const launchAgent = args.options.agent
  if (
    launchAgent !== undefined &&
    launchAgent !== "codex" &&
    launchAgent !== "claude"
  ) {
    throw new Error("--agent must be codex or claude")
  }
  const endTimeMs = Date.now() + maxMinutes * 60_000
  const result = await createLocalSession({
    root,
    campaignId: campaign.id,
    name: args.options.name ?? `research-${new Date().toISOString()}`,
    workerTarget,
    hypotheses,
    maxIterations,
    endTimeMs,
    metadata: {
      startedBy: "onyx-research",
      maxIterations,
      maxMinutes,
      agentKind: launchAgent ?? "codex",
    },
  })
  const state = await readState(root)
  const key = campaignStateKey(projectPath, campaign.name)
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    sessionId: result.session.id,
  }
  state.sessions = state.sessions ?? {}
  state.sessions[result.session.id] = {
    campaignName: campaign.name,
    campaignId: campaign.id,
    endTimeMs,
    maxIterations,
    status: "running",
  }
  await writeState(root, state)
  await emitEvent(root, {
    type: "research_started",
    campaignName: campaign.name,
    campaignId: campaign.id,
    sessionId: result.session.id,
    message: `${workerTarget} worker slot(s), ${result.hypotheses.length} hypothesis(s)`,
  })
  if (args.options.offline !== "true") {
    await flushOutbox(root, args, { quiet: true }).catch((error) => {
      if (args.options["require-online"] === "true") throw error
    })
  }

  await Promise.all(
    result.hypotheses.map(async (hypothesis) => {
      await Promise.all([
        writeBrief({
          root,
          campaignId: campaign.id,
          sessionId: result.session.id,
          hypothesis,
          args,
        }),
        writeSessionState({
          root,
          sessionId: result.session.id,
          hypothesis,
          args,
        }).catch(() => null),
      ])
    })
  )

  console.log(`Research session: ${result.session.id}`)
  console.log(`Campaign: ${campaign.name}`)
  console.log(`Workers: 0/${workerTarget}`)
  console.log(`Hypotheses: ${result.hypotheses.length}`)
  const agentOption = launchAgent ? ` --agent ${launchAgent}` : ""
  const budgetOptions = workerBudgetOptions({ maxIterations, maxMinutes })
  if (result.hypotheses.length === 0) {
    console.log(
      "No hypotheses were created. Add one with `onyx research hypothesis add --session " +
        `${result.session.id} --focus <focus> --hypothesis <statement>` +
        "` before launching workers."
    )
  } else {
    for (let index = 0; index < workerTarget; index += 1) {
      const hypothesis = result.hypotheses[index % result.hypotheses.length]
      if (!hypothesis) continue
      console.log(
        `- worker ${index + 1}: ${hypothesis.name}: ${hypothesis.plan.focus}\n  onyx worker run --session ${result.session.id} --hypothesis ${hypothesis.id}${agentOption}${budgetOptions}`
      )
    }
  }
  console.log("Use `onyx listen` or `onyx research status` to supervise.")
}

export async function commandResearchHypothesisAdd(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: args.options.campaign,
    })
  if (!sessionId && !args.options.campaign) {
    throw new Error(
      "Pass --session <id> or --campaign <name>, or start a research session first."
    )
  }

  const setupForPlan = await readSetupFile(root, projectPath).catch(() => null)
  const plan = await hypothesisPlanOption(args, {
    setup: setupForPlan,
    projectPath,
  })
  const before = sessionId
    ? await getLocalSessionState(root, sessionId).catch(() =>
        getResearchSessionState(sessionId, args)
      )
    : null
  const campaign =
    before?.campaign ?? (await campaignForName(root, args)).campaign
  if (before?.campaign) {
    const key = campaignStateKey(projectPath, before.campaign.name)
    await cacheLocalCampaign({
      root,
      campaign: before.campaign,
      projectPath,
      setup: state.campaigns?.[key]?.setup ?? {},
    }).catch(() => null)
  }
  await assertLocalSetupReady(root, projectPath)
  const sessionMetadata = before?.session.metadata ?? {}
  const agentKind =
    args.options.agent ??
    (typeof sessionMetadata.agentKind === "string"
      ? sessionMetadata.agentKind
      : "codex")
  if (agentKind !== "codex" && agentKind !== "claude") {
    throw new Error("--agent must be codex or claude")
  }
  const createdHypothesis = await createLocalHypothesis({
    root,
    campaignId: campaign.id,
    createdBySessionId: sessionId ?? null,
    plan,
    name: args.options.name,
    description: args.options.description,
    baseCommitSha: args.options.base,
    metadata: {
      createdBy: "onyx-research",
      ...(sessionId ? { createdBySessionId: sessionId } : {}),
    },
  })

  const maxIterations =
    typeof sessionMetadata.maxIterations === "number"
      ? sessionMetadata.maxIterations
      : 10
  const maxMinutes =
    typeof sessionMetadata.maxMinutes === "number"
      ? sessionMetadata.maxMinutes
      : 120
  const endTimeMs =
    sessionId && state.sessions?.[sessionId]?.endTimeMs
      ? state.sessions[sessionId].endTimeMs
      : Date.now() + maxMinutes * 60_000
  if (sessionId) {
    state.sessions = state.sessions ?? {}
    state.sessions[sessionId] = {
      ...(state.sessions[sessionId] ?? {}),
      campaignName: campaign.name,
      campaignId: campaign.id,
      endTimeMs,
      maxIterations,
      status: "running",
    }
  }
  if (args.options.offline !== "true") {
    await flushOutbox(root, args, { quiet: true }).catch((error) => {
      if (args.options["require-online"] === "true") throw error
    })
  }
  const key = campaignStateKey(projectPath, campaign.name)
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    ...(sessionId ? { sessionId } : {}),
  }
  await writeState(root, state)

  const hypothesis = createdHypothesis
  if (sessionId) {
    await Promise.all([
      writeBrief({
        root,
        campaignId: campaign.id,
        sessionId,
        hypothesis,
        args,
      }),
      writeSessionState({ root, sessionId, hypothesis, args }).catch(
        () => null
      ),
    ])
  }

  console.log(`Research hypothesis: ${hypothesis.id}`)
  if (sessionId) console.log(`Session: ${sessionId}`)
  console.log(`Hypothesis: ${hypothesis.name}: ${hypothesis.plan.focus}`)
  if (sessionId) {
    const budgetOptions = workerBudgetOptions({ maxIterations, maxMinutes })
    console.log(
      `onyx worker run --session ${sessionId} --hypothesis ${hypothesis.id} --agent ${agentKind}${budgetOptions}`
    )
  } else {
    console.log("Start or choose a research session before launching a worker.")
  }
}

export async function commandResearchStatus(args: Args) {
  const root = await repoRoot()
  const shouldReconcile = args.options.reconcile === "true"
  const campaignInfo = await campaignForName(root, args, {
    persistState: shouldReconcile,
  })
  const { campaign } = campaignInfo
  const projectPath = await resolveProjectPath(root, args)
  if (shouldReconcile) {
    await reconcileCampaignIntoLocalState({
      root,
      campaignId: campaign.id,
      projectPath,
      args,
    }).catch(() => {})
  }
  const state = await readState(root)
  const activeSessionId =
    state.campaigns?.[campaignStateKey(projectPath, campaign.name)]?.sessionId
  const scopeAll = args.options["all-sessions"] === "true"
  let localSessionState = activeSessionId
    ? await getLocalSessionState(root, activeSessionId).catch(() => null)
    : null
  const manifests = activeSessionId
    ? await readWorkerLaunchManifests(root, activeSessionId)
    : []
  if (activeSessionId && localSessionState) {
    const repaired = await reconcileTerminalWorkerManifests({
      root,
      sessionId: activeSessionId,
      workers: localSessionState.workers,
      manifests,
    })
    if (repaired > 0) {
      localSessionState = await getLocalSessionState(
        root,
        activeSessionId
      ).catch(() => localSessionState)
    }
  }
  const overview = localSessionState
    ? {
        campaign: localSessionState.campaign,
        hypotheses: localSessionState.hypotheses,
        workers: localSessionState.workers,
        summaries: localSessionState.summaries,
        knowledge: localSessionState.knowledge,
      }
    : campaignInfo.overview
  const hypotheses = overview.hypotheses
  const workers =
    activeSessionId && !scopeAll
      ? overview.workers.filter(
          (worker) => worker.sessionId === activeSessionId
        )
      : overview.workers
  const manifestByWorker = new Map(
    manifests.map((manifest) => [manifest.workerId, manifest])
  )
  const sessionState = localSessionState
  const activeWorkers = workers.filter(workerIsActive).length
  const target = sessionState?.session.workerTarget ?? null
  const openSlots =
    typeof target === "number" ? Math.max(0, target - activeWorkers) : null
  const sessionStatus =
    sessionState?.session.status ??
    (activeSessionId ? state.sessions?.[activeSessionId]?.status : null) ??
    null
  const stopping =
    sessionStatus === "stop_requested" ||
    (activeSessionId
      ? Boolean(state.sessions?.[activeSessionId]?.stopRequested)
      : false)
  const pendingSync = await pendingResearchSyncCount(root).catch(() => 0)
  const conflicts = await researchSyncConflictCount(root).catch(() => 0)
  const launchSuggestions = launchSuggestionsForSession({
    sessionId: activeSessionId ?? null,
    sessionStatus,
    openSlots,
    stopping,
    hypotheses,
    workers,
  })

  if (args.options.json === "true") {
    console.log(
      JSON.stringify(
        {
          campaign: overview.campaign,
          session: activeSessionId
            ? {
                id: activeSessionId,
                status: sessionStatus,
                workerTarget: target,
                activeWorkers,
                openSlots,
                stopping,
              }
            : null,
          hypotheses,
          workers,
          sync: {
            pendingSync,
            conflicts,
          },
          launchSuggestions,
        },
        null,
        2
      )
    )
    return
  }

  console.log(`campaign: ${campaign.name}`)
  console.log(`setup: local onyx/setup.json`)
  if (activeSessionId) {
    console.log(`session: ${activeSessionId} ${sessionStatus ?? ""}`.trim())
  }
  console.log(
    `sync: ${pendingSync} SQLite event(s) pending${
      conflicts ? `, ${conflicts} conflict(s)` : ""
    }`
  )

  if (activeSessionId) {
    console.log(
      `worker slots: ${activeWorkers}/${target ?? "?"}${
        stopping ? " (stop requested; open slots are intentionally idle)" : ""
      }`
    )
    for (const suggestion of launchSuggestions) {
      if (suggestion.kind === "launch_worker") {
        console.log(`next worker: ${suggestion.command} (${suggestion.reason})`)
      } else {
        console.log(
          `next hypothesis: ${suggestion.command} (${suggestion.reason})`
        )
      }
    }
  }
  console.log(
    `hypotheses: ${hypotheses.length}${scopeAll ? " (all sessions)" : ""}`
  )
  for (const hypothesis of hypotheses) {
    const relatedWorkers = workers.filter(
      (worker) => worker.hypothesisId === hypothesis.id
    )
    const activeWorkerCount = relatedWorkers.filter(workerIsActive).length
    console.log(
      [
        `  ${hypothesis.name}: ${hypothesis.status}`,
        `workers=${activeWorkerCount}/${relatedWorkers.length}`,
        hypothesis.lastWorkedAt
          ? `lastWorked=${formatAge(hypothesis.lastWorkedAt, Date.now())}`
          : null,
        `best=${hypothesis.bestMetricValue ?? "-"}`,
      ]
        .filter(Boolean)
        .join(" ")
    )
  }
  console.log(`workers: ${workers.length}`)
  for (const worker of workers) {
    const manifest = manifestByWorker.get(worker.id)
    const lastSeen = formatAge(worker.lastSeenAt, Date.now())
    const lastOutput = manifest
      ? formatAge(manifest.lastOutputAt, Date.now())
      : "—"
    const manifestError =
      manifest?.error?.replace(/\s+/g, " ").slice(0, 160) ?? null
    console.log(
      [
        `  ${worker.workerName}: ${worker.status}`,
        worker.phase ? `phase=${worker.phase}` : null,
        `seen=${lastSeen}`,
        `lastOutput=${lastOutput}`,
        manifest?.timedOut ? "timeout=true" : null,
        manifest?.activityLogPath
          ? `activity=${manifest.activityLogPath}`
          : null,
        manifest?.logPath ? `log=${manifest.logPath}` : null,
        manifestError ? `error="${manifestError}"` : null,
      ]
        .filter(Boolean)
        .join(" ")
    )
  }
}

export async function commandResearchHypotheses(args: Args) {
  if (args.options.example !== "true") {
    throw new Error("Pass --example to print a hypotheses JSON template.")
  }
  const root = await repoRoot(args.options.cwd).catch(() => null)
  const projectPath = root
    ? await resolveProjectPath(root, args).catch(() => "")
    : ""
  const setup = root
    ? await readSetupFile(root, projectPath).catch(() => null)
    : null
  const {
    metricName,
    direction,
    scope,
    protectedPaths,
    successSignals,
    giveUpSignals,
  } = setupAwareHypothesisDefaults({ setup, projectPath })
  const constraints = [
    "Preserve the declared workflow, tools, and protected setup files.",
  ]
  const example = [
    {
      focus: `Independent search to ${direction} ${metricName}`,
      statement:
        "A deliberately scoped exploration can improve the target metric while preserving the configured setup surface.",
      startingPoints: [
        ...scope,
        "Inspect recent experiments and shared knowledge before editing.",
      ],
      avoidList: protectedPaths,
      successSignals,
      giveUpSignals: constraints,
    },
    {
      focus: `Follow-up hypothesis for ${metricName}`,
      statement:
        "A focused follow-up based on previous hypothesis results can test a different mechanism or exploit a promising partial result.",
      startingPoints: [
        "Review hypothesis summaries, experiment notes, and current best metric before choosing edits.",
        ...scope,
      ],
      avoidList: protectedPaths,
      successSignals: [
        `The eval prints an improved METRIC ${metricName} value.`,
        "The final diff is small enough for a human to review quickly.",
      ],
      giveUpSignals,
    },
  ].map((plan) => researchHypothesisPlanSchema.parse(plan))

  console.log(JSON.stringify(example, null, 2))
}

function activeSessionIdFromState({
  state,
  projectPath,
  campaignName,
}: {
  state: Awaited<ReturnType<typeof readState>>
  projectPath: string
  campaignName?: string
}) {
  if (campaignName) {
    return state.campaigns?.[campaignStateKey(projectPath, campaignName)]
      ?.sessionId
  }
  if (state.activeCampaign) {
    return state.campaigns?.[
      campaignStateKey(projectPath, state.activeCampaign)
    ]?.sessionId
  }
  return undefined
}

async function reconcileCampaignIntoLocalState({
  root,
  campaignId,
  projectPath,
  args,
}: {
  root: string
  campaignId: string
  projectPath: string
  args: Args
}) {
  const response = await reconcileCampaign(campaignId, args)
  const state = await readState(root).catch(() => null)
  const key = campaignStateKey(projectPath, response.campaign.name)
  await cacheLocalCampaign({
    root,
    campaign: response.campaign,
    projectPath,
    setup: state?.campaigns?.[key]?.setup ?? {},
  }).catch(() => {})
  await applyRemoteExperimentGitStatuses({
    root,
    experiments: response.experiments,
  }).catch(() => {})
  return response
}

export async function commandResearchShouldStop(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    process.env.ONYX_SESSION_ID ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: args.options.campaign,
    })
  if (!sessionId) {
    console.log("continue: no active session")
    return
  }

  const localSession = state.sessions?.[sessionId]
  const iteration =
    args.options.iteration === undefined ? null : Number(args.options.iteration)
  const reasons: string[] = []
  if (localSession?.stopRequested) reasons.push("stop requested")
  const localDbSession = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
  if (
    localDbSession &&
    localDbSession.session.status !== "running" &&
    !reasons.includes(`local session ${localDbSession.session.status}`)
  ) {
    reasons.push(`local session ${localDbSession.session.status}`)
  }
  const workerResearchDeadline = process.env.ONYX_RESEARCH_DEADLINE_AT
    ? Date.parse(process.env.ONYX_RESEARCH_DEADLINE_AT)
    : Number.NaN
  if (
    Number.isFinite(workerResearchDeadline) &&
    Date.now() >= workerResearchDeadline
  ) {
    reasons.push("worker shutdown cushion reached")
  }
  if (localSession?.endTimeMs && Date.now() >= localSession.endTimeMs) {
    reasons.push("time budget reached")
  }
  if (
    iteration !== null &&
    Number.isFinite(iteration) &&
    localSession?.maxIterations &&
    iteration > localSession.maxIterations
  ) {
    reasons.push("iteration budget reached")
  }

  try {
    const remote = await getResearchSessionState(sessionId, args)
    if (
      remote.session.status === "stop_requested" ||
      remote.session.status === "stopped" ||
      remote.session.status === "completed" ||
      remote.session.status === "failed"
    ) {
      reasons.push(`remote session ${remote.session.status}`)
    }
  } catch {
    // Local state is enough for offline stop checks.
  }

  const shouldStop = reasons.length > 0
  if (args.options.json === "true") {
    console.log(JSON.stringify({ shouldStop, sessionId, reasons }, null, 2))
  } else {
    console.log(
      shouldStop
        ? `stop: ${reasons.join(", ")}`
        : `continue: session ${sessionId}`
    )
  }
}

export async function commandResearchStop(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: args.options.campaign,
    })
  if (!sessionId) {
    throw new Error("Pass --session <id> or start a research session first.")
  }

  const campaignId =
    state.sessions?.[sessionId]?.campaignId ??
    (args.options.campaign
      ? (await campaignForName(root, args)).campaign.id
      : undefined)
  state.sessions = state.sessions ?? {}
  state.sessions[sessionId] = {
    ...(state.sessions[sessionId] ?? {}),
    campaignId,
    stopRequested: true,
    status: "stop_requested",
  }
  await writeState(root, state)

  if (campaignId) {
    await stopLocalSession({
      root,
      sessionId,
      status: "stop_requested",
      reason: args.options.reason ?? "stop requested",
    }).catch(() => {})
    await refreshSessionStateFiles({ root, sessionId, args }).catch(() => {})
    if (args.options.offline !== "true") {
      await flushOutbox(root, args, { quiet: true }).catch(() => {})
      await reconcileCampaignIntoLocalState({
        root,
        campaignId,
        projectPath,
        args,
      }).catch(() => {})
      await stopCampaignSession(
        sessionId,
        {
          campaignId,
          status: "stop_requested",
          reason: args.options.reason ?? "stop requested",
        },
        args
      ).catch((error) => {
        console.warn(
          `Remote stop request skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
    }
  }
  await emitEvent(root, {
    type: "session_stopped",
    campaignId,
    sessionId,
    message: "stop requested",
  })
  console.log(`Stop requested for research session ${sessionId}`)
}

function safeBranchSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^\/+|\/+$/g, "")
}

export async function commandResearchFinish(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const campaignInfo = await campaignForName(root, args)
  const { campaign } = campaignInfo
  if (args.options.offline !== "true") {
    await reconcileCampaignIntoLocalState({
      root,
      campaignId: campaign.id,
      projectPath: campaignInfo.projectPath,
      args,
    }).catch(() => {})
    await flushOutbox(root, args, { quiet: true }).catch((error) => {
      if (args.options["require-online"] === "true") throw error
    })
  }
  const overview =
    args.options.offline === "true"
      ? campaignInfo.overview
      : await getCampaignOverview(campaign.id, args).catch(
          () => campaignInfo.overview
        )

  const branches: string[] = []
  const campaignSegment = safeBranchSegment(campaign.name)
  if (overview.campaign.bestCommitSha) {
    const bestBranch = `onyx/${campaignSegment}/best`
    await git(
      ["branch", "-f", bestBranch, overview.campaign.bestCommitSha],
      root
    )
    branches.push(`${bestBranch} -> ${overview.campaign.bestCommitSha}`)
  }

  const state = await readState(root)
  const projectPath = await resolveProjectPath(root, args)
  const sessionId =
    args.options.session ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: campaign.name,
    })
  const body = [
    `Finalized campaign ${campaign.name}.`,
    `Best metric: ${overview.campaign.bestMetricValue ?? "n/a"}`,
    `Best commit: ${overview.campaign.bestCommitSha ?? "n/a"}`,
    "Hypothesis refs are not promoted from mutable hypothesis heads; use verified experiment best projections for curated outputs.",
    "",
    "Local branches:",
    ...(branches.length > 0
      ? branches.map((branch) => `- ${branch}`)
      : ["- none"]),
  ].join("\n")
  await upsertLocalSummary({
    root,
    campaignId: campaign.id,
    sessionId,
    summaryKind: "campaign_brief",
    title: `${campaign.name} final results`,
    body,
  }).catch(() => {})
  await completeLocalCampaign({
    root,
    campaignId: campaign.id,
  }).catch(() => {})
  if (sessionId) {
    state.sessions = state.sessions ?? {}
    state.sessions[sessionId] = {
      ...(state.sessions[sessionId] ?? {}),
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: "completed",
      stopRequested: false,
    }
    await writeState(root, state)
    await abandonBlockedWorkflowRunsForSession({
      root,
      sessionId,
      reason: "Campaign finalized; blocked worker workflow is no longer active.",
    }).catch(() => {})
    await stopLocalSession({
      root,
      sessionId,
      status: "completed",
      reason: "finalized",
    }).catch(() => {})
    const sessionState = await getLocalSessionState(root, sessionId).catch(
      () => null
    )
    for (const worker of sessionState?.workers ?? []) {
      if (["idle", "running", "stale", "lost"].includes(worker.status)) {
        await recordLocalWorkerHeartbeat({
          root,
          workerId: worker.id,
          status: "stopped",
          sessionId,
          hypothesisId: worker.hypothesisId,
          phase: "stopped",
          event: "campaign_finalized",
          progressMessage: "Campaign finalized",
          gitLabel: worker.gitLabel ?? null,
        }).catch(() => {})
      }
    }
    await refreshSessionStateFiles({ root, sessionId, args }).catch(() => {})
    await stopCampaignSession(
      sessionId,
      {
        campaignId: campaign.id,
        status: "completed",
        reason: "finalized",
      },
      args
    ).catch(() => {})
  }
  if (args.options.offline !== "true") {
    try {
      const report = await drainFinalSync({
        root,
        args,
        timeoutMs: positiveNumberOption(args, "final-sync-timeout", 120) * 1000,
      })
      printFinalSyncReport(report)
    } catch (error) {
      const [pending, conflicts, pendingEvents, conflictEvents] =
        await Promise.all([
          pendingResearchSyncCount(root).catch(() => 0),
          researchSyncConflictCount(root).catch(() => 0),
          pendingResearchSyncEvents(root, 20).catch(() => []),
          listResearchSyncConflicts(root).catch(() => []),
        ])
      printFinalSyncReport({
        accepted: 0,
        pending,
        conflicts,
        offline: false,
        firstFailed:
          conflictEvents[0] ??
          pendingEvents.find((event) => event.lastError) ??
          null,
      })
      if (args.options["require-online"] === "true") throw error
    }
    await reconcileCampaignIntoLocalState({
      root,
      campaignId: campaign.id,
      projectPath: campaignInfo.projectPath,
      args,
    }).catch(() => {})
  }
  console.log(body)
}

export async function commandSummaryUpsert(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const kind = summaryKindOption(args, "hypothesis_summary")
  const { campaign } = await campaignForName(root, args)
  const title = args.options.title ?? `${kind} ${new Date().toISOString()}`
  const body = args.options.body
  if (!body) throw new Error("Pass --body <text>.")
  const sessionId = optionalUuid(
    args.options.session ?? process.env.ONYX_SESSION_ID,
    "--session"
  )
  const hypothesisId = optionalUuid(
    args.options.hypothesis ?? process.env.ONYX_HYPOTHESIS_ID,
    "--hypothesis"
  )
  const authoredByWorkerId = optionalUuid(
    args.options.worker ?? process.env.ONYX_WORKER_ID,
    "--worker"
  )
  await upsertLocalSummary({
    root,
    campaignId: campaign.id,
    sessionId,
    hypothesisId,
    authoredByWorkerId,
    summaryKind: kind,
    title,
    body,
  })
  if (args.options.offline !== "true") {
    await flushOutbox(root, args, { quiet: true }).catch((error) => {
      if (args.options["require-online"] === "true") throw error
    })
  }
  console.log(`Updated ${kind} for ${campaign.name}`)
}

function summaryScope(summary: ApiSummary) {
  return [
    summary.sessionId ? `session=${summary.sessionId}` : null,
    summary.hypothesisId ? `hypothesis=${summary.hypothesisId}` : null,
    summary.authoredByWorkerId ? `worker=${summary.authoredByWorkerId}` : null,
  ]
    .filter(Boolean)
    .join(" ")
}

export async function commandSummaryList(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const kind = args.options.kind
    ? summaryKindOption(args, "hypothesis_summary")
    : null
  const limit = positiveIntegerOption(args, "limit", 20)
  let sourceSummaries = await listLocalSummaries(root, campaign.id)
  if (sourceSummaries.length === 0 && args.options.offline !== "true") {
    sourceSummaries = await getCampaignOverview(campaign.id, args)
      .then((overview) => overview.summaries)
      .catch(() => sourceSummaries)
  }
  const matchingSummaries = sourceSummaries.filter(
    (summary) => !kind || summary.summaryKind === kind
  )
  const summaries = matchingSummaries.slice(0, limit)

  if (args.options.json === "true") {
    console.log(JSON.stringify(summaries, null, 2))
    return
  }

  if (summaries.length === 0) {
    console.log(
      kind
        ? `No ${kind} summaries found for ${campaign.name}.`
        : `No summaries found for ${campaign.name}.`
    )
    return
  }

  for (const summary of summaries) {
    const scope = summaryScope(summary)
    const preview = summary.body.replace(/\s+/g, " ").trim().slice(0, 180)
    console.log(
      [
        `${summary.summaryKind}${summary.isCurrent ? " current" : ""}: ${summary.title}`,
        scope || null,
        preview ? `- ${preview}` : null,
      ]
        .filter(Boolean)
        .join(" ")
    )
  }
  if (matchingSummaries.length > summaries.length) {
    console.log(
      `... ${matchingSummaries.length - summaries.length} more; raise --limit to see more.`
    )
  }
}

export async function commandKnowledgeAdd(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const kind = args.options.kind ?? "insight"
  if (
    kind !== "insight" &&
    kind !== "dead_end" &&
    kind !== "promising_direction" &&
    kind !== "risk" &&
    kind !== "transfer_note"
  ) {
    throw new Error(
      "--kind must be insight, dead_end, promising_direction, risk, or transfer_note"
    )
  }
  const title = args.options.title
  const body = args.options.body
  if (!title) throw new Error("Pass --title <text>.")
  if (!body) throw new Error("Pass --body <text>.")

  await createLocalKnowledge({
    root,
    campaignId: campaign.id,
    sessionId: args.options.session ?? process.env.ONYX_SESSION_ID,
    hypothesisId: args.options.hypothesis ?? process.env.ONYX_HYPOTHESIS_ID,
    authoredByWorkerId:
      args.options.worker ?? process.env.ONYX_WORKER_ID ?? undefined,
    kind,
    title,
    body,
    confidence:
      args.options.confidence === undefined
        ? undefined
        : Number(args.options.confidence),
  })
  if (args.options.offline !== "true") {
    await flushOutbox(root, args, { quiet: true }).catch((error) => {
      if (args.options["require-online"] === "true") throw error
    })
  }
  console.log(`Added ${kind} knowledge for ${campaign.name}`)
}

export async function commandKnowledgeList(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const limit = positiveIntegerOption(args, "limit", 50)
  const knowledge = (await listLocalKnowledge(root, campaign.id)).slice(
    0,
    limit
  )

  if (args.options.json === "true") {
    console.log(JSON.stringify(knowledge, null, 2))
    return
  }

  if (knowledge.length === 0) {
    console.log(`No shared knowledge recorded for ${campaign.name}.`)
    return
  }

  for (const item of knowledge) {
    const confidence =
      item.confidence === null ? "" : ` confidence=${item.confidence}`
    const scope = [
      item.sessionId ? `session=${item.sessionId}` : null,
      item.hypothesisId ? `hypothesis=${item.hypothesisId}` : null,
    ]
      .filter(Boolean)
      .join(" ")
    console.log(
      [
        `${item.createdAt} ${item.kind}${confidence}: ${item.title}`,
        scope ? `  ${scope}` : null,
        `  ${item.body.replace(/\s+/g, " ").slice(0, 500)}`,
      ]
        .filter(Boolean)
        .join("\n")
    )
  }
}

async function existingRunSession({
  root,
  sessionId,
  args,
}: {
  root: string
  sessionId: string
  args: Args
}) {
  const sessionState = await getLocalSessionState(root, sessionId).catch(() =>
    getResearchSessionState(sessionId, args)
  )
  if (sessionState.session.status !== "running") {
    throw new Error(
      `Research session ${sessionId} is ${sessionState.session.status}; cannot supervise new workers.`
    )
  }
  if (
    args.options.campaign &&
    sessionState.campaign.name !== args.options.campaign
  ) {
    throw new Error(
      `Session ${sessionId} belongs to ${sessionState.campaign.name}, not ${args.options.campaign}.`
    )
  }
  return sessionState
}

function supervisorWorkerTarget(args: Args, fallback: number) {
  const target = positiveIntegerOption(args, "workers", fallback)
  if (target > MAX_LOCAL_SUPERVISOR_WORKERS) {
    throw new Error(
      `--workers is capped at ${MAX_LOCAL_SUPERVISOR_WORKERS} for the local supervisor`
    )
  }
  return target
}

function activeSessionWorkers({
  workers,
  sessionId,
}: {
  workers: ApiWorker[]
  sessionId: string
}) {
  return workers.filter(
    (worker) => worker.sessionId === sessionId && workerIsActive(worker)
  )
}

type LaunchReservation = {
  hypothesisId: string
  workerId: string | null
}

function unresolvedReservationCount(
  reservations: Iterable<LaunchReservation>
) {
  let count = 0
  for (const reservation of reservations) {
    if (!reservation.workerId) count += 1
  }
  return count
}

function sessionStopRequested({
  state,
  sessionId,
}: {
  state: Awaited<ReturnType<typeof readState>>
  sessionId: string
}) {
  const session = state.sessions?.[sessionId]
  return Boolean(
    session?.stopRequested || session?.status === "stop_requested"
  )
}

export async function commandResearchRun(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const requestedSessionId =
    args.options.session ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: args.options.campaign,
    })
  const hypotheses = await hypothesisPlansOption(args)
  if (requestedSessionId && hypotheses) {
    throw new Error(
      "--hypotheses can only be used when creating a new research session. Use `onyx research hypothesis add --session <id>` for an existing session."
    )
  }

  const sessionState = requestedSessionId
    ? await existingRunSession({ root, sessionId: requestedSessionId, args })
    : null
  const campaignInfo = sessionState ? null : await campaignForName(root, args)
  const campaign = sessionState?.campaign ?? campaignInfo!.campaign
  const effectiveProjectPath = campaignInfo?.projectPath ?? projectPath
  const { setup } = await assertLocalSetupReady(root, effectiveProjectPath)
  await assertSetupCommitted({
    root,
    projectPath: effectiveProjectPath,
    baseCommitSha: campaign.baseCommitSha,
    requireBaseMatchesHead: true,
  })
  await assertMainWorktreeClean(root, "before running research")

  const agentKind = workerAgentOption(args)
  const sessionAgentKind = args.options["worker-command"] ? "custom" : agentKind
  const sessionMetadata = sessionState?.session.metadata ?? {}
  const maxIterations = positiveIntegerOption(
    args,
    "max-iterations",
    typeof sessionMetadata.maxIterations === "number"
      ? sessionMetadata.maxIterations
      : 10
  )
  const maxMinutes = positiveNumberOption(
    args,
    "max-minutes",
    typeof sessionMetadata.maxMinutes === "number"
      ? sessionMetadata.maxMinutes
      : 120
  )
  const workerFallback = sessionState
    ? (sessionState.session.workerTarget ?? 1)
    : (hypotheses?.length ?? 1)
  const workerTarget = supervisorWorkerTarget(args, workerFallback)
  const sessionTarget = sessionState?.session.workerTarget ?? workerTarget
  if (workerTarget > sessionTarget) {
    throw new Error(
      `Session ${sessionState?.session.id} has ${sessionTarget} worker slot(s). Create a new session with --workers ${workerTarget}, or omit --session.`
    )
  }
  const maxConcurrency = positiveIntegerOption(
    args,
    "max-concurrency",
    workerTarget
  )
  if (maxConcurrency > MAX_LOCAL_SUPERVISOR_WORKERS) {
    throw new Error(
      `--max-concurrency is capped at ${MAX_LOCAL_SUPERVISOR_WORKERS}`
    )
  }
  const maxLaunches = optionalPositiveIntegerOption(args, "max-launches")

  const now = Date.now()
  const existingEndTime =
    requestedSessionId && state.sessions?.[requestedSessionId]?.endTimeMs
  const endTimeMs =
    args.options["max-minutes"] === undefined &&
    typeof existingEndTime === "number" &&
    existingEndTime > now
      ? existingEndTime
      : now + maxMinutes * 60_000
  const sessionBudgetMs = Math.max(1, endTimeMs - now)
  const shutdownCushionMs = workerShutdownCushionMs(sessionBudgetMs)
  const hardStopGraceMs = workerHardStopGraceMs(shutdownCushionMs)
  const hardEndTimeMs = endTimeMs + hardStopGraceMs
  const workerTimeoutMs =
    positiveNumberOption(
      args,
      "worker-timeout",
      (sessionBudgetMs + hardStopGraceMs) / 1000
    ) * 1000
  const startupTimeoutMs =
    nonnegativeNumberOption(args, "startup-timeout", 90) * 1000
  const stopGraceMs =
    nonnegativeNumberOption(args, "stop-grace-seconds", 30) * 1000
  const syncIntervalMs = positiveNumberOption(args, "sync-interval", 5) * 1000
  const presenceIntervalMs =
    positiveNumberOption(args, "presence-interval", 5) * 1000
  const finalSyncTimeoutMs =
    positiveNumberOption(args, "final-sync-timeout", 120) * 1000

  let sessionId = requestedSessionId
  let initialHypotheses = sessionState?.hypotheses ?? []
  if (!sessionId) {
    const result = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: args.options.name ?? `research-${new Date().toISOString()}`,
      workerTarget,
      hypotheses,
      maxIterations,
      endTimeMs,
      metadata: {
        startedBy: "onyx-research-supervisor",
        maxIterations,
        maxMinutes,
        agentKind: sessionAgentKind,
        maxConcurrency,
        ...(maxLaunches ? { maxLaunches } : {}),
        presenceIntervalSeconds: presenceIntervalMs / 1000,
        syncIntervalSeconds: syncIntervalMs / 1000,
      },
    })
    sessionId = result.session.id
    initialHypotheses = result.hypotheses
  }

  const nextState = await readState(root)
  const key = campaignStateKey(effectiveProjectPath, campaign.name)
  nextState.campaigns = nextState.campaigns ?? {}
  nextState.campaigns[key] = {
    ...nextState.campaigns[key],
    campaignId: campaign.id,
    sessionId,
  }
  nextState.sessions = nextState.sessions ?? {}
  nextState.sessions[sessionId] = {
    ...(nextState.sessions[sessionId] ?? {}),
    campaignName: campaign.name,
    campaignId: campaign.id,
    endTimeMs,
    maxIterations,
    status: "running",
  }
  await writeState(root, nextState)

  await Promise.all(
    initialHypotheses.map((hypothesis) =>
      Promise.all([
        writeBrief({
          root,
          campaignId: campaign.id,
          sessionId,
          hypothesis,
          args,
        }),
        writeSessionState({ root, sessionId, hypothesis, args }).catch(
          () => null
        ),
      ])
    )
  )

  await emitEvent(root, {
    type: "research_started",
    campaignName: campaign.name,
    campaignId: campaign.id,
    sessionId,
    message: `supervisor target ${workerTarget}, concurrency ${maxConcurrency}`,
  })

  const syncSupervisor = createSyncSupervisor({
    root,
    args,
    intervalMs: syncIntervalMs,
  })
  const presenceSupervisor = createPresenceSupervisor({
    root,
    args,
    sessionId,
    projectPath: effectiveProjectPath,
    intervalMs: presenceIntervalMs,
  })
  syncSupervisor.request()
  presenceSupervisor.request()

  const activeRuns = new Map<string, Promise<HypothesisRunResult>>()
  const launchReservations = new Map<string, LaunchReservation>()
  let launched = 0
  let completed = 0
  let failed = 0
  let stopped = 0
  let waitingLogged = false

  console.log(`Research supervisor: ${sessionId}`)
  console.log(`Campaign: ${campaign.name}`)
  console.log(
    `Workers: target=${workerTarget} concurrency=${maxConcurrency}${
      maxLaunches ? ` maxLaunches=${maxLaunches}` : ""
    }`
  )
  console.log(`Agent: ${args.options["worker-command"] ? "custom" : agentKind}`)
  console.log(`Presence: every ${presenceIntervalMs / 1000}s`)
  console.log(`Sync: every ${syncIntervalMs / 1000}s`)

  let supervisorLoopCompleted = false
  try {
    while (Date.now() < hardEndTimeMs) {
      const shouldStop = await harnessShouldStopSession({
        root,
        sessionId,
        args,
      }).catch(() => false)
      const launchLimitReached =
        maxLaunches !== null && launched >= maxLaunches
      if (shouldStop || Date.now() >= endTimeMs || launchLimitReached) {
        if (activeRuns.size === 0) break
        await Promise.race([
          ...activeRuns.values(),
          sleep(Math.min(5000, Math.max(1, hardEndTimeMs - Date.now()))),
        ])
        continue
      }

      const latest = await getLocalSessionState(root, sessionId).catch(() =>
        getResearchSessionState(sessionId, args)
      )
      if (latest.session.status !== "running") break
      const activeWorkers = activeSessionWorkers({
        workers: latest.workers,
        sessionId,
      }).length
      const openSlots = Math.max(
        0,
        workerTarget -
          activeWorkers -
          unresolvedReservationCount(launchReservations.values())
      )
      const concurrencySlots = Math.max(0, maxConcurrency - activeRuns.size)
      const launchCapSlots =
        maxLaunches === null ? Number.POSITIVE_INFINITY : maxLaunches - launched
      const launchSlots = Math.min(openSlots, concurrencySlots, launchCapSlots)
      let launchedThisTick = 0

      for (let index = 0; index < launchSlots; index += 1) {
        const refreshed = await getLocalSessionState(root, sessionId).catch(
          () => getResearchSessionState(sessionId, args)
        )
        const activeCount = activeSessionWorkers({
          workers: refreshed.workers,
          sessionId,
        }).length + unresolvedReservationCount(launchReservations.values())
        if (
          activeCount >= workerTarget ||
          activeRuns.size >= maxConcurrency ||
          (maxLaunches !== null && launched >= maxLaunches) ||
          refreshed.session.status !== "running"
        ) {
          break
        }
        const hypothesis = chooseSupervisorHypothesis({
          hypotheses: refreshed.hypotheses,
          workers: refreshed.workers.filter(
            (worker) => worker.sessionId === sessionId
          ),
          reservations: [...launchReservations.values()],
        })
        if (!hypothesis) break

        waitingLogged = false
        launched += 1
        launchedThisTick += 1
        const runKey = `${Date.now()}:${launched}:${hypothesis.id}`
        launchReservations.set(runKey, {
          hypothesisId: hypothesis.id,
          workerId: null,
        })
        const run = runHypothesisOnce({
          root,
          projectPath: effectiveProjectPath,
          campaign,
          setup,
          sessionId,
          hypothesis,
          workerCommand: args.options["worker-command"],
          agentKind,
          maxIterations,
          endTimeMs,
          hardEndTimeMs,
          workerTimeoutMs,
          startupTimeoutMs,
          stopGraceMs,
          quiet: args.options.quiet === "true",
          syncSupervisor,
          onRegistered: ({ workerId }) => {
            const reservation = launchReservations.get(runKey)
            if (!reservation) return
            launchReservations.set(runKey, {
              ...reservation,
              workerId,
            })
          },
          args,
        })
          .then(async (result) => {
            if (result.workerId) {
              await recordLocalWorkerHeartbeat({
                root,
                workerId: result.workerId,
                status: result.status,
                sessionId,
                hypothesisId: result.hypothesis.id,
                phase: result.status,
                event: "final_sync_started",
                progressMessage: `Final sync queued after ${result.hypothesis.name}`,
                gitLabel: result.resultCommitSha ?? null,
              }).catch(() => {})
            }
            if (result.status === "completed") completed += 1
            else if (result.status === "stopped") stopped += 1
            else failed += 1
            return result
          })
          .catch((error) => {
            failed += 1
            console.warn(
              `worker failed: ${error instanceof Error ? error.message : String(error)}`
            )
            return {
              hypothesis,
              status: "failed" as const,
              error: error instanceof Error ? error.message : String(error),
            }
          })
          .finally(() => {
            activeRuns.delete(runKey)
            launchReservations.delete(runKey)
            syncSupervisor.request()
            presenceSupervisor.request()
          })
        activeRuns.set(runKey, run)
        presenceSupervisor.request()
      }

      if (launchedThisTick === 0) {
        if (activeRuns.size === 0 && !waitingLogged) {
          waitingLogged = true
          console.log(
            "Supervisor waiting for active hypotheses or open worker slots."
          )
        }
        if (activeRuns.size > 0) {
          await Promise.race([...activeRuns.values(), sleep(2000)])
        } else {
          await sleep(3000)
        }
      }
    }

    if (activeRuns.size > 0) {
      console.log(`Waiting for ${activeRuns.size} active worker(s) to finish.`)
      await Promise.allSettled(activeRuns.values())
    }
    supervisorLoopCompleted = true
  } finally {
    presenceSupervisor.request()
    await presenceSupervisor.stop()
    if (!supervisorLoopCompleted) syncSupervisor.stop()
  }

  const finalState = await readState(root)
  const explicitStop = sessionStopRequested({ state: finalState, sessionId })
  const finalStatus = explicitStop ? "stopped" : "completed"
  finalState.sessions = finalState.sessions ?? {}
  finalState.sessions[sessionId] = {
    ...(finalState.sessions[sessionId] ?? {}),
    campaignName: campaign.name,
    campaignId: campaign.id,
    status: finalStatus,
    stopRequested: false,
  }
  await writeState(root, finalState)
  await stopLocalSession({
    root,
    sessionId,
    status: finalStatus,
    reason: explicitStop ? "stop requested" : "research run completed",
  }).catch(() => {})
  await refreshSessionStateFiles({ root, sessionId, args }).catch(() => {})
  presenceSupervisor.request()
  await presenceSupervisor.stop()
  const pending = await syncSupervisor.drain(finalSyncTimeoutMs)

  console.log(
    `Research run ${finalStatus}: launched=${launched}${
      maxLaunches ? `/${maxLaunches}` : ""
    } completed=${completed} failed=${failed} stopped=${stopped}; ${pending} sync record(s) pending.`
  )
}

export async function commandWorkerRun(args: Args) {
  if (args.options.lane) {
    throw new Error(
      "Use --hypothesis <id>; lanes have been replaced by hypotheses."
    )
  }
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    process.env.ONYX_SESSION_ID ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: args.options.campaign,
    })
  if (!sessionId) {
    throw new Error("Pass --session <id> or start a research session first.")
  }

  const sessionState = await getLocalSessionState(root, sessionId).catch(() =>
    getResearchSessionState(sessionId, args)
  )
  if (sessionState.session.status !== "running") {
    throw new Error(
      `Research session ${sessionId} is ${sessionState.session.status}; cannot start a new worker.`
    )
  }
  const campaign = sessionState.campaign
  const { setup } = await assertLocalSetupReady(root, projectPath)
  await assertMainWorktreeClean(root, "before launching a worker")

  const requestedHypothesisId =
    args.options.hypothesis ?? process.env.ONYX_HYPOTHESIS_ID
  const hypothesis =
    (requestedHypothesisId
      ? sessionState.hypotheses.find(
          (item) => item.id === requestedHypothesisId
        )
      : sessionState.hypotheses.find((item) => item.status === "active")) ??
    null
  if (!hypothesis) {
    throw new Error(
      requestedHypothesisId
        ? `Hypothesis ${requestedHypothesisId} was not found in campaign ${campaign.name}.`
        : `No available hypothesis found in session ${sessionId}.`
    )
  }
  if (hypothesis.status !== "active") {
    throw new Error(
      `Hypothesis ${hypothesis.name} is ${hypothesis.status}; only active hypotheses can receive new workers.`
    )
  }

  const sessionMetadata = sessionState.session.metadata
  const maxIterations = positiveIntegerOption(
    args,
    "max-iterations",
    typeof sessionMetadata.maxIterations === "number"
      ? sessionMetadata.maxIterations
      : 10
  )
  const maxMinutes = positiveNumberOption(
    args,
    "max-minutes",
    typeof sessionMetadata.maxMinutes === "number"
      ? sessionMetadata.maxMinutes
      : 120
  )
  const sessionBudgetMs = maxMinutes * 60_000
  const shutdownCushionMs = workerShutdownCushionMs(sessionBudgetMs)
  const hardStopGraceMs = workerHardStopGraceMs(shutdownCushionMs)
  const workerTimeoutMs =
    positiveNumberOption(
      args,
      "worker-timeout",
      (sessionBudgetMs + hardStopGraceMs) / 1000
    ) * 1000
  const startupTimeoutMs =
    nonnegativeNumberOption(args, "startup-timeout", 90) * 1000
  const stopGraceMs =
    nonnegativeNumberOption(args, "stop-grace-seconds", 30) * 1000
  const syncIntervalMs = positiveNumberOption(args, "sync-interval", 5) * 1000
  const finalSyncTimeoutMs =
    positiveNumberOption(args, "final-sync-timeout", 120) * 1000
  const syncSupervisor = createSyncSupervisor({
    root,
    args,
    intervalMs: syncIntervalMs,
  })

  const result = await runHypothesisOnce({
    root,
    projectPath,
    campaign,
    setup,
    sessionId,
    hypothesis,
    workerCommand: args.options["worker-command"],
    agentKind: args.options.agent ?? "codex",
    maxIterations,
    endTimeMs: Date.now() + sessionBudgetMs,
    hardEndTimeMs: Date.now() + sessionBudgetMs + hardStopGraceMs,
    workerTimeoutMs,
    startupTimeoutMs,
    stopGraceMs,
    quiet: args.options.quiet === "true",
    syncSupervisor,
    args,
  })
  if (result.workerId) {
    await recordLocalWorkerHeartbeat({
      root,
      workerId: result.workerId,
      status: result.status,
      sessionId,
      hypothesisId: hypothesis.id,
      phase: "syncing",
      event: "final_sync_started",
      progressMessage: `Draining final sync for ${hypothesis.name}`,
      gitLabel: result.resultCommitSha ?? null,
    }).catch(() => {})
  }
  const pending = await syncSupervisor.drain(finalSyncTimeoutMs)
  if (result.status === "failed") {
    throw new Error(
      `Worker failed for ${hypothesis.name}: ${result.error ?? "unknown error"}`
    )
  }
  console.log(
    `Worker ${result.status} ${hypothesis.name} at ${result.resultCommitSha ?? "unknown"}; ${pending} sync record(s) pending.`
  )
}
