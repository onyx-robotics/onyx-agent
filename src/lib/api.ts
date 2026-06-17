import type {
  CreateResearchCampaignExperimentRequest,
  CreateResearchCampaignRequest,
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
  metricName: string
  metricUnit: string | null
  metricDirection: "maximize" | "minimize"
  bestMetricValue: number | null
  bestCommitSha: string | null
  experimentCount: number
  promotionRefName: string | null
}

export type ApiCampaignExperiment = {
  id: string
  campaignId: string
  sessionId: string | null
  workerId: string | null
  taskId: string | null
  runRef: string
  name: string
  description: string | null
  baseCommitSha: string
  resultCommitSha: string
  resultRef: string
  status: string
  gitStatus: string
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
  status: string
  workerTarget: number | null
}

export type ApiWorker = {
  id: string
  campaignId: string
  sessionId: string | null
  workerName: string
  status: "idle" | "running" | "stale" | "lost" | "stopped"
  currentTaskId: string | null
  currentExperimentId: string | null
  phase: string | null
  progressMessage: string | null
  gitLabel: string | null
  lastSeenAt: string
}

export type ApiTask = {
  id: string
  campaignId: string
  sessionId: string | null
  title: string
  description: string | null
  status: "queued" | "leased" | "running" | "cancelled" | "expired" | "completed"
  baseCommitSha: string | null
  leasedByWorkerId: string | null
  leaseExpiresAt: string | null
  leaseVersion: number
  attemptCount: number
  maxAttempts: number
  resultExperimentId: string | null
  error: Record<string, unknown> | null
  metadata: Record<string, unknown>
}

export type ApiCampaignTimeline = {
  campaign: ApiCampaign
  experiments: ApiCampaignExperiment[]
  workers: ApiWorker[]
  tasks: ApiTask[]
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

export async function callApi(
  method: string,
  path: string,
  body?: unknown,
  args?: Args
) {
  const response = await fetch(`${await apiBaseUrl(args)}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await apiKey(args)}`,
    },
    body: body ? JSON.stringify(body) : undefined,
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
  const projects = apiData<ApiProject[]>(
    await callApi("GET", "/api/v1/research/projects", undefined, args)
  )

  if (args.options.project) {
    const byId = projects.find(
      (candidate) => candidate.id === args.options.project
    )
    if (byId) return byId
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
  const project = projects.find(
    (candidate) =>
      normalizeRepositoryUrl(candidate.repositoryUrl) === url &&
      candidate.projectPath === projectPath
  )

  if (!project) {
    throw new Error(
      "No Onyx project is tracking this repository yet. Start a campaign with `onyx campaign create`, or grant Onyx GitHub access to this repository and sync again."
    )
  }

  return project
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

export async function getCampaignTimeline(
  campaignId: string,
  args?: Args
): Promise<ApiCampaignTimeline> {
  return apiData<ApiCampaignTimeline>(
    await callApi(
      "GET",
      `/api/v1/research/campaigns/${campaignId}/timeline`,
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

export async function createCampaignSession(
  campaignId: string,
  body: {
    name: string
    workerTarget?: number
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiSession> {
  return apiData<ApiSession>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/sessions`,
      body,
      args
    )
  )
}

export async function stopCampaignSession(
  sessionId: string,
  body: {
    campaignId: string
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

export async function createCampaignTask(
  campaignId: string,
  body: {
    sessionId?: string
    title: string
    description?: string
    priority?: number
    baseCommitSha?: string
    maxAttempts?: number
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiTask> {
  return apiData<ApiTask>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/tasks`,
      body,
      args
    )
  )
}

export async function registerCampaignWorker(
  campaignId: string,
  body: {
    sessionId?: string
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
    taskId?: string | null
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

export async function leaseCampaignTask(
  body: { campaignId: string; workerId: string; leaseSeconds?: number },
  args?: Args
): Promise<{ task: ApiTask | null }> {
  return apiData<{ task: ApiTask | null }>(
    await callApi("POST", "/api/v1/research/tasks/lease", body, args)
  )
}

export async function heartbeatCampaignTask(
  taskId: string,
  body: {
    campaignId: string
    workerId: string
    leaseSeconds?: number
    status?: "leased" | "running"
    progressMessage?: string
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiTask> {
  return apiData<ApiTask>(
    await callApi(
      "POST",
      `/api/v1/research/tasks/${taskId}/heartbeat`,
      body,
      args
    )
  )
}

export async function completeCampaignTask(
  taskId: string,
  body: {
    campaignId: string
    workerId: string
    experimentId?: string
    status?: "completed" | "cancelled"
    error?: Record<string, unknown> | null
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiTask> {
  return apiData<ApiTask>(
    await callApi(
      "POST",
      `/api/v1/research/tasks/${taskId}/complete`,
      body,
      args
    )
  )
}

export async function cancelCampaignTask(
  taskId: string,
  body: {
    campaignId: string
    workerId?: string
    reason?: string
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiTask> {
  return apiData<ApiTask>(
    await callApi(
      "POST",
      `/api/v1/research/tasks/${taskId}/cancel`,
      body,
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
  }>(await callApi("DELETE", `/api/v1/research/campaigns/${campaignId}`, undefined, args))
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
