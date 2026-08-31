import type {
  AcquireResearchWorkerLeaseBatchResponse,
  AcquireResearchWorkerLeaseResponse,
  CreateResearchCampaignExperimentRequest,
  CreateResearchCampaignRequest,
  ResearchEvaluationManifest,
  ResearchSessionHypothesisAssignment,
  ResearchHypothesisPlan,
  ResearchSetupCompliance,
  ResearchWorker,
} from "../protocol"

import type { Args } from "./args"
import { apiBaseUrl, apiCredential, selectedProfileWithName } from "./config"
import { normalizeRepositoryUrl, repositoryUrl } from "./git"
import { readState, updateState } from "./runtime-state"
import { resolveProjectPath } from "./project"
import { getWorkerRuntimeContextCached } from "./worker-context"

export type ApiProject = {
  id: string
  name: string
  repositoryUrl: string
  repositoryAccessMode: "local_reported" | "github_public" | "github_app"
  repositoryFullName: string | null
  defaultBranch: string
  projectPath: string
}

export type ApiGitStatus =
  | "local_reported"
  | "pending"
  | "verified"
  | "missing"
  | "mismatch"
  | "unreachable"

export type ApiCampaign = {
  id: string
  projectId: string
  parentCampaignId?: string | null
  name: string
  description: string | null
  createdFromCommitSha: string | null
  currentEvaluationRevisionId: string | null
  currentEvaluationRevision: ApiEvaluationRevision | null
  /** Derived locally for legacy display/runtime helpers; not part of the API contract. */
  baseCommitSha: string
  bestExperimentId: string | null
  bestMetricValue: number | null
  bestCommitSha: string | null
  status: "active" | "archived" | "completed"
  metricName: string
  metricUnit: string | null
  metricDirection: "maximize" | "minimize"
  experimentCount: number
  lastExperimentAt?: string | null
  promotionRefName: string | null
  createdAt?: string
  updatedAt?: string
}

export type ApiEvaluationRevision = {
  id: string
  campaignId: string
  fingerprint: string
  setupHash: string
  manifest: ResearchEvaluationManifest
  firstSeenCommitSha: string
  gitStatus: ApiGitStatus
  gitVerifiedAt: string | null
  gitStatusReason: string | null
  bestExperimentId: string | null
  bestMetricValue: number | null
  bestCommitSha: string | null
  experimentCount: number
  lastExperimentAt: string | null
  createdAt: string
  updatedAt: string
}

export type ApiCampaignGitVerificationSummary = {
  repositoryAccessMode: ApiProject["repositoryAccessMode"]
  baseGitStatus: ApiGitStatus
  baseGitVerifiedAt: string | null
  baseGitStatusReason: string | null
  acceptedExperimentGitStatusCounts: Record<ApiGitStatus, number>
  discardedExperimentGitStatusCounts: Record<ApiGitStatus, number>
  needsVerificationCount: number
  hardFailureCount: number
  lastVerifiedAt: string | null
  recommendedAction:
    | "connect_github"
    | "resolve_ref_mismatch"
    | "push_refs"
    | "verify_git"
    | "retry_later"
    | "none"
  message: string
}

export type ApiCampaignGitVerificationResult = {
  checkedCount: number
  updatedCount: number
  remainingCount: number
  limit: number
  hasMore: boolean
  rateLimit: {
    limited: boolean
    retryAfterSeconds: number | null
    remaining: number | null
    limit: number | null
    resetAt: string | null
  } | null
  base: {
    checked: boolean
    updated: boolean
    previousStatus: ApiGitStatus | null
    status: ApiGitStatus
    verifiedAt: string | null
    statusReason: string | null
  }
  summary: ApiCampaignGitVerificationSummary
}

export type ApiCampaignExperiment = {
  id: string
  campaignId: string
  sessionId: string
  evaluationRevisionId: string
  assignmentId: string
  hypothesisId: string
  workerId: string | null
  acceptedIndex: number | null
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
  resultRefPushStatus: "pushed" | "failed" | "skipped" | null
  resultRefPushedAt: string | null
  resultRefPushError: string | null
  disposition: "received" | "accepted" | "discarded"
  dispositionReason: string | null
  settledAt: string | null
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
  evaluationRevisionId: string
  baseCommitSha: string
  setupHash: string
  baseGitStatus: ApiGitStatus
  baseGitVerifiedAt: string | null
  baseGitStatusReason: string | null
  runtimeState: "starting" | "active" | "stale" | "abandoned" | "ended"
  /** Derived locally from endedAt/endReason. */
  status: "running" | "completed" | "failed" | "stopped"
  cleanupStatus: "running" | "draining" | "complete" | "failed" | "abandoned"
  terminalReason: ApiSession["endReason"]
  workerTarget: number
  experimentTarget: number | null
  acceptedExperimentCount: number
  remainingExperimentCount: number | null
  deadlineAt: string | null
  endedAt: string | null
  endReason:
    | "experiment_target_reached"
    | "deadline_reached"
    | "user_stopped"
    | "provider_capacity_exhausted"
    | "all_hypotheses_closed"
    | "supervisor_failed"
    | "failed"
    | "abandoned"
    | null
  schedulerSiteId: string | null
  assignments: ResearchSessionHypothesisAssignment[]
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
  assignmentId?: string
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
  siteId?: string | null
  supervisorRunId?: string | null
  workerRef?: string | null
  leaseExpiresAt?: string | null
  leaseReleasedAt?: string | null
  terminalOutcome?: ResearchWorker["terminalOutcome"]
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
  status: "active" | "closed"
  /** Assignment bases supersede this local-only fallback. */
  baseCommitSha: string
  summaryEvaluationRevisionId: string | null
  bestExperimentId: string | null
  bestMetricValue: number | null
  bestCommitSha: string | null
  experimentCount: number
  lastWorkedAt: string | null
  plan: ResearchHypothesisPlan
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
  gitVerification?: ApiCampaignGitVerificationSummary
  workers: ApiWorker[]
  hypotheses: ApiHypothesis[]
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
  knowledge: ApiKnowledge[]
  updatedAt: string
}

export type ApiSessionLive = {
  session: ApiSession
  campaign: ApiCampaign
  progress: {
    experimentTarget: number | null
    acceptedExperimentCount: number
    receivedExperimentCount: number
    remainingExperimentCount: number | null
    deadlineAt: string | null
    endedAt: string | null
    endReason: ApiSession["endReason"]
    warning?: string | null
  }
  livenessCounts: Record<string, number>
  phaseCounts: Record<string, number>
  workers: Array<{
    id: string
    campaignId?: string
    sessionId?: string | null
    hypothesisId?: string | null
    workerName?: string | null
    agentKind?: string | null
    runtime?: ApiWorker["runtime"] | null
    status: ApiWorker["status"]
    liveness: "active" | "stale" | "lost" | "unknown" | "terminal"
    phase: string | null
    progressMessage: string | null
    gitLabel: string | null
    currentExperimentId: string | null
    lastOutputAt: string | null
    activitySummary: Record<string, unknown>
    observedAt?: string | null
    receivedAt: string
    matched: boolean
  }>
  sites: Array<{
    siteId: string
    supervisorRunId: string | null
    liveness?: "active" | "stale" | "lost"
    status?: "active" | "stale" | "inactive"
    runtimeStatus?: "starting" | "active" | "draining" | "complete" | "failed"
    cleanupStartedAt?: string | null
    cleanupCompletedAt?: string | null
    cleanupSummary?: Record<string, unknown>
    lastSequence: number
    activeWorkerCount: number
    launchedWorkerCount: number
    failedLaunchCount: number
    uploadedWorkerCount?: number
    unchangedWorkerCount?: number
    droppedOrDeferredWorkerCount?: number
    providerBackoff: Record<string, unknown> | null
    ignoredPresence: Record<string, unknown>
    lastUploadAt: string | null
    receivedAt: string
  }>
  unmatchedPresenceCount: number
  ignoredPresence: Record<string, unknown>
  providerBackoff: Record<string, unknown> | null
  recentExperiments: ApiCampaignExperiment[]
  recentTerminalWorkers: Array<{
    id: string
    campaignId?: string
    sessionId?: string | null
    hypothesisId?: string | null
    workerName?: string | null
    agentKind?: string | null
    runtime?: ApiWorker["runtime"] | null
    status: ApiWorker["status"]
    liveness: "active" | "stale" | "lost" | "unknown" | "terminal"
    phase: string | null
    progressMessage: string | null
    gitLabel: string | null
    currentExperimentId: string | null
    lastOutputAt: string | null
    activitySummary: Record<string, unknown>
    observedAt?: string | null
    receivedAt: string
    matched: boolean
  }>
  liveWatermark: string
  updatedAt: string
}

export type ApiSessionControlState = {
  sessionId: string
  campaignStatus: ApiCampaign["status"]
  runtimeState: ApiSession["runtimeState"]
  status: ApiSession["status"]
  outcome: {
    status: ApiSession["status"]
    endedAt: string | null
    endReason: ApiSession["endReason"]
  }
  cleanup: {
    status: "running" | "draining" | "complete" | "failed" | "abandoned"
    startedAt: string | null
    completedAt: string | null
    summary: Record<string, unknown>
  }
  progress: {
    experimentTarget: number | null
    acceptedExperimentCount: number
    receivedExperimentCount: number
    remainingExperimentCount: number | null
    deadlineAt: string | null
    endedAt: string | null
    endReason: ApiSession["endReason"]
    terminalReason: ApiSession["terminalReason"]
  }
  launch: {
    activeWorkerCount: number
    workerTarget: number
    openWorkerSlotCount: number
    activeHypothesisCount: number
    acceptingExperiments: boolean
  }
  canceledAssignmentIds: string[]
  updatedAt: string
}

export type ApiSessionBrief = {
  session: ApiSession
  campaign: ApiCampaign
  project: ApiProject
  hypothesis: ApiHypothesis | null
  latestExperiments: ApiCampaignExperiment[]
  bestExperiment: ApiCampaignExperiment | null
  activeHypotheses: ApiHypothesis[]
  knowledge: ApiKnowledge[]
  updatedAt: string
}

export type ApiSessionStateBrief = {
  generatedAt: string
  session: Pick<
    ApiSession,
    | "id"
    | "name"
    | "runtimeState"
    | "status"
    | "workerTarget"
    | "deadlineAt"
    | "endedAt"
    | "endReason"
  > & {
    outcome: ApiSessionControlState["outcome"]
    cleanup: ApiSessionControlState["cleanup"]
  }
  campaign: Pick<
    ApiCampaign,
    "id" | "name" | "status" | "metricName" | "metricUnit" | "metricDirection"
  >
  progress: ApiSessionControlState["progress"]
  peerHypothesisCount: number
  peerHypotheses: Array<
    Pick<
      ApiHypothesis,
      | "id"
      | "name"
      | "status"
      | "bestMetricValue"
      | "bestCommitSha"
      | "experimentCount"
      | "lastWorkedAt"
    >
  >
  results: {
    latest: Array<
      Pick<
        ApiCampaignExperiment,
        | "id"
        | "hypothesisId"
        | "acceptedIndex"
        | "name"
        | "resultCommitSha"
        | "primaryMetricName"
        | "primaryMetricValue"
        | "createdAt"
      >
    >
    best: Pick<
      ApiCampaignExperiment,
      | "id"
      | "hypothesisId"
      | "acceptedIndex"
      | "name"
      | "resultCommitSha"
      | "primaryMetricName"
      | "primaryMetricValue"
      | "createdAt"
    > | null
  }
  knowledge: {
    items: Array<
      Pick<
        ApiKnowledge,
        | "id"
        | "hypothesisId"
        | "experimentId"
        | "kind"
        | "title"
        | "body"
        | "confidence"
        | "createdAt"
      >
    >
    hasMore: boolean
  }
  updatedAt: string
}

export type ApiCampaignUpsertResult = {
  project: ApiProject
  campaign: ApiCampaign
}

export type ApiExperimentReportResult = {
  outcome: "recorded" | "duplicate"
  experiment: ApiCampaignExperiment
  session: ApiSession | null
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

export type ApiWorkerHeartbeatResponse = {
  worker: ApiWorker
  heartbeat: {
    id: string
    workerId: string
    campaignId: string
    sessionId: string | null
    hypothesisId: string
    experimentId: string | null
    status: ApiWorker["status"]
    phase: string | null
    event: string | null
    progressMessage: string | null
    gitLabel: string | null
    resourceStats: Record<string, unknown>
    metadata: Record<string, unknown>
    createdAt: string
  }
}

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

export type ApiResearchPresenceResponse = {
  ignoredWorkers: Array<{
    id: string
    reason:
      | "not_found"
      | "session_mismatch"
      | "stale_sequence"
      | "unmatched_cap"
      | "update_failed"
      | "session_not_found"
    message: string
  }>
  ignoredByReason: {
    notFound: number
    sessionMismatch: number
    staleSequence: number
    unmatchedCap: number
    updateFailed: number
    sessionNotFound: number
  }
  acceptedCount: number
  ignoredCount: number
  unmatchedCount: number
  uploadedWorkerCount: number
  unchangedWorkerCount: number
  droppedOrDeferredWorkerCount: number
  deferredStartupTelemetryCount: number
  splitCount: number
  siteAccepted: boolean
}

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

// Transient failures worth one bounded retry: connection resets and
// gateway/overload statuses. Every Onyx write is idempotent by design
// (runRef/workerRef keys, presence sequence guards), so retrying POSTs is
// safe. Timeouts (AbortError) are not retried — the overall budget is spent.
const RETRYABLE_API_STATUSES = new Set([429, 502, 503, 504])
const API_RETRY_ATTEMPTS = 3

function apiRetryDelayMs(attempt: number) {
  return 250 * attempt + Math.floor(Math.random() * 100)
}

export async function callApi(
  method: string,
  path: string,
  body?: unknown,
  args?: Args,
  credentialOverride?: string
) {
  const timeoutMs = Number(args?.options["api-timeout"] ?? 120_000)
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
  const requestOnce = async (forceRefresh = false) =>
    fetch(`${await apiBaseUrl(args)}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await resolveCredential(forceRefresh)}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  try {
    let response: Response | null = null
    let refreshedAfterUnauthorized = false
    for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt += 1) {
      try {
        response = await requestOnce()
      } catch (error) {
        // Timeouts have spent the whole budget; connection-level failures
        // get the remaining attempts.
        const aborted =
          signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        if (aborted || attempt === API_RETRY_ATTEMPTS) throw error
        await new Promise((resolve) =>
          setTimeout(resolve, apiRetryDelayMs(attempt))
        )
        continue
      }
      if (
        response.status === 401 &&
        !refreshedAfterUnauthorized &&
        !credentialOverride &&
        !process.env.ONYX_API_KEY
      ) {
        refreshedAfterUnauthorized = true
        response = await requestOnce(true)
      }
      if (
        attempt === API_RETRY_ATTEMPTS ||
        !RETRYABLE_API_STATUSES.has(response.status)
      ) {
        break
      }
      await new Promise((resolve) =>
        setTimeout(resolve, apiRetryDelayMs(attempt))
      )
      if (signal?.aborted) break
    }
    if (!response) {
      throw new Error(`No response received for ${method} ${path}`)
    }
    if (
      response.status === 401 &&
      refreshedAfterUnauthorized &&
      !credentialOverride &&
      !process.env.ONYX_API_KEY
    ) {
      const { name, profile } = await selectedProfileWithName(args)
      const { deleteCredential } = await import("./credential-store")
      await deleteCredential(profile.credentialId)
      throw new Error(
        `Login for profile "${name}" is no longer valid. Run \`onyx login\`.`
      )
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
      throw new ApiError(method, path, response.status, payload)
    }

    return payload
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
  credentialOverride?: string
) {
  const credential = credentialOverride ?? (await workerCredential())
  if (!credential.match(/^owx_worker_v1_[A-Za-z0-9_-]{32,}$/)) {
    throw new Error("Worker API requires a valid scoped worker credential")
  }
  return callApi(method, path, body, args, credential)
}

export class ApiError extends Error {
  status: number
  payload: unknown

  constructor(method: string, path: string, status: number, payload: unknown) {
    super(
      `${method} ${path} failed (${status}): ${
        typeof payload === "string" ? payload : JSON.stringify(payload)
      }`
    )
    this.name = "ApiError"
    this.status = status
    this.payload = payload
  }
}

export function apiData<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw new Error(`Unexpected API response: ${JSON.stringify(payload)}`)
  }
  return normalizeResearchResponse((payload as { data: T }).data) as T
}

function normalizeResearchResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeResearchResponse)
  if (!value || typeof value !== "object") return value
  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizeResearchResponse(item),
    ])
  ) as Record<string, unknown>

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
      progress.terminalReason = progress.endReason ?? null
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
    if (error instanceof ApiError) {
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
      args
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
      credentialOverride
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
