import type {
  CreateResearchCampaignExperimentRequest,
  CreateResearchCampaignRequest,
  ResearchContractCompliance,
  ResearchLanePlan,
  ResearchSetupContract,
} from "../protocol"

import type { Args } from "./args"
import { apiBaseUrl, apiKey } from "./config"
import { normalizeRepositoryUrl, repositoryUrl } from "./git"
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
  name: string
  description: string | null
  baseCommitSha: string
  phase: "setup" | "research"
  activeSetupId: string | null
  metricName: string
  metricUnit: string | null
  metricDirection: "maximize" | "minimize"
  bestMetricValue: number | null
  bestCommitSha: string | null
  experimentCount: number
  promotionRefName: string | null
}

export type ApiSetup = {
  id: string
  campaignId: string
  version: number
  status: "draft" | "validated" | "superseded"
  goal: string | null
  metricName: string
  metricUnit: string | null
  metricDirection: "maximize" | "minimize"
  contract: ResearchSetupContract
  contractHash: string
  humanFeedback: string | null
  setupCommitSha: string
  baselineExperimentId: string | null
  validatedAt: string | null
  metadata: Record<string, unknown>
}

export type ApiCampaignExperiment = {
  id: string
  campaignId: string
  setupId: string
  sessionId: string | null
  laneId: string | null
  workerId: string | null
  runRef: string
  name: string
  description: string | null
  baseCommitSha: string
  resultCommitSha: string
  resultRef: string
  status: string
  contractHash: string | null
  contractCompliance: ResearchContractCompliance | null
  gitStatus: string
  gitVerifiedAt: string | null
  gitStatusReason: string | null
  primaryMetricName: string
  primaryMetricValue: number | null
  secondaryMetrics: Record<string, unknown>
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
}

export type ApiSession = {
  id: string
  campaignId: string
  name: string
  status:
    | "running"
    | "stop_requested"
    | "completed"
    | "failed"
    | "stopped"
  workerTarget: number | null
  metadata: Record<string, unknown>
}

export type ApiWorker = {
  id: string
  campaignId: string
  sessionId: string | null
  laneId: string | null
  workerName: string
  status: "idle" | "running" | "stale" | "lost" | "stopped"
  currentExperimentId: string | null
  phase: string | null
  progressMessage: string | null
  gitLabel: string | null
  lastSeenAt: string
}

export type ApiLane = {
  id: string
  campaignId: string
  setupId: string
  sessionId: string | null
  name: string
  description: string | null
  status: "active" | "claimed" | "stale" | "lost" | "completed"
  branchRef: string
  baseCommitSha: string
  currentCommitSha: string | null
  bestExperimentId: string | null
  bestMetricValue: number | null
  currentWorkerId: string | null
  plan: ResearchLanePlan
  metadata: Record<string, unknown>
}

export type ApiSummary = {
  id: string
  campaignId: string
  sessionId: string | null
  laneId: string | null
  setupId: string | null
  authoredByWorkerId: string | null
  summaryKind:
    | "campaign_brief"
    | "session_brief"
    | "lane_summary"
    | "transfer_brief"
    | "setup_notes"
  title: string
  body: string
  isCurrent: boolean
}

export type ApiKnowledge = {
  id: string
  campaignId: string
  sessionId: string | null
  laneId: string | null
  setupId: string | null
  authoredByWorkerId: string | null
  experimentId: string | null
  kind: "insight" | "dead_end" | "promising_direction" | "risk" | "transfer_note"
  title: string
  body: string
  confidence: number | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ApiCampaignTimeline = {
  campaign: ApiCampaign
  activeSetup: ApiSetup | null
  workers: ApiWorker[]
  lanes: ApiLane[]
  summaries: ApiSummary[]
  knowledge: ApiKnowledge[]
}

export type ApiCampaignOverview = ApiCampaignTimeline & {
  bestExperiment: ApiCampaignExperiment | null
  latestExperiments: ApiCampaignExperiment[]
  counts: {
    experiments: number
    activeLanes: number
    activeWorkers: number
  }
}

export type ApiSessionState = {
  session: ApiSession
  campaign: ApiCampaign
  activeSetup: ApiSetup | null
  latestExperiments: ApiCampaignExperiment[]
  bestExperiment: ApiCampaignExperiment | null
  lanes: ApiLane[]
  workers: ApiWorker[]
  summaries: ApiSummary[]
  knowledge: ApiKnowledge[]
  updatedAt: string
}

export type ApiCampaignUpsertResult = {
  project: ApiProject
  campaign: ApiCampaign
  setup: ApiSetup
}

export type ApiBrief = {
  campaign: ApiCampaign
  activeSetup: ApiSetup | null
  bestExperiment: ApiCampaignExperiment | null
  recentExperiments: ApiCampaignExperiment[]
  lanes: ApiLane[]
  workers: ApiWorker[]
  summaries: ApiSummary[]
  knowledge: ApiKnowledge[]
  recommendedContext: string[]
  markdown: string
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
  const params = new URLSearchParams({ repositoryUrl: url, projectPath })
  try {
    return apiData<ApiProject>(
      await callApi(
        "GET",
        `/api/v1/research/projects/resolve?${params.toString()}`,
        undefined,
        args
      )
    )
  } catch {
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
    lanePlans?: ResearchLanePlan[]
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<{ session: ApiSession; lanes: ApiLane[] }> {
  return apiData<{ session: ApiSession; lanes: ApiLane[] }>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/sessions`,
      body,
      args
    )
  )
}

export async function createCampaignSetup(
  campaignId: string,
  body: {
    setupContract: ResearchSetupContract
    humanFeedback?: string | null
    setupCommitSha?: string
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<{ campaign: ApiCampaign; setup: ApiSetup }> {
  return apiData<{ campaign: ApiCampaign; setup: ApiSetup }>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/setups`,
      body,
      args
    )
  )
}

export async function validateCampaignSetup(
  setupId: string,
  body: { baselineExperimentId: string },
  args?: Args
): Promise<{ campaign: ApiCampaign; setup: ApiSetup }> {
  return apiData<{ campaign: ApiCampaign; setup: ApiSetup }>(
    await callApi(
      "POST",
      `/api/v1/research/setups/${setupId}/validate`,
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

export async function registerCampaignWorker(
  campaignId: string,
  body: {
    sessionId?: string
    laneId?: string
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
    status?: "idle" | "running" | "stale" | "lost" | "stopped"
    sessionId?: string
    laneId?: string | null
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

export async function claimCampaignLane(
  laneId: string,
  body: { workerId: string },
  args?: Args
): Promise<{ lane: ApiLane }> {
  return apiData<{ lane: ApiLane }>(
    await callApi("POST", `/api/v1/research/lanes/${laneId}/claim`, body, args)
  )
}

export async function heartbeatCampaignLane(
  laneId: string,
  body: {
    workerId: string
    status?: "active" | "claimed" | "completed" | "lost"
    currentCommitSha?: string | null
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiLane> {
  return apiData<ApiLane>(
    await callApi(
      "POST",
      `/api/v1/research/lanes/${laneId}/heartbeat`,
      body,
      args
    )
  )
}

export async function upsertCampaignSummary(
  campaignId: string,
  body: {
    sessionId?: string
    laneId?: string
    setupId?: string
    authoredByWorkerId?: string
    summaryKind:
      | "campaign_brief"
      | "session_brief"
      | "lane_summary"
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
    laneId?: string
    setupId?: string
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

export async function getCampaignBrief(
  campaignId: string,
  args?: Args
): Promise<ApiBrief> {
  return apiData<ApiBrief>(
    await callApi(
      "GET",
      `/api/v1/research/campaigns/${campaignId}/brief`,
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
