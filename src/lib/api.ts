import { setTimeout as sleepWithSignal } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import type {
  AcquireResearchWorkerLeaseBatchResponse,
  AcquireResearchWorkerLeaseResponse,
  CreateResearchCampaignExperimentRequest,
  CreateResearchCampaignRequest,
  ResearchEvaluationManifest,
  ResearchSessionHypothesisAssignment,
  ResearchHypothesisPlan,
} from "../protocol"

import type { Args } from "./args"
import { apiBaseUrl, apiCredential, selectedProfileWithName } from "./config"
import { normalizeRepositoryUrl, repositoryUrl } from "./git"
import { readState, updateState } from "./runtime-state"
import { resolveProjectPath } from "./project"
import { getWorkerRuntimeContextCached } from "./worker-context"

export type ApiProject = Pick<
  import("../protocol").ResearchProject,
  | "id"
  | "name"
  | "repositoryUrl"
  | "repositoryAccessMode"
  | "repositoryFullName"
  | "defaultBranch"
  | "projectPath"
>

export type ApiGitStatus = import("../protocol").ResearchExperimentGitStatus

export type ApiCampaign = Pick<
  import("../protocol").ResearchCampaign,
  | "id"
  | "projectId"
  | "name"
  | "description"
  | "createdFromCommitSha"
  | "currentEvaluationRevisionId"
  | "currentEvaluationRevision"
  | "status"
  | "metricName"
  | "metricUnit"
  | "metricDirection"
  | "experimentCount"
  | "promotionRefName"
> &
  Partial<
    Pick<
      import("../protocol").ResearchCampaign,
      "parentCampaignId" | "lastExperimentAt" | "createdAt" | "updatedAt"
    >
  > & {
    baseCommitSha: string
    bestExperimentId: string | null
    bestMetricValue: number | null
    bestCommitSha: string | null
  }

export type ApiEvaluationRevision =
  import("../protocol").ResearchEvaluationRevision

export type ApiCampaignGitVerificationSummary =
  import("../protocol").ResearchCampaignGitVerificationSummary

export type ApiCampaignGitVerificationResult =
  import("../protocol").VerifyResearchCampaignGitResponse["data"]

export type ApiCampaignExperiment =
  import("../protocol").ResearchCampaignExperiment

export type ApiSession = Pick<
  import("../protocol").ResearchSession,
  | "id"
  | "campaignId"
  | "name"
  | "evaluationRevisionId"
  | "baseCommitSha"
  | "setupHash"
  | "baseGitStatus"
  | "baseGitVerifiedAt"
  | "baseGitStatusReason"
  | "runtimeState"
  | "workerTarget"
  | "experimentTarget"
  | "acceptedExperimentCount"
  | "remainingExperimentCount"
  | "deadlineAt"
  | "endedAt"
  | "endReason"
  | "schedulerSiteId"
  | "assignments"
  | "metadata"
> &
  Partial<
    Pick<
      import("../protocol").ResearchSession,
      "startedAt" | "createdAt" | "updatedAt"
    >
  > & {
    status: "running" | "completed" | "failed" | "stopped"
    cleanupStatus: import("../protocol").ResearchSessionControlStateResponse["data"]["cleanup"]["status"]
    terminalReason: import("../protocol").ResearchSession["endReason"]
    completedAt?: string | null
  }

export type ApiWorker = Pick<
  import("../protocol").ResearchWorker,
  | "id"
  | "campaignId"
  | "workerName"
  | "agentKind"
  | "runtime"
  | "status"
  | "currentExperimentId"
  | "phase"
  | "progressMessage"
  | "gitLabel"
  | "lastSeenAt"
  | "startedAt"
  | "metadata"
  | "createdAt"
  | "updatedAt"
> &
  Partial<
    Pick<
      import("../protocol").ResearchWorker,
      | "assignmentId"
      | "liveness"
      | "siteId"
      | "supervisorRunId"
      | "workerRef"
      | "leaseExpiresAt"
      | "leaseReleasedAt"
      | "terminalOutcome"
    >
  > & {
    sessionId: import("../protocol").ResearchSessionLiveResponse["data"]["workers"][number]["sessionId"]
    hypothesisId: import("../protocol").ResearchSessionLiveResponse["data"]["workers"][number]["hypothesisId"]
  }

export type ApiHypothesis = Pick<
  import("../protocol").ResearchHypothesis,
  | "id"
  | "campaignId"
  | "createdBySessionId"
  | "name"
  | "description"
  | "status"
  | "summaryEvaluationRevisionId"
  | "bestExperimentId"
  | "bestMetricValue"
  | "bestCommitSha"
  | "experimentCount"
  | "lastWorkedAt"
  | "plan"
  | "metadata"
  | "createdAt"
  | "updatedAt"
> & { baseCommitSha: string }

export type ApiKnowledge = import("../protocol").ResearchKnowledge

export type ApiCampaignTimeline = {
  campaign: ApiCampaign
  gitVerification?: ApiCampaignGitVerificationSummary
  workers: ApiWorker[]
  hypotheses: ApiHypothesis[]
  knowledge: ApiKnowledge[]
}

export type ApiCampaignOverview = Omit<
  import("../protocol").ResearchCampaignOverviewResponse["data"],
  "campaign" | "sessions" | "workers" | "hypotheses"
> & {
  campaign: ApiCampaign
  sessions: ApiSession[]
  workers: ApiWorker[]
  hypotheses: ApiHypothesis[]
}

export type ApiSessionState = Omit<
  import("../protocol").ResearchSessionStateResponse["data"],
  "session" | "campaign" | "hypotheses" | "workers"
> & {
  session: ApiSession
  campaign: ApiCampaign
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
}

export type ApiSessionLive = Omit<
  import("../protocol").ResearchSessionLiveResponse["data"],
  "session" | "campaign"
> & { session: ApiSession; campaign: ApiCampaign }

export type ApiSessionControlState = Omit<
  import("../protocol").ResearchSessionControlStateResponse["data"],
  "progress"
> & {
  progress: import("../protocol").ResearchSessionControlStateResponse["data"]["progress"] & {
    terminalReason: ApiSession["terminalReason"]
  }
}

export type ApiSessionBrief = Omit<
  import("../protocol").ResearchSessionBriefResponse["data"],
  "session" | "campaign" | "hypothesis" | "activeHypotheses"
> & {
  session: ApiSession
  campaign: ApiCampaign
  hypothesis: ApiHypothesis | null
  activeHypotheses: ApiHypothesis[]
}

export type ApiSessionStateBrief = Omit<
  import("../protocol").ResearchSessionStateBriefResponse["data"],
  "session" | "progress"
> & {
  session: import("../protocol").ResearchSessionStateBriefResponse["data"]["session"] & {
    status: ApiSession["status"]
  }
  progress: ApiSessionControlState["progress"]
}

export type ApiCampaignUpsertResult = {
  project: ApiProject
  campaign: ApiCampaign
}

export type ApiExperimentReportResult =
  import("../protocol").CreateResearchCampaignExperimentResponse["data"] & {
    session?: ApiSession | null
  }

type ApiWorkerLeaseWire = AcquireResearchWorkerLeaseResponse["data"]

export type ApiWorkerLease = Omit<ApiWorkerLeaseWire, "hypothesis"> & {
  hypothesis: ApiHypothesis
  workerCredential: string
}

type ApiWorkerLeaseBatchWire = AcquireResearchWorkerLeaseBatchResponse["data"]

export type ApiWorkerLeaseBatch = Omit<ApiWorkerLeaseBatchWire, "grants"> & {
  grants: Array<
    Omit<ApiWorkerLeaseBatchWire["grants"][number], "hypothesis"> & {
      hypothesis: ApiHypothesis
      workerCredential: string
    }
  >
}

function hypothesisFromWorkerLease({
  hypothesis,
  assignment,
}: Pick<ApiWorkerLeaseWire, "hypothesis" | "assignment">): ApiHypothesis {
  return {
    ...hypothesis,
    baseCommitSha: assignment.startingCommitSha,
  }
}

export type ApiWorkerHeartbeatResponse = Omit<
  import("../protocol").ResearchWorkerHeartbeatResponse["data"],
  "worker"
> & { worker: ApiWorker }

export type ApiWorkerHeartbeatBatchResponse = {
  results: Array<
    | {
        workerId: string
        ok: true
        worker: ApiWorker
        heartbeat: ApiWorkerHeartbeatResponse["heartbeat"]
      }
    | {
        workerId: string
        ok: false
        error: { code: string; message: string }
      }
  >
}

export type ApiResearchPresenceResponse =
  import("../protocol").UpsertResearchPresenceResponse["data"]

export type ApiReconcileCampaignResponse = {
  campaign: ApiCampaign
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
  experiments: ApiCampaignExperiment[]
  gitVerification: ApiCampaignGitVerificationResult
}

export type ApiVerifyResearchGitResponse =
  ApiReconcileCampaignResponse["gitVerification"]

type ApiTimingBucket = {
  count: number
  maxMs: number
  samples: number[]
}

const API_TIMING_SAMPLE_LIMIT = 200
const apiTimingBuckets = new Map<string, ApiTimingBucket>()

function apiTimingsEnabled(args?: Args) {
  return (
    args?.options["api-timings"] === "true" ||
    process.env.ONYX_API_TIMINGS === "1" ||
    process.env.ONYX_API_TIMINGS === "true"
  )
}

function apiTimingCategory(method: string, path: string) {
  const pathname = path.split("?")[0] ?? path
  if (method === "POST" && pathname.endsWith("/experiments")) {
    return "experiment_report"
  }
  if (method === "POST" && pathname === "/api/v1/research/presence") {
    return "presence_upload"
  }
  if (method === "POST" && pathname.includes("/heartbeat")) {
    return "worker_heartbeat"
  }
  if (method === "GET" && pathname.includes("/control-state")) {
    return "control_state"
  }
  if (method === "POST" && pathname.includes("/settlement-tick")) {
    return "settlement"
  }
  if (method === "GET" && pathname.includes("/live")) {
    return "live_status"
  }
  if (method === "GET" && pathname.includes("/overview")) {
    return "campaign_overview"
  }
  if (method === "POST" && pathname.includes("/worker-leases/batch")) {
    return "worker_lease_batch"
  }
  if (method === "POST" && pathname.includes("/reconcile")) {
    return "reconcile"
  }
  if (method === "POST" && pathname.includes("/verify-git")) {
    return "verify_git"
  }
  return null
}

function recordApiTiming(category: string, durationMs: number) {
  const bucket =
    apiTimingBuckets.get(category) ??
    ({ count: 0, maxMs: 0, samples: [] } satisfies ApiTimingBucket)
  bucket.count += 1
  bucket.maxMs = Math.max(bucket.maxMs, durationMs)
  if (bucket.samples.length < API_TIMING_SAMPLE_LIMIT) {
    bucket.samples.push(durationMs)
  } else {
    bucket.samples[bucket.count % API_TIMING_SAMPLE_LIMIT] = durationMs
  }
  apiTimingBuckets.set(category, bucket)
}

function percentile(samples: number[], p: number) {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  )
  return sorted[index] ?? 0
}

export function resetApiTimingSummary() {
  apiTimingBuckets.clear()
}

export function renderApiTimingSummary(args?: Args) {
  if (!apiTimingsEnabled(args) || apiTimingBuckets.size === 0) return null
  const lines = ["API timings:"]
  for (const [category, bucket] of [...apiTimingBuckets.entries()].sort()) {
    lines.push(
      `- ${category}: count=${bucket.count} max=${bucket.maxMs}ms p95=${percentile(
        bucket.samples,
        95
      )}ms`
    )
  }
  return lines.join("\n")
}

function emitApiTiming(
  args: Args | undefined,
  event: {
    method: string
    path: string
    status: number | null
    durationMs: number
    ok: boolean
    serverTiming?: string | null
    onyxTiming?: string | null
    error?: string | null
  }
) {
  const category = apiTimingCategory(event.method, event.path)
  if (!category || !apiTimingsEnabled(args)) return
  recordApiTiming(category, event.durationMs)
  const metadata = [
    `category=${category}`,
    `method=${event.method}`,
    `path=${event.path.split("?")[0]}`,
    `status=${event.status ?? "error"}`,
    `ok=${event.ok}`,
    `durationMs=${event.durationMs}`,
    event.serverTiming
      ? `serverTiming=${JSON.stringify(event.serverTiming)}`
      : null,
    event.onyxTiming ? `onyxTiming=${JSON.stringify(event.onyxTiming)}` : null,
    event.error ? `error=${JSON.stringify(event.error)}` : null,
  ].filter(Boolean)
  console.error(`[onyx-api] ${metadata.join(" ")}`)
}

// Only explicitly idempotent writes may retry after an uncertain response.
const RETRYABLE_API_STATUSES = new Set([429, 502, 503, 504])
const API_RETRY_ATTEMPTS = 3
// Typed CLI session failures the server returns with 401. None of them are
// fixed by refreshing the WorkOS token.
const CLI_SESSION_ERROR_CODES = new Set([
  "cli_session_required",
  "cli_session_revoked",
  "cli_session_invalid",
])

function apiRetryDelayMs(attempt: number) {
  return (
    Math.min(5000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100)
  )
}

export async function callApi(
  method: string,
  path: string,
  body?: unknown,
  args?: Args,
  credentialOverride?: string,
  retry = method === "GET" || method === "HEAD"
) {
  const maxAttempts = retry ? API_RETRY_ATTEMPTS : 1
  const requestedTimeout = Number(args?.options["api-timeout"] ?? 120_000)
  const timeoutMs = Math.min(
    requestedTimeout,
    args?.options["api-deadline"]
      ? Math.max(1, Number(args.options["api-deadline"]) - Date.now())
      : requestedTimeout
  )
  const signal =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined
  const startedAt = Date.now()
  const resolveCredential = async (forceRefresh = false) => {
    if (credentialOverride) return credentialOverride
    if (process.env.ONYX_API_KEY) return process.env.ONYX_API_KEY
    if (!forceRefresh) return apiCredential(args)
    const { name, profile } = await selectedProfileWithName(args)
    const { accessTokenForProfile } = await import("./oauth-credentials")
    return accessTokenForProfile({ name, profile, forceRefresh: true })
  }
  const usesProfileCredential = !credentialOverride && !process.env.ONYX_API_KEY
  const resolveCliSessionHeaders = async (): Promise<
    Record<string, string>
  > => {
    if (!usesProfileCredential) return {}
    const { profile } = await selectedProfileWithName(args)
    return { "x-onyx-cli-session-id": profile.cliSessionId }
  }
  // The server names why a CLI credential was rejected; only some reasons
  // are worth a token refresh, and only explicit session revocation should
  // cost the user their stored login.
  const readErrorCode = async (response: Response) => {
    try {
      const payload = (await response.clone().json()) as {
        error?: { code?: unknown }
      }
      return typeof payload?.error?.code === "string"
        ? payload.error.code
        : null
    } catch {
      return null
    }
  }
  const requestOnce = async (forceRefresh = false) =>
    fetch(`${await apiBaseUrl(args)}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await resolveCredential(forceRefresh)}`,
        ...(await resolveCliSessionHeaders()),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  try {
    let response: Response | null = null
    let refreshedAfterUnauthorized = false
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await requestOnce()
      } catch (error) {
        // Timeouts have spent the whole budget; connection-level failures
        // get the remaining attempts.
        const aborted =
          signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        if (aborted || attempt === maxAttempts) throw error
        await sleepWithSignal(apiRetryDelayMs(attempt), undefined, { signal })
        continue
      }
      if (
        response.status === 401 &&
        !refreshedAfterUnauthorized &&
        usesProfileCredential
      ) {
        const code = await readErrorCode(response)
        if (!code || !CLI_SESSION_ERROR_CODES.has(code)) {
          refreshedAfterUnauthorized = true
          response = await requestOnce(true)
        }
      }
      if (
        attempt === maxAttempts ||
        !RETRYABLE_API_STATUSES.has(response.status)
      ) {
        break
      }
      const retryAfter = response.headers.get("retry-after")
      const providerDelay = retryAfter
        ? /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : 0
      const delay = Math.max(apiRetryDelayMs(attempt), providerDelay || 0)
      if (Date.now() + delay - startedAt >= timeoutMs) break
      await sleepWithSignal(delay, undefined, { signal })
      if (signal?.aborted) break
    }
    if (!response) {
      throw new Error(`No response received for ${method} ${path}`)
    }
    if (response.status === 401 && usesProfileCredential) {
      const code = await readErrorCode(response)
      if (code === "cli_session_revoked" || code === "cli_session_invalid") {
        const { name, profile } = await selectedProfileWithName(args)
        const { deleteCredential } = await import("./credential-store")
        await deleteCredential(profile.credentialId)
        throw new Error(
          code === "cli_session_revoked"
            ? `This device's login for profile "${name}" was revoked from Settings. Run \`onyx login\`.`
            : `The CLI session for profile "${name}" is no longer valid. Run \`onyx login\`.`
        )
      }
      if (code === "cli_session_required") {
        const { name } = await selectedProfileWithName(args)
        throw new Error(
          `Profile "${name}" is missing its CLI session ID. Run \`onyx login\`.`
        )
      }
      // Any other 401 (including a token the identity provider rejected after
      // one refresh) keeps the stored login; the caller sees an ApiError.
    }

    const text = await response.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }

    emitApiTiming(args, {
      method,
      path,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ok: response.ok,
      serverTiming: response.headers.get("server-timing"),
      onyxTiming: response.headers.get("x-onyx-timing"),
    })

    if (!response.ok) {
      if (
        response.status === 503 &&
        (payload as { error?: { code?: string } } | null)?.error?.code ===
          "cli_auth_temporarily_unavailable"
      ) {
        throw new ApiError(
          method,
          path,
          response.status,
          payload,
          "Onyx could not reach its identity provider; try again shortly. Your login is intact."
        )
      }
      const apiError = new ApiError(method, path, response.status, payload)
      const retryAfter = response.headers.get("retry-after")
      apiError.retryAfterMs = retryAfter
        ? /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : null
      throw apiError
    }

    return path.startsWith("/api/v1/research/")
      ? adaptResearchApiPayload(payload, path)
      : payload
  } catch (error) {
    if (!(error instanceof ApiError)) {
      emitApiTiming(args, {
        method,
        path,
        status: null,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
}

async function workerCredential() {
  const context = await getWorkerRuntimeContextCached()
  const credential = context?.workerCredential
  if (!credential?.match(/^owx_worker_v1_[A-Za-z0-9_-]{32,}$/)) {
    throw new Error(
      "Worker API requires a supervised worker runtime (ONYX_WORKER_CONTEXT with a scoped worker credential)"
    )
  }
  return credential
}

export async function callWorkerApi(
  method: string,
  path: string,
  body?: unknown,
  args?: Args,
  credentialOverride?: string,
  retry = method === "GET" || method === "HEAD"
) {
  const credential = credentialOverride ?? (await workerCredential())
  if (!credential.match(/^owx_worker_v1_[A-Za-z0-9_-]{32,}$/)) {
    throw new Error("Worker API requires a valid scoped worker credential")
  }
  return callApi(method, path, body, args, credential, retry)
}

export class ApiError extends Error {
  retryAfterMs: number | null = null
  status: number
  payload: unknown
  /** Stable error code from the `{ error: { code } }` envelope, when present. */
  code: string | null

  constructor(
    method: string,
    path: string,
    status: number,
    payload: unknown,
    message?: string
  ) {
    super(
      message ??
        `${method} ${path} failed (${status}): ${
          typeof payload === "string" ? payload : JSON.stringify(payload)
        }`
    )
    this.name = "ApiError"
    this.status = status
    this.payload = payload
    const code = (payload as { error?: { code?: unknown } } | null)?.error?.code
    this.code = typeof code === "string" ? code : null
  }
}

export function apiData<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw new Error(`Unexpected API response: ${JSON.stringify(payload)}`)
  }
  return (payload as { data: T }).data
}

function normalizeResearchResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeResearchResponse)
  if (!value || typeof value !== "object") return value
  const normalized = { ...(value as Record<string, unknown>) }

  if (typeof normalized.runtimeState === "string") {
    const ended = normalized.runtimeState === "ended"
    const failed =
      normalized.endReason === "failed" ||
      normalized.endReason === "supervisor_failed"
    normalized.status ??= ended
      ? normalized.endReason === "user_stopped"
        ? "stopped"
        : failed
          ? "failed"
          : "completed"
      : "running"
    const cleanup =
      normalized.cleanup && typeof normalized.cleanup === "object"
        ? (normalized.cleanup as Record<string, unknown>)
        : null
    normalized.cleanupStatus ??=
      typeof cleanup?.status === "string"
        ? cleanup.status
        : ended
          ? "abandoned"
          : "running"
    normalized.terminalReason = normalized.endReason ?? null
    normalized.completedAt = normalized.endedAt ?? null
    if (normalized.progress && typeof normalized.progress === "object") {
      const progress = normalized.progress as Record<string, unknown>
      normalized.progress = {
        ...progress,
        terminalReason: progress.endReason ?? null,
      }
    }
  }
  if (
    typeof normalized.metricName === "string" &&
    "currentEvaluationRevision" in normalized
  ) {
    const revision = normalized.currentEvaluationRevision as Record<
      string,
      unknown
    > | null
    normalized.baseCommitSha =
      normalized.createdFromCommitSha ?? revision?.firstSeenCommitSha ?? ""
    normalized.bestExperimentId = revision?.bestExperimentId ?? null
    normalized.bestMetricValue = revision?.bestMetricValue ?? null
    normalized.bestCommitSha = revision?.bestCommitSha ?? null
  }
  if (
    normalized.plan &&
    typeof normalized.plan === "object" &&
    (normalized.status === "active" || normalized.status === "closed")
  ) {
    normalized.baseCommitSha ??= ""
    normalized.summaryEvaluationRevisionId ??= null
    normalized.bestExperimentId ??= null
    normalized.bestMetricValue ??= null
    normalized.bestCommitSha ??= null
    normalized.experimentCount ??= 0
    normalized.lastWorkedAt ??= null
  }
  return normalized
}

/** Only traverse declared DTO positions. Metadata, plans and research prose are opaque. */
export function adaptResearchApiPayload(
  payload: unknown,
  path: string
): unknown {
  if (!payload || typeof payload !== "object" || !("data" in payload))
    return payload
  const envelope = payload as { data: unknown }
  const adapt = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(adapt)
    if (!value || typeof value !== "object") return value
    const result = { ...(value as Record<string, unknown>) }
    for (const field of [
      "campaign",
      "campaigns",
      "session",
      "sessions",
      "hypothesis",
      "hypotheses",
      "grants",
    ]) {
      if (field in result) result[field] = adapt(result[field])
    }
    return normalizeResearchResponse(result)
  }
  // Knowledge and experiment payloads carry no runtime-derived compatibility fields.
  if (/\/(knowledge|experiments)(\?|$)/.test(path)) return payload
  return { ...envelope, data: adapt(envelope.data) }
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
      repositoryAccessMode: "local_reported",
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
      repositoryAccessMode:
        state.projectCache.repositoryAccessMode ?? "local_reported",
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
        repositoryAccessMode: project.repositoryAccessMode,
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
    // Credential, revocation, and network failures carry their own actionable
    // messages; only an API 404 means the repository has no project yet.
    if (!(error instanceof ApiError)) throw error
    if (error.status === 401 || error.status === 403) {
      throw new Error(
        `Onyx API could not resolve this repository because authentication failed (${error.status}). Run \`onyx status\`, \`onyx login\`, or switch profiles.`
      )
    }
    if (error.status !== 404) {
      throw new Error(
        `Onyx API project resolve failed (${error.status}). ${error.message}`
      )
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
  options: {
    limit?: number
    cursor?: string
    sessionId?: string
    hypothesisId?: string
    workerId?: string
    resultCommitSha?: string
    runRef?: string
    status?: string
    disposition?: "all" | "received" | "accepted" | "discarded"
  } = {}
): Promise<{
  items: ApiCampaignExperiment[]
  page: { nextCursor: string | null }
}> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 100),
  })
  for (const [key, value] of Object.entries(options)) {
    if (key === "limit") continue
    if (value !== undefined && value !== null) params.set(key, String(value))
  }
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

export async function listWorkerExperiments(
  args?: Args,
  options: {
    limit?: number
    cursor?: string
    status?: string
    disposition?: "all" | "received" | "accepted" | "discarded"
  } = {}
): Promise<{
  items: ApiCampaignExperiment[]
  page: { nextCursor: string | null }
}> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) })
  for (const [key, value] of Object.entries(options)) {
    if (key !== "limit" && value != null) params.set(key, String(value))
  }
  return apiData(
    await callWorkerApi(
      "GET",
      `/api/v1/research/worker/experiments?${params.toString()}`,
      undefined,
      args
    )
  )
}

export async function reportCampaignExperiment(
  campaignId: string,
  body: CreateResearchCampaignExperimentRequest,
  args?: Args
): Promise<ApiExperimentReportResult> {
  return apiData<ApiExperimentReportResult>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/experiments`,
      body,
      args,
      undefined,
      true
    )
  )
}

export async function reportWorkerExperiment(
  body: CreateResearchCampaignExperimentRequest,
  args?: Args,
  credentialOverride?: string
): Promise<ApiExperimentReportResult> {
  const {
    sessionId: _sessionId,
    assignmentId: _assignmentId,
    hypothesisId: _hypothesisId,
    workerId: _workerId,
    ...workerBody
  } = body
  void _sessionId
  void _assignmentId
  void _hypothesisId
  void _workerId
  return apiData<ApiExperimentReportResult>(
    await callWorkerApi(
      "POST",
      "/api/v1/research/worker/experiments",
      workerBody,
      args,
      credentialOverride,
      true
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
    status: "recorded" | "duplicate" | "deleted" | "invalid"
    experiment: ApiCampaignExperiment | null
    error: { code: string; message: string } | null
  }>
}> {
  return apiData<{
    results: Array<{
      runRef: string
      status: "recorded" | "duplicate" | "deleted" | "invalid"
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
    baseCommitSha: string
    setupHash: string
    evaluationFingerprint: string
    evaluationManifest: ResearchEvaluationManifest
    workerTarget: number
    assignments: Array<{
      hypothesisId: string
      startingCommitSha: string
      sourceExperimentId?: string
      setupHash: string
      evaluationFingerprint: string
    }>
    metadata?: Record<string, unknown>
    experimentTarget?: number
    deadlineAt?: string
    schedulerSiteId?: string
    supervisorRunId?: string
  },
  args?: Args
): Promise<{
  session: ApiSession
  hypotheses: ApiHypothesis[]
  evaluationRevision: ApiEvaluationRevision
  assignments: ResearchSessionHypothesisAssignment[]
}> {
  return apiData<{
    session: ApiSession
    hypotheses: ApiHypothesis[]
    evaluationRevision: ApiEvaluationRevision
    assignments: ResearchSessionHypothesisAssignment[]
  }>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/sessions`,
      { ...body, requestId: randomUUID() },
      args,
      undefined,
      true
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

export async function closeCampaignHypothesis(
  hypothesisId: string,
  body: { reason?: string } = {},
  args?: Args
): Promise<{
  hypothesis: ApiHypothesis
  canceledAssignmentIds: string[]
  stoppedWorkerIds: string[]
  endedSessionIds: string[]
}> {
  return apiData(
    await callApi(
      "POST",
      `/api/v1/research/hypotheses/${hypothesisId}/close`,
      body,
      args
    )
  )
}

export async function reopenCampaignHypothesis(
  hypothesisId: string,
  args?: Args
): Promise<{ hypothesis: ApiHypothesis }> {
  return apiData(
    await callApi(
      "POST",
      `/api/v1/research/hypotheses/${hypothesisId}/reopen`,
      undefined,
      args
    )
  )
}

export async function stopCampaignSession(
  sessionId: string,
  body: {
    campaignId: string
    endReason?:
      | "user_stopped"
      | "provider_capacity_exhausted"
      | "supervisor_failed"
      | "failed"
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

export async function scaleCampaignSession(
  sessionId: string,
  body: {
    campaignId: string
    workerTarget: number
    siteId?: string
    supervisorRunId?: string
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<{ session: ApiSession; event: Record<string, unknown> }> {
  return apiData<{ session: ApiSession; event: Record<string, unknown> }>(
    await callApi(
      "POST",
      `/api/v1/research/sessions/${sessionId}/scale`,
      body,
      args
    )
  )
}

export async function unarchiveCampaign(
  campaignId: string,
  args?: Args
): Promise<{ campaign: ApiCampaign }> {
  return apiData<{ campaign: ApiCampaign }>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/unarchive`,
      undefined,
      args
    )
  )
}

export async function listCampaignEvaluationRevisions(
  campaignId: string,
  args?: Args
): Promise<ApiEvaluationRevision[]> {
  return apiData<ApiEvaluationRevision[]>(
    await callApi(
      "GET",
      `/api/v1/research/campaigns/${campaignId}/evaluation-revisions`,
      undefined,
      args
    )
  )
}

export async function archiveCampaign(
  campaignId: string,
  args?: Args
): Promise<{ campaign: ApiCampaign }> {
  return apiData<{ campaign: ApiCampaign }>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/archive`,
      undefined,
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

export async function getResearchSessionControlState(
  sessionId: string,
  args?: Args
): Promise<ApiSessionControlState> {
  return apiData<ApiSessionControlState>(
    await callApi(
      "GET",
      `/api/v1/research/sessions/${sessionId}/control-state`,
      undefined,
      args
    )
  )
}

export async function settleResearchSession(
  sessionId: string,
  args?: Args
): Promise<ApiSessionControlState> {
  return apiData<ApiSessionControlState>(
    await callApi(
      "POST",
      `/api/v1/research/sessions/${sessionId}/settlement-tick`,
      {},
      args
    )
  )
}

export async function getResearchSessionBrief(
  sessionId: string,
  args?: Args,
  options: { hypothesisId?: string } = {}
): Promise<ApiSessionBrief> {
  const params = new URLSearchParams()
  if (options.hypothesisId) params.set("hypothesisId", options.hypothesisId)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  return apiData<ApiSessionBrief>(
    await callApi(
      "GET",
      `/api/v1/research/sessions/${sessionId}/brief${suffix}`,
      undefined,
      args
    )
  )
}

export async function getWorkerResearchBrief(
  args?: Args
): Promise<ApiSessionBrief> {
  return apiData<ApiSessionBrief>(
    await callWorkerApi("GET", "/api/v1/research/worker/brief", undefined, args)
  )
}

export async function getResearchSessionStateBrief(
  sessionId: string,
  args?: Args
): Promise<ApiSessionStateBrief> {
  return apiData<ApiSessionStateBrief>(
    await callApi(
      "GET",
      `/api/v1/research/sessions/${sessionId}/state-brief`,
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

export async function verifyResearchCampaignGit(
  campaignId: string,
  args?: Args,
  options: { gitVerifyLimit?: number } = {}
): Promise<ApiVerifyResearchGitResponse> {
  const params = new URLSearchParams()
  if (options.gitVerifyLimit !== undefined) {
    params.set("gitVerifyLimit", String(options.gitVerifyLimit))
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  return apiData<ApiVerifyResearchGitResponse>(
    await callApi(
      "POST",
      `/api/v1/research/campaigns/${campaignId}/verify-git${suffix}`,
      {},
      args
    )
  )
}

export async function acquireResearchWorkerLease(
  sessionId: string,
  body: {
    siteId: string
    supervisorRunId: string
    workerName: string
    agentKind?: string
    runtime?: "local" | "hosted"
    leaseSeconds?: number
    leaseCredential: string
    metadata?: Record<string, unknown>
  },
  args?: Args
): Promise<ApiWorkerLease> {
  const lease = apiData<ApiWorkerLeaseWire>(
    await callApi(
      "POST",
      `/api/v1/research/sessions/${sessionId}/worker-leases`,
      body,
      args
    )
  )
  return {
    ...lease,
    workerCredential: body.leaseCredential,
    hypothesis: hypothesisFromWorkerLease(lease),
  }
}

export async function acquireResearchWorkerLeasesBatch(
  sessionId: string,
  body: {
    siteId: string
    supervisorRunId: string
    workers: Array<{
      workerRef: string
      workerName: string
      agentKind?: string
      runtime?: "local" | "hosted"
      leaseSeconds?: number
      leaseCredential: string
      metadata?: Record<string, unknown>
    }>
  },
  args?: Args
): Promise<ApiWorkerLeaseBatch> {
  const batch = apiData<ApiWorkerLeaseBatchWire>(
    await callApi(
      "POST",
      `/api/v1/research/sessions/${sessionId}/worker-leases/batch`,
      body,
      args
    )
  )
  return {
    ...batch,
    grants: batch.grants.map((grant) => ({
      ...grant,
      workerCredential:
        body.workers.find((worker) => worker.workerRef === grant.workerRef)
          ?.leaseCredential ?? "",
      hypothesis: hypothesisFromWorkerLease(grant),
    })),
  }
}

export async function heartbeatWorker(
  _workerId: string,
  body: {
    workerCredential?: string
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
): Promise<ApiWorkerHeartbeatResponse> {
  const {
    workerCredential,
    sessionId: _sessionId,
    hypothesisId: _hypothesisId,
    ...workerBody
  } = body
  void _sessionId
  void _hypothesisId
  return apiData<ApiWorkerHeartbeatResponse>(
    await callWorkerApi(
      "POST",
      "/api/v1/research/worker/heartbeat",
      workerBody,
      args,
      workerCredential
    )
  )
}

export async function heartbeatWorkersBatch(
  body: {
    sessionId: string
    siteId: string
    supervisorRunId: string
    heartbeats: Array<{
      workerId: string
      status?: "registered" | "running" | "completed" | "failed" | "stopped"
      experimentId?: string | null
      phase?: string | null
      event?: string | null
      progressMessage?: string | null
      gitLabel?: string | null
      resourceStats?: Record<string, unknown>
      metadata?: Record<string, unknown>
    }>
  },
  args?: Args
): Promise<ApiWorkerHeartbeatBatchResponse> {
  return apiData<ApiWorkerHeartbeatBatchResponse>(
    await callApi(
      "POST",
      `/api/v1/research/worker-heartbeats/batch`,
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

export async function createWorkerKnowledge(
  body: Parameters<typeof createCampaignKnowledge>[1],
  args?: Args
): Promise<ApiKnowledge> {
  const {
    sessionId: _sessionId,
    hypothesisId: _hypothesisId,
    authoredByWorkerId: _authoredByWorkerId,
    ...workerBody
  } = body
  void _sessionId
  void _hypothesisId
  void _authoredByWorkerId
  return apiData<ApiKnowledge>(
    await callWorkerApi(
      "POST",
      "/api/v1/research/worker/knowledge",
      workerBody,
      args
    )
  )
}

export async function listWorkerKnowledge(
  args?: Args
): Promise<ApiKnowledge[]> {
  return apiData<ApiKnowledge[]>(
    await callWorkerApi(
      "GET",
      "/api/v1/research/worker/knowledge",
      undefined,
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

export async function upsertResearchPresence(
  body: {
    siteId: string
    supervisorRunId: string
    sequence: number
    sessionId: string
    site?: {
      cleanupRevision?: number
      runtimeStatus?: "starting" | "active" | "draining" | "complete" | "failed"
      cleanupStartedAt?: string | null
      cleanupCompletedAt?: string | null
      cleanupSummary?: Record<string, unknown>
      providerBackoff?: Record<string, unknown> | null
      ignoredPresence?: Record<string, unknown>
      activeWorkerCount?: number
      launchedWorkerCount?: number
      failedLaunchCount?: number
      uploadedWorkerCount?: number
      unchangedWorkerCount?: number
      droppedOrDeferredWorkerCount?: number
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
