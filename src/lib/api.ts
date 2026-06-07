import type {
  CreateResearchExperimentRequest,
  CreateResearchBranchRequest,
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

export type ApiBranch = {
  id: string
  name: string
  gitBranchName: string | null
}

export type ApiExperiment = {
  id: string
  sequenceNumber: number
  runRef: string
  commitSha: string
  status: string
  primaryMetricName: string
  primaryMetricValue: number | null
}

export type ApiTreeExperiment = ApiExperiment & {
  branchId: string
  name: string
  description: string | null
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

export type ApiTreeBranch = ApiBranch & {
  experiments: ApiTreeExperiment[]
}

export type ApiProjectTree = {
  project: ApiProject
  branches: ApiTreeBranch[]
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

/**
 * Resolves the linked Onyx project for this repository by matching the origin
 * URL + projectPath against the team's projects (or an explicit --project id).
 * Throws when nothing matches so callers can keep work queued in the outbox.
 */
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
      "No linked Onyx project matched this repository. Link the repo in Onyx first."
    )
  }

  return project
}

export async function listProjectBranches(
  projectId: string,
  args?: Args
): Promise<ApiBranch[]> {
  return apiData<ApiBranch[]>(
    await callApi(
      "GET",
      `/api/v1/research/projects/${projectId}/branches`,
      undefined,
      args
    )
  )
}

/** Full project hierarchy (branches + experiments) for history hydration. */
export async function getProjectTree(
  projectId: string,
  args?: Args
): Promise<ApiProjectTree> {
  return apiData<ApiProjectTree>(
    await callApi(
      "GET",
      `/api/v1/research/projects/${projectId}/tree`,
      undefined,
      args
    )
  )
}

export async function upsertBranch(
  projectId: string,
  body: CreateResearchBranchRequest,
  args?: Args
): Promise<ApiBranch> {
  return apiData<ApiBranch>(
    await callApi(
      "POST",
      `/api/v1/research/projects/${projectId}/branches`,
      body,
      args
    )
  )
}

export async function reportExperiment(
  branchId: string,
  body: CreateResearchExperimentRequest,
  args?: Args
): Promise<ApiExperiment> {
  return apiData<ApiExperiment>(
    await callApi(
      "POST",
      `/api/v1/research/branches/${branchId}/experiments`,
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
