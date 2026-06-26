import type {
  CreateResearchCampaignExperimentRequest,
  CreateResearchCampaignRequest,
  ResearchHypothesisPlan,
  ResearchSetupCompliance,
} from "../protocol"

import type { Args } from "./args"
import { apiBaseUrl, apiKey } from "./config"
import { normalizeRepositoryUrl, repositoryUrl } from "./git"
import { readState, updateState } from "./outbox"
import { resolveProjectPath } from "./project"

export type ApiProject = {
  id: string
  name: string
  repositoryUrl: string
  repositoryFullName: string | null
  defaultBranch: string
  projectPath: string
}

export type ApiCampaign = {
  id: string
  projectId: string
  parentCampaignId?: string | null
  name: string
  description: string | null
  baseCommitSha: string
  status?: "active" | "completed" | "archived"
  metricName: string
  metricUnit: string | null
  metricDirection: "maximize" | "minimize"
  bestExperimentId?: string | null
  bestMetricValue: number | null
  bestCommitSha: string | null
  experimentCount: number
  lastExperimentAt?: string | null
  promotionRefName: string | null
  createdAt?: string
  updatedAt?: string
}

export type ApiCampaignExperiment = {
  id: string
  campaignId: string
  sessionId: string | null
  hypothesisId: string | null
  workerId: string | null
  runRef: string
  name: string
  description: string | null
  baseCommitSha: string
  resultCommitSha: string
  resultRef: string
  status: string
  setupCompliance: ResearchSetupCompliance | null
  gitStatus: string
  gitVerifiedAt: string | null
  gitStatusReason: string | null
  primaryMetricName: string
  primaryMetricValue: number | null
  secondaryMetrics: Record<string, unknown>
  artifactRefs: Record<string, unknown>
  agentNotes: Record<string, unknown>
  checks: {
    status: "passed" | "failed" | "timed_out"
    durationMs: number | null
    outputSummary: string | null
  } | null
  durationMs: number | null
  outputSummary: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ApiSession = {
  id: string
  campaignId: string
  name: string
  status: "running" | "stop_requested" | "completed" | "failed" | "stopped"
  workerTarget: number | null
  maxExperiments: number | null
  reservedExperimentCount: number
  terminalExperimentCount: number
  finalizationStatus:
    | "not_started"
    | "running"
    | "complete"
    | "incomplete"
    | "failed"
  metadata: Record<string, unknown>
  startedAt?: string
  completedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export type ApiWorker = {
  id: string
  campaignId: string
  sessionId: string | null
  hypothesisId: string
  workerName: string
  agentKind: string
  runtime: "local" | "hosted"
  status: "registered" | "running" | "completed" | "failed" | "stopped"
  liveness?: "active" | "stale" | "lost" | "unknown" | "terminal"
  currentExperimentId: string | null
  phase: string | null
  progressMessage: string | null
  gitLabel: string | null
  lastSeenAt: string
  startedAt: string
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ApiHypothesis = {
  id: string
  campaignId: string
  createdBySessionId: string | null
  name: string
  description: string | null
  status: "active" | "paused" | "retired"
  baseCommitSha: string
  bestExperimentId: string | null
  bestMetricValue: number | null
  lastWorkedAt: string | null
  plan: ResearchHypothesisPlan
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ApiSummary = {
  id: string
  campaignId: string
  sessionId: string | null
  hypothesisId: string | null
  authoredByWorkerId: string | null
  summaryKind:
    | "campaign_brief"
    | "session_brief"
    | "hypothesis_summary"
    | "transfer_brief"
    | "setup_notes"
  title: string
  body: string
  isCurrent: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ApiKnowledge = {
  id: string
  campaignId: string
  sessionId: string | null
  hypothesisId: string | null
  authoredByWorkerId: string | null
  experimentId: string | null
  kind:
    | "insight"
    | "dead_end"
    | "promising_direction"
    | "risk"
    | "transfer_note"
  title: string
  body: string
  confidence: number | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ApiCampaignTimeline = {
  campaign: ApiCampaign
  workers: ApiWorker[]
  hypotheses: ApiHypothesis[]
  summaries: ApiSummary[]
  knowledge: ApiKnowledge[]
}

export type ApiCampaignOverview = ApiCampaignTimeline & {
  bestExperiment: ApiCampaignExperiment | null
  latestExperiments: ApiCampaignExperiment[]
  sessions: ApiSession[]
  counts: {
    experiments: number
    hypothesisCount: number
    activeWorkers: number
  }
}

export type ApiSessionState = {
  session: ApiSession
  campaign: ApiCampaign
  latestExperiments: ApiCampaignExperiment[]
  bestExperiment: ApiCampaignExperiment | null
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
  summaries: ApiSummary[]
  knowledge: ApiKnowledge[]
  updatedAt: string
}

export type ApiSessionLive = {
  session: ApiSession
  campaign: ApiCampaign
  budget: {
    maxExperiments: number | null
    reservedCount: number
    terminalCount: number
    remainingCount: number | null
    openReservationCount: number
    expiredReservationCount: number
  }
  livenessCounts: Record<string, number>
  phaseCounts: Record<string, number>
  workers: Array<{
    id: string
    status: ApiWorker["status"]
    liveness: "active" | "stale" | "lost" | "unknown" | "terminal"
    phase: string | null
    progressMessage: string | null
    gitLabel: string | null
    lastOutputAt: string | null
    activitySummary: Record<string, unknown>
    receivedAt: string
    matched: boolean
  }>
  sites: Array<{
    siteId: string
    supervisorRunId: string | null
    liveness: "active" | "stale" | "lost"
    lastSequence: number
    pendingSyncCount: number
    pushQueueDepth: number
    activeWorkerCount: number
    syncLagMs: number | null
    providerBackoff: Record<string, unknown> | null
    ignoredPresence: Record<string, unknown>
    lastUploadAt: string | null
    receivedAt: string
  }>
  unmatchedPresenceCount: number
  ignoredPresence: Record<string, unknown>
  syncLagMs: number | null
  providerBackoff: Record<string, unknown> | null
  recentExperiments: ApiCampaignExperiment[]
  recentTerminalWorkers: Array<{
    id: string
    status: ApiWorker["status"]
    liveness: "active" | "stale" | "lost" | "unknown" | "terminal"
    phase: string | null
    progressMessage: string | null
    gitLabel: string | null
    lastOutputAt: string | null
    activitySummary: Record<string, unknown>
    receivedAt: string
    matched: boolean
  }>
  liveWatermark: string
  updatedAt: string
}

export type ApiCampaignUpsertResult = {
  project: ApiProject
  campaign: ApiCampaign
}

export type ApiProjectDeletions = {
  campaigns: Array<{
    campaignId: string
    name: string
    deletedAt: string
  }>
  experiments: Array<{
    experimentId: string
    runRef: string
    campaignId: string
    campaignName: string
    deletedAt: string
  }>
}

export type ApiResearchSyncEvent = {
  eventId: string
  sequence: number
  type: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
  createdAt: string
}

export type ApiResearchSyncResponse = {
  accepted: number
  duplicate: number
  conflicts: number
  invalid: number
  acknowledgements: Array<{
    eventId: string
    sequence: number
    status: "acked" | "duplicate" | "conflict" | "invalid"
    code: string
    entityType: string
    entityId: string | null
    message: string | null
    details: Record<string, unknown>
  }>
  tombstones: Array<{
    entityType: string
    entityId: string
    campaignId: string | null
    name: string | null
    runRef: string | null
    deletedAt: string
    reason: string | null
  }>
  projectionDeltas: {
    campaigns: ApiCampaign[]
    sessions: ApiSession[]
    hypotheses: ApiHypothesis[]
    workers: ApiWorker[]
    experiments: ApiCampaignExperiment[]
    summaries: ApiSummary[]
    knowledge: ApiKnowledge[]
  }
}

export type ApiResearchPresenceResponse = {
  ignoredWorkers: Array<{
    id: string
    reason:
      | "not_found"
      | "session_mismatch"
      | "stale_sequence"
      | "unmatched_cap"
      | "update_failed"
    message: string
  }>
  ignoredByReason: {
    notFound: number
    sessionMismatch: number
    staleSequence: number
    unmatchedCap: number
    updateFailed: number
  }
  acceptedCount: number
  ignoredCount: number
  unmatchedCount: number
  siteAccepted: boolean
}

export type ApiReconcileCampaignResponse = {
  campaign: ApiCampaign
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
  experiments: ApiCampaignExperiment[]
  gitVerification: {
    checkedCount: number
    updatedCount: number
    remainingCount: number
    limit: number
    hasMore: boolean
  }
}

export async function callApi(
  method: string,
  path: string,
  body?: unknown,
  args?: Args
) {
  const timeoutMs = Number(args?.options["api-timeout"] ?? 30_000)
  const signal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined
  const response = await fetch(`${await apiBaseUrl(args)}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await apiKey(args)}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })

  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }

  if (!response.ok) {
    throw new ApiError(method, path, response.status, payload)
  }

  return payload
}

export class ApiError extends Error {
  status: number

  constructor(method: string, path: string, status: number, payload: unknown) {
    super(
      `${method} ${path} failed (${status}): ${
        typeof payload === "string" ? payload : JSON.stringify(payload)
      }`
    )
    this.name = "ApiError"
    this.status = status
  }
}

export function apiData<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw new Error(`Unexpected API response: ${JSON.stringify(payload)}`)
  }
  return (payload as { data: T }).data
}

export async function resolveProject(
  root: string,
  args: Args
): Promise<ApiProject> {
  const projectPath = await resolveProjectPath(root, args)
  if (args.options.project) {
    return {
      id: args.options.project,
      name: args.options.project,
      repositoryUrl: "",
      repositoryFullName: null,
      defaultBranch: "main",
      projectPath,
    }
  }

  const url = normalizeRepositoryUrl(
    await repositoryUrl(root, args.options["repository-url"])
  )
  const state = await readState(root).catch(() => null)
  if (
    state?.projectCache &&
    state.projectCache.repositoryUrl === url &&
    state.projectCache.projectPath === projectPath
  ) {
    return {
      id: state.projectCache.id,
      name: state.projectCache.name,
      repositoryUrl: state.projectCache.repositoryUrl,
      repositoryFullName: state.projectCache.repositoryFullName,
      defaultBranch: state.projectCache.defaultBranch,
      projectPath: state.projectCache.projectPath,
    }
  }
  const params = new URLSearchParams({ repositoryUrl: url, projectPath })
  try {
    const project = apiData<ApiProject>(
      await callApi(
        "GET",
        `/api/v1/research/projects/resolve?${params.toString()}`,
        undefined,
        args
      )
    )
    await updateState(root, (state) => {
      state.projectId = project.id
      state.projectPath = projectPath
      state.projectCache = {
        id: project.id,
        name: project.name,
        repositoryUrl: url,
        repositoryFullName: project.repositoryFullName,
        defaultBranch: project.defaultBranch,
        projectPath,
        resolvedAt: new Date().toISOString(),
        lastDeletionFetchAt:
          state.projectCache?.repositoryUrl === url &&
          state.projectCache?.projectPath === projectPath
            ? state.projectCache.lastDeletionFetchAt
            : undefined,
      }
    }).catch(() => {})
    return project
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403) {
        throw new Error(
          `Onyx API could not resolve this repository because authentication failed (${error.status}). Run \`onyx status\` and refresh or switch profiles.`
        )
      }
      if (error.status !== 404) {
        throw new Error(
          `Onyx API project resolve failed (${error.status}). ${error.message}`
        )
      }
    }
    throw new Error(
      "No Onyx project is tracking this repository yet. Start a campaign with `onyx campaign setup`, or grant Onyx GitHub access to this repository and sync again."
    )
  }
}

export async function upsertCampaign(
  body: CreateResearchCampaignRequest,
  args?: Args
): Promise<ApiCampaignUpsertResult> {
  return apiData<ApiCampaignUpsertResult>(
    await callApi("POST", "/api/v1/research/campaigns", body, args)
  )
}

export async function listProjectCampaigns(
  projectId: string,
  args?: Args
): Promise<ApiCampaign[]> {
  return apiData<ApiCampaign[]>(
    await callApi(
      "GET",
      `/api/v1/research/projects/${projectId}/campaigns`,
      undefined,
      args
    )
  )
}

export async function getCampaignOverview(
  campaignId: string,
  args?: Args
): Promise<ApiCampaignOverview> {
  return apiData<ApiCampaignOverview>(
    await callApi(
      "GET",
      `/api/v1/research/campaigns/${campaignId}/overview`,
      undefined,
      args
    )
  )
}

export async function listCampaignExperiments(
  campaignId: string,
  args?: Args,
  options: { limit?: number; cursor?: string } = {}
): Promise<{
  items: ApiCampaignExperiment[]
  page: { nextCursor: string | null }
}> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 100),
  })
  if (options.cursor) params.set("cursor", options.cursor)
  return apiData<{
    items: ApiCampaignExperiment[]
    page: { nextCursor: string | null }
  }>(
    await callApi(
      "GET",
      `/api/v1/research/campaigns/${campaignId}/experiments?${params.toString()}`,
      undefined,
      args
    )
  )
}

export async function reportCampaignExperiment(
  campaignId: string,
  body: CreateResearchCampaignExperimentRequest,
  args?: Args
): Promise<ApiCampaignExperiment> {
  return apiData<ApiCampaignExperiment>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/experiments`,
      body,
      args
    )
  )
}

export async function reportCampaignExperimentsBatch(
  campaignId: string,
  experiments: CreateResearchCampaignExperimentRequest[],
  args?: Args
): Promise<{
  results: Array<{
    runRef: string
    status: "created" | "duplicate" | "deleted" | "invalid"
    experiment: ApiCampaignExperiment | null
    error: { code: string; message: string } | null
  }>
}> {
  return apiData<{
    results: Array<{
      runRef: string
      status: "created" | "duplicate" | "deleted" | "invalid"
      experiment: ApiCampaignExperiment | null
      error: { code: string; message: string } | null
    }>
  }>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/experiments/batch`,
      { experiments },
      args
    )
  )
}

export async function createCampaignSession(
  campaignId: string,
  body: {
    name: string
    workerTarget?: number
    hypotheses?: ResearchHypothesisPlan[]
    metadata?: Record<string, unknown>
    maxExperiments?: number
  },
  args?: Args
): Promise<{ session: ApiSession; hypotheses: ApiHypothesis[] }> {
  return apiData<{ session: ApiSession; hypotheses: ApiHypothesis[] }>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/sessions`,
      body,
      args
    )
  )
}

export async function listCampaignHypotheses(
  campaignId: string,
  args?: Args
): Promise<ApiHypothesis[]> {
  return apiData<ApiHypothesis[]>(
    await callApi(
      "GET",
      `/api/v1/research/campaigns/${campaignId}/hypotheses`,
      undefined,
      args
    )
  )
}

export async function createCampaignHypothesis(
  campaignId: string,
  body: {
    plan: ResearchHypothesisPlan
    name?: string
    description?: string
    baseCommitSha?: string
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<{ hypothesis: ApiHypothesis }> {
  return apiData<{ hypothesis: ApiHypothesis }>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/hypotheses`,
      body,
      args
    )
  )
}

export async function updateCampaignHypothesis(
  hypothesisId: string,
  body: {
    status?: ApiHypothesis["status"]
    plan?: ResearchHypothesisPlan
    description?: string | null
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<{ hypothesis: ApiHypothesis }> {
  return apiData<{ hypothesis: ApiHypothesis }>(
    await callApi(
      "PATCH",
      `/api/v1/research/hypotheses/${hypothesisId}`,
      body,
      args
    )
  )
}

export async function stopCampaignSession(
  sessionId: string,
  body: {
    campaignId: string
    status?: "stop_requested" | "completed" | "failed" | "stopped"
    finalizationStatus?: ApiSession["finalizationStatus"]
    reason?: string
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiSession> {
  return apiData<ApiSession>(
    await callApi(
      "POST",
      `/api/v1/research/sessions/${sessionId}/stop`,
      body,
      args
    )
  )
}

export async function getResearchSessionState(
  sessionId: string,
  args?: Args
): Promise<ApiSessionState> {
  return apiData<ApiSessionState>(
    await callApi(
      "GET",
      `/api/v1/research/sessions/${sessionId}/state`,
      undefined,
      args
    )
  )
}

export async function getResearchSessionLive(
  sessionId: string,
  args?: Args
): Promise<ApiSessionLive> {
  return apiData<ApiSessionLive>(
    await callApi(
      "GET",
      `/api/v1/research/sessions/${sessionId}/live`,
      undefined,
      args
    )
  )
}

export async function reconcileCampaign(
  campaignId: string,
  args?: Args
): Promise<ApiReconcileCampaignResponse> {
  return apiData<ApiReconcileCampaignResponse>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/reconcile`,
      {},
      args
    )
  )
}

export async function registerCampaignWorker(
  campaignId: string,
  body: {
    sessionId?: string
    hypothesisId: string
    workerName: string
    agentKind?: string
    runtime?: "local" | "hosted"
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiWorker> {
  return apiData<ApiWorker>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/workers`,
      body,
      args
    )
  )
}

export async function heartbeatWorker(
  workerId: string,
  body: {
    status?: "registered" | "running" | "completed" | "failed" | "stopped"
    sessionId?: string
    hypothesisId?: string
    experimentId?: string | null
    phase?: string | null
    event?: string | null
    progressMessage?: string | null
    gitLabel?: string | null
    resourceStats?: Record<string, unknown>
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<{ worker: ApiWorker }> {
  return apiData<{ worker: ApiWorker }>(
    await callApi(
      "POST",
      `/api/v1/research/workers/${workerId}/heartbeat`,
      body,
      args
    )
  )
}

export async function upsertCampaignSummary(
  campaignId: string,
  body: {
    sessionId?: string
    hypothesisId?: string
    authoredByWorkerId?: string
    summaryKind:
      | "campaign_brief"
      | "session_brief"
      | "hypothesis_summary"
      | "transfer_brief"
      | "setup_notes"
    title: string
    body: string
    isCurrent?: boolean
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiSummary> {
  return apiData<ApiSummary>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/summaries`,
      body,
      args
    )
  )
}

export async function createCampaignKnowledge(
  campaignId: string,
  body: {
    sessionId?: string
    hypothesisId?: string
    authoredByWorkerId?: string
    experimentId?: string
    kind: ApiKnowledge["kind"]
    title: string
    body: string
    confidence?: number | null
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiKnowledge> {
  return apiData<ApiKnowledge>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/knowledge`,
      body,
      args
    )
  )
}

export async function listCampaignKnowledge(
  campaignId: string,
  args?: Args
): Promise<ApiKnowledge[]> {
  return apiData<ApiKnowledge[]>(
    await callApi(
      "GET",
      `/api/v1/research/campaigns/${campaignId}/knowledge`,
      undefined,
      args
    )
  )
}

export async function requestProjectSync(projectId: string, args?: Args) {
  await callApi(
    "POST",
    `/api/v1/research/projects/${projectId}/sync`,
    undefined,
    args
  )
}

export async function getProjectDeletions(
  projectId: string,
  args?: Args
): Promise<ApiProjectDeletions> {
  return apiData<ApiProjectDeletions>(
    await callApi(
      "GET",
      `/api/v1/research/projects/${projectId}/deletions`,
      undefined,
      args
    )
  )
}

export async function syncResearchEvents(
  body: {
    siteId: string
    repositoryUrl: string
    projectPath: string
    pushedExperimentRefs?: Array<{
      campaignId: string
      runRef: string
      resultRef: string
      resultCommitSha: string
    }>
    events: ApiResearchSyncEvent[]
  },
  args?: Args
): Promise<ApiResearchSyncResponse> {
  return apiData<ApiResearchSyncResponse>(
    await callApi("POST", "/api/v1/research/sync", body, args)
  )
}

export async function syncResearchPresence(
  body: {
    siteId: string
    supervisorRunId: string
    sequence: number
    sessionId: string
    site?: {
      providerBackoff?: Record<string, unknown> | null
      syncLagMs?: number | null
      pendingSyncCount?: number
      pushQueueDepth?: number
      ignoredPresence?: Record<string, unknown>
      activeWorkerCount?: number
      lastUploadAt?: string | null
      metadata?: Record<string, unknown>
    }
    workers: Array<{
      id: string
      status: ApiWorker["status"]
      phase?: string | null
      progressMessage?: string | null
      gitLabel?: string | null
      currentExperimentId?: string | null
      lastOutputAt?: string | null
      activitySummary?: Record<string, unknown>
      metadata?: Record<string, unknown>
      observedAt: string
    }>
  },
  args?: Args
): Promise<ApiResearchPresenceResponse> {
  return apiData<ApiResearchPresenceResponse>(
    await callApi("POST", "/api/v1/research/presence", body, args)
  )
}

export async function reserveResearchExperiment(
  sessionId: string,
  body: {
    runRef: string
    workerId?: string
    hypothesisId?: string
    ttlSeconds?: number
  },
  args?: Args
): Promise<{
  reservationStatus:
    | "reserved"
    | "duplicate"
    | "renewed"
    | "budget_exhausted"
    | "session_terminal"
  reservation: {
    id: string
    runRef: string
    status: "reserved" | "consumed" | "released" | "expired"
    expiresAt: string
  } | null
  budget: {
    maxExperiments: number | null
    reservedCount: number
    terminalCount: number
    remainingCount: number | null
  }
}> {
  return apiData(
    await callApi(
      "POST",
      `/api/v1/research/sessions/${sessionId}/experiment-reservations`,
      body,
      args
    )
  )
}

export async function deleteCampaign(campaignId: string, args?: Args) {
  return apiData<{
    campaignId: string
    projectId: string
    deleted: true
    alreadyDeleted: boolean
    deletedExperimentCount: number
  }>(
    await callApi(
      "DELETE",
      `/api/v1/research/campaigns/${campaignId}`,
      undefined,
      args
    )
  )
}

export async function deleteCampaignExperiment(
  experimentId: string,
  args?: Args
) {
  return apiData<{
    experimentId: string
    campaignId: string
    projectId: string
    deleted: true
    alreadyDeleted: boolean
    campaign: ApiCampaign | null
  }>(
    await callApi(
      "DELETE",
      `/api/v1/research/experiments/${experimentId}`,
      undefined,
      args
    )
  )
}
