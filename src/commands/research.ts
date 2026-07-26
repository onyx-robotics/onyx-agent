import { randomUUID } from "node:crypto"
import { closeSync, openSync } from "node:fs"
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  researchHypothesisPlanSchema,
  type ResearchHypothesisPlan,
} from "../protocol"
import { optionValues, type Args } from "../lib/args"
import { commandExpLog, commandExpRun } from "./exp"
import {
  ApiError,
  closeCampaignHypothesis,
  getCampaignOverview,
  acquireResearchWorkerLease,
  acquireResearchWorkerLeasesBatch,
  createCampaignHypothesis,
  createCampaignSession,
  createCampaignKnowledge,
  getResearchSessionControlState,
  getResearchSessionBrief,
  getResearchSessionStateBrief,
  getResearchSessionLive,
  getResearchSessionState,
  heartbeatWorkersBatch,
  heartbeatWorker,
  listCampaignExperiments,
  listCampaignEvaluationRevisions,
  listCampaignHypotheses,
  listCampaignKnowledge,
  listProjectCampaigns,
  reconcileCampaign,
  reopenCampaignHypothesis,
  renderApiTimingSummary,
  resetApiTimingSummary,
  settleResearchSession,
  scaleCampaignSession,
  stopCampaignSession,
  upsertCampaignSummary,
  upsertResearchPresence,
  verifyResearchCampaignGit,
  resolveProject,
  type ApiCampaign,
  type ApiCampaignExperiment,
  type ApiHypothesis,
  type ApiResearchPresenceResponse,
  type ApiSession,
  type ApiSessionBrief,
  type ApiSessionControlState,
  type ApiSessionLive,
  type ApiSummary,
  type ApiWorker,
  type ApiWorkerLease,
} from "../lib/api"
import {
  normalizeSetupFile,
  readSetupFile,
  readValidationFile,
  setupPath,
  setupHash,
  validationMatchesSetup,
  validationPath,
  type ResearchSetupFile,
} from "../lib/contract"
import { evaluationFingerprint } from "../lib/evaluation-fingerprint"
import {
  apiBaseUrl,
  apiKey,
  normalizeWorkerModel,
  profileNameFromArgs,
  readConfig,
  validateBuiltInWorkerAgent,
  type BuiltInWorkerAgent,
} from "../lib/config"
import { emitEvent } from "../lib/events"
import { currentCommit, git, gitResult, repoRoot } from "../lib/git"
import {
  onyxStateDir,
  readState,
  updateState,
  withOnyxLock,
  writeState,
  type CliState,
} from "../lib/runtime-state"
import {
  placeholderSessionStateBrief,
  readSessionStateBriefSnapshot,
  workerSessionStateBriefFromSnapshot,
  writeSessionStateBriefSnapshot,
  type SessionStateBriefSnapshot,
  type WorkerSessionStopGuidance,
} from "../lib/session-state-brief"
import { readWorkerRuntimeContext } from "../lib/worker-context"
import { campaignStateKey, onyxPath, resolveProjectPath } from "../lib/project"
import {
  pathExists,
  runStreamingProcess,
  type ProcessResult,
  type StreamingProcessResult,
} from "../lib/process"
import { resolveOpenCodeModelId } from "../lib/opencode-models"
import { collectLocalResearchStopReasons } from "../lib/research-stop"
import {
  abandonBlockedWorkflowRunsForSession,
  cacheLocalCampaign,
  cacheResearchSessionState,
  applyRemoteProjectionDeltas,
  getLocalSessionState,
  listLocalAttempts,
  listWorkflowRuns,
  recordLocalWorkerHeartbeat,
  registerLocalWorker,
  getResearchSiteId,
  stopLocalSession,
  upsertWorkerLaunch,
} from "../lib/research-runtime"
import { assertSetupCommitted } from "../lib/setup-git"
import { protectedToolPaths } from "../lib/tools"
import { formatAge } from "../lib/tui"
import {
  activitySummaryForManifest,
  readWorkerLatestState,
  type WorkerLatestState,
  writeWorkerLatestState,
} from "../lib/worker-activity"
import {
  buildWorkerInvocation,
  lowestFreeSlot,
  manifestIsTerminal,
  preflightWorkerInvocation,
  readWorkerLaunchManifests,
  workerRuntimeEnvironment,
  workerRuntimePaths,
  workerGitWritableRoots,
  workerLaunchPaths,
  writeWorkerCliWrapper,
  writeWorkerLaunchManifest,
  writeWorkerRuntimeContext,
  type WorkerFinalizationManifest,
  type WorkerFinalizationStatus,
  type WorkerInvocation,
  type WorkerLaunchManifest,
  type WorkerAgentKind,
  type WorkerCliWrapper,
  type WorkerRuntimePaths,
} from "../lib/worker-launcher"
import { renderHypothesisWorkerPrompt } from "../lib/worker-prompt"

const MAX_WORKER_SHUTDOWN_CUSHION_MS = 90_000
const MIN_WORKER_SHUTDOWN_CUSHION_MS = 15_000
const MAX_WORKER_HARD_STOP_GRACE_MS = 30_000
const BUILTIN_AGENT_MIN_USEFUL_LAUNCH_MS = 5 * 60_000
const CUSTOM_WORKER_MIN_USEFUL_LAUNCH_MS = 30_000
const DEFAULT_FIRST_ATTEMPT_WARNING_MS = 180_000
const MAX_LOCAL_SUPERVISOR_WORKERS = 250
const DEFAULT_REF_PUSH_QUEUE_CONCURRENCY = 4
// Server-side verification is push-webhook-first; the supervisor sweep is a
// backstop for lost webhooks, not the primary heal path.
const GIT_VERIFICATION_BACKSTOP_INTERVAL_MS = 10 * 60_000
const MAX_REF_PUSH_QUEUE_DEPTH = 500
const SUPERVISOR_TELEMETRY_STALE_MS = 45_000
const SUPERVISOR_LOG_DIR = "supervisor-logs"

type IgnoredPresenceState = NonNullable<
  NonNullable<CliState["sessions"]>[string]["ignoredPresence"]
>
type IgnoredPresenceReason =
  ApiResearchPresenceResponse["ignoredWorkers"][number]["reason"]

const PRESENCE_IGNORED_REASONS: IgnoredPresenceReason[] = [
  "not_found",
  "session_mismatch",
  "stale_sequence",
  "unmatched_cap",
  "update_failed",
  "session_not_found",
]
const PRESENCE_IGNORED_RECENT_LIMIT = 20

async function frozenWorkerApiEnv(args: Args) {
  const env: Record<string, string> = {}
  try {
    env.ONYX_API_URL = await apiBaseUrl(args)
  } catch {
    // Leave API URL unset only for low-level local debugging.
  }
  try {
    env.ONYX_API_KEY = await apiKey(args)
  } catch {
    // Leave auth unset when the caller is intentionally offline.
  }
  return env
}

type SessionFinalizationStatus = ApiSession["finalizationStatus"]
type SessionTerminalReason =
  | "experiment_target_reached"
  | "deadline_reached"
  | "user_stopped"
  | "provider_capacity_exhausted"
  | "all_hypotheses_closed"
  | "supervisor_failed"
  | "abandoned"
  | "failed"
type ProviderLaunchFailure = {
  at: string
  reason: string
  workerId: string | null
  hypothesisId: string
  errorSummary: string | null
}
type SupervisorRuntimeTelemetry = NonNullable<
  NonNullable<CliState["sessions"]>[string]["supervisor"]
>

type WorkerActivityEvent = {
  type: string
  phase?: string
  summary?: string
  metadata?: Record<string, unknown>
}

type RefPushQueueJob = {
  reason: string
  cwd: string
  sourceRef: string
  targetRef: string
  manifest?: WorkerLaunchManifest | null
  resolve: (result: ProcessResult) => void
}

type WorkerBranchPusher = (input: {
  cwd: string
  sourceRef: string
  targetRef: string
  reason: string
  manifest?: WorkerLaunchManifest | null
}) => Promise<ProcessResult>

async function appendWorkerActivityEvent(
  manifest: WorkerLaunchManifest,
  event: WorkerActivityEvent
) {
  const record = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    sessionId: manifest.sessionId,
    workerId: manifest.workerId,
    hypothesisId: manifest.hypothesisId,
    hypothesisName: manifest.hypothesisName,
    type: event.type,
    ...(event.phase ? { phase: event.phase } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  }
  await appendFile(
    manifest.activityJsonlPath,
    `${JSON.stringify(record)}\n`,
    "utf8"
  ).catch(() => {})
}

const PIPED_ONYX_MUTATION_COMMAND =
  /\bonyx\s+(?:exp\s+run|exp\s+log|sync|push)\b[^\n|]*\|/i
const PROVIDER_STREAM_ERROR =
  /AI_APICallError|APICallError|Cannot connect to API|socket connection was closed|message="stream error"|stream error/i

async function recordWorkerHarnessWarnings(
  manifest: WorkerLaunchManifest | null | undefined
) {
  if (!manifest) return []
  const log = await readFile(manifest.logPath, "utf8").catch(() => "")
  const lines = log.split(/\r?\n/)
  const warnings: string[] = []
  for (const line of lines) {
    if (PIPED_ONYX_MUTATION_COMMAND.test(line)) {
      warnings.push(
        `piped Onyx mutation command detected: ${line.trim().slice(0, 240)}`
      )
    }
    if (PROVIDER_STREAM_ERROR.test(line)) {
      warnings.push(
        `provider stream/API error detected: ${line.trim().slice(0, 240)}`
      )
    }
    if (warnings.length >= 20) break
  }
  const uniqueWarnings = [...new Set(warnings)].slice(0, 20)
  if (uniqueWarnings.length === 0) return []
  const existing = new Set(manifest.warnings ?? [])
  for (const warning of uniqueWarnings) existing.add(warning)
  manifest.warnings = [...existing]
  await appendFile(
    manifest.activityLogPath,
    uniqueWarnings.map((warning) => `[warning] ${warning}\n`).join(""),
    "utf8"
  ).catch(() => {})
  for (const warning of uniqueWarnings) {
    await appendWorkerActivityEvent(manifest, {
      type: "warning",
      phase: "audit",
      summary: warning,
      metadata: {
        detector: "piped_onyx_mutation_command",
      },
    })
  }
  return uniqueWarnings
}

function mergeIgnoredPresence(
  current: IgnoredPresenceState | undefined,
  response: ApiResearchPresenceResponse,
  at = new Date().toISOString()
): IgnoredPresenceState {
  const byReason: Record<string, number> = {}
  for (const reason of PRESENCE_IGNORED_REASONS) {
    byReason[reason] = current?.byReason?.[reason] ?? 0
  }
  for (const [reason, count] of Object.entries(current?.byReason ?? {})) {
    byReason[reason] = count
  }
  for (const worker of response.ignoredWorkers) {
    byReason[worker.reason] = (byReason[worker.reason] ?? 0) + 1
  }

  const recent = [
    ...(current?.recent ?? []),
    ...response.ignoredWorkers.map((worker) => ({
      id: worker.id,
      reason: worker.reason,
      message: worker.message,
      at,
    })),
  ].slice(-PRESENCE_IGNORED_RECENT_LIMIT)

  return {
    total: (current?.total ?? 0) + response.ignoredCount,
    byReason,
    lastAt: at,
    recent,
  }
}

function formatPresenceReasonCounts(byReason: Record<string, number>) {
  const parts = Object.entries(byReason)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
  return parts.length ? parts.join(", ") : "none"
}

function emptyPresenceReasonCounts() {
  return {
    notFound: 0,
    sessionMismatch: 0,
    staleSequence: 0,
    unmatchedCap: 0,
    updateFailed: 0,
    sessionNotFound: 0,
  }
}

function mergePresenceReasonCounts(
  responses: ApiResearchPresenceResponse[]
): ApiResearchPresenceResponse["ignoredByReason"] {
  const counts = emptyPresenceReasonCounts()
  for (const response of responses) {
    counts.notFound += response.ignoredByReason.notFound
    counts.sessionMismatch += response.ignoredByReason.sessionMismatch
    counts.staleSequence += response.ignoredByReason.staleSequence
    counts.unmatchedCap += response.ignoredByReason.unmatchedCap
    counts.updateFailed += response.ignoredByReason.updateFailed
    counts.sessionNotFound += response.ignoredByReason.sessionNotFound
  }
  return counts
}

function hasPresenceMismatch(response: ApiResearchPresenceResponse) {
  return response.ignoredWorkers.some(
    (worker) => worker.reason === "session_mismatch"
  )
}

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

export function minimumUsefulLaunchMs(agentKind: WorkerAgentKind) {
  return agentKind === "custom"
    ? CUSTOM_WORKER_MIN_USEFUL_LAUNCH_MS
    : BUILTIN_AGENT_MIN_USEFUL_LAUNCH_MS
}

export function canLaunchWorkerBeforeDeadline({
  now,
  endTimeMs,
  shutdownCushionMs,
  agentKind,
}: {
  now: number
  endTimeMs: number
  shutdownCushionMs: number
  agentKind: WorkerAgentKind
}) {
  const usefulMs = endTimeMs - shutdownCushionMs - now
  return usefulMs >= minimumUsefulLaunchMs(agentKind)
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

function workerBudgetOptions({ maxMinutes }: { maxMinutes: number }) {
  return ` --max-minutes ${maxMinutes}`
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function resolveWorkerModel(
  agentKind: BuiltInWorkerAgent,
  model: string | null | undefined,
  options: { cwd?: string } = {}
) {
  if (!model) return null
  if (agentKind === "opencode") {
    return resolveOpenCodeModelId(model, { cwd: options.cwd })
  }
  return model
}

type WorkerSettings = {
  agentKind: BuiltInWorkerAgent
  workerModel: string | null
}

async function resolveWorkerSettings({
  args,
  sessionMetadata,
  cwd,
}: {
  args: Args
  sessionMetadata?: Record<string, unknown> | null
  cwd?: string
}): Promise<WorkerSettings> {
  const existingAgent = sessionMetadata
    ? metadataString(sessionMetadata, "agentKind")
    : null
  const existingModel = sessionMetadata
    ? metadataString(sessionMetadata, "workerModel")
    : null
  if (existingAgent) {
    const agentKind = validateBuiltInWorkerAgent(existingAgent)
    if (args.options.agent !== undefined && args.options.agent !== agentKind) {
      throw new Error(
        `Research session already uses --agent ${agentKind}; create a new session to use ${args.options.agent}.`
      )
    }
    const requestedModel =
      args.options.model === undefined
        ? undefined
        : await resolveWorkerModel(
            agentKind,
            normalizeWorkerModel(args.options.model),
            { cwd }
          )
    if (args.options.model !== undefined && requestedModel !== existingModel) {
      throw new Error(
        existingModel
          ? `Research session already uses --model ${existingModel}; create a new session to use ${requestedModel ?? "(default)"}.`
          : `Research session has no worker model; create a new session to use ${requestedModel ?? "(default)"}.`
      )
    }
    return {
      agentKind,
      workerModel: await resolveWorkerModel(agentKind, existingModel, { cwd }),
    }
  }

  const config = await readConfig()
  const profileName = profileNameFromArgs(args, config)
  const profile = profileName ? config.profiles[profileName] : undefined
  const agentKind = validateBuiltInWorkerAgent(
    args.options.agent ??
      process.env.ONYX_WORKER_AGENT ??
      profile?.worker?.agent ??
      "codex"
  )
  const workerModel = await resolveWorkerModel(
    agentKind,
    normalizeWorkerModel(args.options.model) ??
      normalizeWorkerModel(process.env.ONYX_WORKER_MODEL) ??
      normalizeWorkerModel(profile?.worker?.models?.[agentKind]) ??
      null,
    { cwd }
  )
  return { agentKind, workerModel }
}

function workerModelMetadata(workerModel: string | null) {
  return workerModel ? { workerModel } : {}
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
  return ["registered", "running"].includes(worker.status)
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

function workerStatusFromManifest(
  manifest: WorkerLaunchManifest
): ApiWorker["status"] {
  const terminal = terminalStatusFromManifest(manifest)
  if (terminal) return terminal
  return manifest.status === "starting" ? "registered" : "running"
}

function apiWorkerFromManifest({
  manifest,
  campaignId,
  sessionId,
  observedAt,
}: {
  manifest: WorkerLaunchManifest
  campaignId: string
  sessionId: string
  observedAt: string
}): ApiWorker {
  return {
    id: manifest.workerId,
    campaignId,
    sessionId,
    hypothesisId: manifest.hypothesisId,
    workerName: manifest.workerName,
    agentKind: manifest.agentKind,
    runtime: "local",
    status: workerStatusFromManifest(manifest),
    currentExperimentId: null,
    phase: manifest.status,
    progressMessage: null,
    gitLabel: manifest.finalization?.commitSha ?? null,
    lastSeenAt:
      manifest.lastOutputAt ??
      manifest.completedAt ??
      manifest.startedAt ??
      observedAt,
    startedAt: manifest.startedAt,
    metadata: {
      workerModel: manifest.workerModel,
      source: "worker-manifest",
    },
    createdAt: manifest.startedAt,
    updatedAt:
      manifest.completedAt ??
      manifest.lastOutputAt ??
      manifest.startedAt ??
      observedAt,
  }
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function optionalUuid(value: string | undefined, label: string) {
  if (value === undefined) return undefined
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID, not "${value}".`)
  }
  return value
}

function createRefPushQueue({ args }: { args: Args }) {
  const maxConcurrency = positiveIntegerOption(
    args,
    "ref-push-concurrency",
    DEFAULT_REF_PUSH_QUEUE_CONCURRENCY
  )
  const queue: RefPushQueueJob[] = []
  const idleWaiters = new Set<() => void>()
  let active = 0
  let stopped = false

  const depth = () => queue.length + active
  const notifyIdle = () => {
    if (depth() > 0) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }
  const emitJobEvent = async (
    job: RefPushQueueJob,
    summary: string,
    metadata: Record<string, unknown>
  ) => {
    if (!job.manifest) return
    await appendWorkerActivityEvent(job.manifest, {
      type: "push_result",
      phase: "pushing",
      summary,
      metadata: {
        reason: job.reason,
        ...metadata,
      },
    })
  }
  const failedProcessResult = (message: string): ProcessResult => ({
    code: 1,
    stdout: "",
    stderr: message,
    timedOut: false,
  })
  const runPushRefJob = async (job: RefPushQueueJob) => {
    try {
      const result = await gitResult(
        ["push", "origin", `${job.sourceRef}:${job.targetRef}`],
        job.cwd
      )
      if (result.code === 0 && !result.timedOut) {
        await emitJobEvent(job, "Git ref pushed", {
          ref: job.targetRef,
        })
      } else {
        await emitJobEvent(job, "Git ref push failed", {
          ref: job.targetRef,
          error: result.stderr.trim() || result.stdout.trim(),
        })
      }
      job.resolve(result)
    } catch (error) {
      await emitJobEvent(job, "Git ref push failed", {
        ref: job.targetRef,
        error: errorMessage(error),
      })
      job.resolve(failedProcessResult(errorMessage(error)))
    }
  }
  const runJob = async (job: RefPushQueueJob) => {
    await runPushRefJob(job).finally(() => {
      active -= 1
      pump()
      notifyIdle()
    })
  }
  const pump = () => {
    while (active < maxConcurrency && queue.length > 0) {
      const job = queue.shift()!
      active += 1
      void runJob(job)
    }
  }
  const enqueue = (job: RefPushQueueJob) => {
    if (stopped) return null
    if (depth() >= MAX_REF_PUSH_QUEUE_DEPTH) return null
    queue.push(job)
    pump()
    return depth()
  }
  const waitForIdle = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    while (depth() > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()))
        idleWaiters.add(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    return depth()
  }

  return {
    pushRef({
      cwd,
      sourceRef,
      targetRef,
      reason,
      manifest,
    }: {
      cwd: string
      sourceRef: string
      targetRef: string
      reason: string
      manifest?: WorkerLaunchManifest | null
    }) {
      return new Promise<ProcessResult>((resolve) => {
        const accepted = enqueue({
          reason,
          cwd,
          sourceRef,
          targetRef,
          manifest,
          resolve,
        })
        if (accepted === null) {
          resolve(failedProcessResult("ref push queue rejected job"))
        }
      })
    },
    depth,
    waitForIdle,
    async drain(timeoutMs: number) {
      stopped = true
      return waitForIdle(timeoutMs)
    },
    stop() {
      stopped = true
    },
  }
}

function createPresenceSupervisor({
  root,
  args,
  sessionId,
  supervisorRunId,
  intervalMs,
  leaseTokensByWorkerId,
}: {
  root: string
  args: Args
  sessionId: string
  supervisorRunId: string
  intervalMs: number
  leaseTokensByWorkerId: Map<string, string>
}) {
  const lastSent = new Map<string, string>()
  let sequence = 0
  let lastFullSnapshotAt = 0
  let lastLeaseRenewalAt = 0
  let running: Promise<void> | null = null
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  type PresenceSnapshotOptions = {
    forceFull?: boolean
    terminal?: boolean
  }

  const normalizeSnapshotOptions = (
    options: boolean | PresenceSnapshotOptions = {}
  ): PresenceSnapshotOptions =>
    typeof options === "boolean" ? { forceFull: options } : options

  const snapshotStatus = ({
    worker,
    manifest,
    latest,
  }: {
    worker: ApiWorker
    manifest?: WorkerLaunchManifest | null
    latest?: WorkerLatestState | null
  }): ApiWorker["status"] => {
    const manifestStatus = manifest ? workerStatusFromManifest(manifest) : null
    if (manifestStatus && !workerIsActive({ status: manifestStatus })) {
      return manifestStatus
    }
    if (latest?.status && !workerIsActive({ status: latest.status })) {
      return latest.status
    }
    if (
      latest?.status === "registered" &&
      latest.phase &&
      latest.phase !== "registered" &&
      latest.phase !== "starting"
    ) {
      return "running"
    }
    return latest?.status ?? manifestStatus ?? worker.status
  }

  const snapshot = async (
    rawOptions: boolean | PresenceSnapshotOptions = {}
  ) => {
    const options = normalizeSnapshotOptions(rawOptions)
    const forceFull = options.forceFull ?? false
    const terminal = options.terminal ?? false
    if (args.options.offline === "true") return
    const state = await getLocalSessionState(root, sessionId)
    const cliState = await readState(root).catch(() => null)
    const manifests = await readWorkerLaunchManifests(root, sessionId)
    const manifestByWorker = new Map(
      manifests.map((manifest) => [manifest.workerId, manifest])
    )
    const latestByWorker = new Map(
      await Promise.all(
        manifests.map(
          async (manifest) =>
            [manifest.workerId, await readWorkerLatestState(manifest)] as const
        )
      )
    )
    const observedAt = new Date().toISOString()
    const sessionRuntimeState = cliState?.sessions?.[sessionId]
    const supervisorTelemetry = freshSupervisorTelemetry(
      sessionRuntimeState?.supervisor
    )
    const providerBackoff =
      supervisorTelemetry?.providerBackoff ??
      sessionRuntimeState?.providerBackoff ??
      null
    const failedLaunchCount =
      supervisorTelemetry?.recentFailedLaunches?.length ??
      providerBackoff?.recentFailures?.length ??
      0
    const workerById = new Map<string, ApiWorker>()
    for (const worker of state.workers.filter(
      (worker) => worker.sessionId === sessionId
    )) {
      workerById.set(worker.id, worker)
    }
    for (const manifest of manifests) {
      if (workerById.has(manifest.workerId)) continue
      workerById.set(
        manifest.workerId,
        apiWorkerFromManifest({
          manifest,
          campaignId: state.campaign.id,
          sessionId,
          observedAt,
        })
      )
    }
    const workersForPresence = [...workerById.values()]
    const activeWorkerCount = terminal
      ? 0
      : workersForPresence.filter((worker) => {
          const manifest = manifestByWorker.get(worker.id)
          const latest = manifest ? latestByWorker.get(worker.id) : null
          return workerIsActive({
            status: snapshotStatus({ worker, manifest, latest }),
          })
        }).length
    const unmeasuredSalvageCount = manifests.filter(
      (manifest) =>
        manifest.finalization?.salvaged &&
        manifest.finalization.finalizationStatus.startsWith(
          "salvaged_unmeasured"
        )
    ).length
    const workerSnapshots = workersForPresence.map((worker) => {
      const manifest = manifestByWorker.get(worker.id)
      const latest = manifest ? latestByWorker.get(worker.id) : null
      const metadata = manifest
        ? {
            ...(latest?.metadata ?? {}),
            workerLogPath: manifest.logPath,
            workerActivityLogPath: manifest.activityLogPath,
            workerActivityJsonlPath: manifest.activityJsonlPath,
            workerPromptPath: manifest.promptPath,
            latestStatePath: manifest.latestStatePath,
            manifestPath: manifest.manifestPath,
            latestObservedAt: latest?.at ?? null,
            warnings: manifest.warnings ?? [],
            finalizationStatus:
              manifest.finalization?.finalizationStatus ?? null,
          }
        : {}
      const status = snapshotStatus({ worker, manifest, latest })
      const snapshot = {
        id: worker.id,
        status,
        phase: latest?.phase ?? manifest?.status ?? worker.phase,
        progressMessage: latest?.progressMessage ?? worker.progressMessage,
        gitLabel: worker.gitLabel ?? manifest?.finalization?.commitSha ?? null,
        lastOutputAt: manifest?.lastOutputAt ?? null,
        activitySummary: manifest
          ? activitySummaryForManifest(manifest, latest)
          : undefined,
        metadata,
        observedAt,
      }
      return {
        snapshot,
        signature: JSON.stringify({ ...snapshot, observedAt: undefined }),
      }
    })
    const shouldSendFull =
      forceFull || Date.now() - lastFullSnapshotAt >= 60_000
    const selectedWorkers = workerSnapshots.filter(
      (worker) =>
        shouldSendFull || lastSent.get(worker.snapshot.id) !== worker.signature
    )
    const splitCount = Math.max(1, Math.ceil(selectedWorkers.length / 250))
    const chunks =
      selectedWorkers.length === 0
        ? [[]]
        : Array.from({ length: splitCount }, (_, index) =>
            selectedWorkers.slice(index * 250, index * 250 + 250)
          )
    const responses: ApiResearchPresenceResponse[] = []
    const siteId = await getResearchSiteId(root)
    const unchangedWorkerCount = Math.max(
      0,
      workerSnapshots.length - selectedWorkers.length
    )
    const droppedOrDeferredWorkerCount = 0
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? []
      sequence += 1
      const response = await upsertResearchPresence(
        {
          siteId,
          supervisorRunId,
          sequence,
          sessionId,
          site: {
            activeWorkerCount,
            launchedWorkerCount: workerSnapshots.length,
            failedLaunchCount,
            uploadedWorkerCount: selectedWorkers.length,
            unchangedWorkerCount,
            droppedOrDeferredWorkerCount,
            unmeasuredSalvageCount,
            providerBackoff: terminal ? null : providerBackoff,
            ignoredPresence:
              cliState?.sessions?.[sessionId]?.ignoredPresence ?? {},
            lastUploadAt: observedAt,
            metadata: {
              splitIndex: index + 1,
              splitCount,
              terminal,
            },
          },
          workers: chunk.map((worker) => worker.snapshot),
        },
        args
      )
      responses.push(response)
      for (const worker of chunk) {
        lastSent.set(worker.snapshot.id, worker.signature)
      }
    }
    if (shouldSendFull) lastFullSnapshotAt = Date.now()
    const ignoredCount = responses.reduce(
      (total, response) => total + response.ignoredCount,
      0
    )
    const aggregateResponse: ApiResearchPresenceResponse = {
      ignoredWorkers: responses.flatMap((response) => response.ignoredWorkers),
      ignoredByReason: mergePresenceReasonCounts(responses),
      acceptedCount: responses.reduce(
        (total, response) => total + response.acceptedCount,
        0
      ),
      ignoredCount,
      unmatchedCount: responses.reduce(
        (total, response) => Math.max(total, response.unmatchedCount),
        0
      ),
      uploadedWorkerCount: selectedWorkers.length,
      unchangedWorkerCount,
      droppedOrDeferredWorkerCount,
      deferredStartupTelemetryCount: responses.reduce(
        (total, response) =>
          total + (response.deferredStartupTelemetryCount ?? 0),
        0
      ),
      splitCount,
      siteAccepted: responses.some((response) => response.siteAccepted),
    }
    if (ignoredCount > 0) {
      const observedAt = new Date().toISOString()
      let ignoredPresence = mergeIgnoredPresence(
        undefined,
        aggregateResponse,
        observedAt
      )
      const state = await readState(root).catch(() => null)
      if (state) {
        state.sessions = state.sessions ?? {}
        const current = state.sessions[sessionId] ?? {}
        ignoredPresence = mergeIgnoredPresence(
          current.ignoredPresence,
          aggregateResponse,
          observedAt
        )
        state.sessions[sessionId] = {
          ...current,
          ignoredPresence,
        }
        await writeState(root, state).catch(() => {})
      }
      const reasonSummary = formatPresenceReasonCounts(ignoredPresence.byReason)
      console.warn(
        `Presence upload ignored ${aggregateResponse.ignoredCount} worker update(s): ${reasonSummary}.`
      )
      if (responses.some(hasPresenceMismatch)) {
        console.warn(
          "Presence upload saw project_mismatch or session_mismatch; check worker/session wiring."
        )
      }
    }
    const shouldRenewLeases = Date.now() - lastLeaseRenewalAt >= 30_000
    if (shouldRenewLeases) {
      const heartbeats = workerSnapshots
        .flatMap((worker) => {
          const token = leaseTokensByWorkerId.get(worker.snapshot.id)
          const durable = workerById.get(worker.snapshot.id)
          if (
            !token ||
            !durable?.hypothesisId ||
            !workerIsActive({ status: worker.snapshot.status ?? "running" })
          ) {
            return []
          }
          return [
            {
              workerId: worker.snapshot.id,
              leaseToken: token,
              status: "running" as const,
              sessionId,
              hypothesisId: durable.hypothesisId,
              phase: worker.snapshot.phase ?? "running",
              event: "supervisor_batch_heartbeat",
              progressMessage: worker.snapshot.progressMessage ?? null,
              gitLabel: worker.snapshot.gitLabel ?? null,
              metadata: {
                source: "supervisor",
                supervisorRunId,
              },
            },
          ]
        })
        .slice(0, 500)
      if (heartbeats.length > 0) {
        lastLeaseRenewalAt = Date.now()
        const response = await heartbeatWorkersBatch({ heartbeats }, args)
        const failures = response.results.filter((result) => !result.ok)
        if (failures.length > 0) {
          console.warn(
            `Batch heartbeat reported ${failures.length} worker issue(s); first: ${
              failures[0]?.ok === false ? failures[0].error.message : "unknown"
            }`
          )
        }
      }
    }
  }

  const run = (options: boolean | PresenceSnapshotOptions = {}) => {
    if (running) return running
    running = snapshot(options)
      .catch((error) => {
        if (!stopped) {
          console.warn(
            `Presence upload skipped: ${
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
    async flush(options: PresenceSnapshotOptions = {}) {
      await run({ ...options, forceFull: true }).catch(() => {})
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      await run(true).catch(() => {})
    },
  }
}

export async function waitForStartupSessionReady({
  args,
  sessionId,
  timeoutMs = 30_000,
}: {
  args: Args
  sessionId: string
  timeoutMs?: number
}) {
  if (args.options.offline === "true") return
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      await getResearchSessionControlState(sessionId, args)
      return
    } catch (error) {
      lastError = error
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())))
    }
  }
  throw new Error(
    `Startup session was not readable before launch (${errorMessage(lastError)}).`
  )
}

type SessionFinalizationComputation = {
  status: SessionFinalizationStatus
  reasons: string[]
  live: ApiSessionLive | null
}

async function computeSessionFinalizationStatus({
  root,
  sessionId,
}: {
  root: string
  sessionId: string
}): Promise<SessionFinalizationComputation> {
  const failedReasons: string[] = []
  const incompleteReasons: string[] = []
  const [manifests] = await Promise.all([
    readWorkerLaunchManifests(root, sessionId).catch(() => []),
  ])

  for (let index = 0; index < manifests.length; index += 25) {
    const batch = manifests.slice(index, index + 25)
    if (manifests.length > 25) {
      console.log(
        `finalization check: workers ${index + 1}-${index + batch.length}/${manifests.length}`
      )
    }
    for (const manifest of batch) {
      if (manifest.status === "starting" || manifest.status === "running") {
        incompleteReasons.push(
          `worker ${manifest.workerId} still ${manifest.status}`
        )
      }
      const finalization = manifest.finalization
      if (!finalization) {
        if (
          manifest.status === "completed" ||
          manifest.status === "failed" ||
          manifest.status === "stopped"
        ) {
          incompleteReasons.push(
            `worker ${manifest.workerId} has no finalization result`
          )
        }
        continue
      }
      if (finalization.finalizationStatus === "failed") {
        failedReasons.push(
          `worker ${manifest.workerId} finalization failed${
            finalization.error ? `: ${finalization.error}` : ""
          }`
        )
        continue
      }
      const cleanFinalizationStatus =
        finalization.finalizationStatus === "measured_and_logged" ||
        finalization.finalizationStatus === "already_logged" ||
        finalization.finalizationStatus === "none" ||
        finalization.finalizationStatus === "discarded_after_completion"
      const hasUnresolvedSalvage =
        finalization.finalizationStatus.startsWith("salvaged_unmeasured") ||
        (!cleanFinalizationStatus && finalization.unloggedCommitCount > 0)
      if (hasUnresolvedSalvage) {
        incompleteReasons.push(
          `worker ${manifest.workerId} has unlogged or salvaged work`
        )
      }
      if (finalization.rootDriftStatus === "dirty") {
        incompleteReasons.push(
          `worker ${manifest.workerId} detected root drift`
        )
      }
    }
  }

  const live: ApiSessionLive | null = null

  const reasons = failedReasons.length > 0 ? failedReasons : incompleteReasons
  return {
    status:
      failedReasons.length > 0
        ? "failed"
        : incompleteReasons.length > 0
          ? "incomplete"
          : "complete",
    reasons,
    live,
  }
}

async function writeRemoteSessionFinalization({
  sessionId,
  campaignId,
  status,
  finalization,
  terminalReason,
  args,
  requireOnline = false,
}: {
  sessionId: string
  campaignId: string
  status: "completed" | "failed" | "stopped"
  finalization: SessionFinalizationComputation
  terminalReason?: SessionTerminalReason | null
  args: Args
  requireOnline?: boolean
}) {
  try {
    return await stopCampaignSession(
      sessionId,
      {
        campaignId,
        endReason:
          terminalReason === "provider_capacity_exhausted"
            ? "provider_capacity_exhausted"
            : status === "failed"
              ? "failed"
              : "user_stopped",
        reason:
          finalization.reasons.length > 0
            ? finalization.reasons.slice(0, 5).join("; ")
            : "research session finalized",
        metadata: {
          ...(terminalReason ? { terminalReason } : {}),
          finalizationReasons: finalization.reasons,
        },
      },
      args
    )
  } catch (error) {
    if (requireOnline) throw error
    console.warn(
      `Remote session finalization was not written: ${errorMessage(error)}`
    )
    return null
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
    args.options.campaign ?? state.activeCampaign ?? args.options.name
  if (!campaignName) {
    throw new Error(
      "Pass --campaign <name> or run `onyx campaign use --name <name>`."
    )
  }

  const key = campaignStateKey(projectPath, campaignName)
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
        "Run `onyx setup validate`, fix the listed setup files/tools, and commit the setup surface before `onyx research run`.",
      ].join("\n")
    )
  }
  const metricReadiness = validation.checks.find(
    (check) => check.id === "metric_tool_readiness"
  )
  if (metricReadiness?.status !== "passed") {
    throw new Error(
      [
        "Setup validation has not proven metric tool readiness.",
        "Run `onyx setup validate` after configuring the canonical metric tool, review the metric_tool_readiness check, then commit the setup surface before starting research.",
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

async function ensureWorktree({
  root,
  startingCommitSha,
  sessionId,
  workerId,
}: {
  root: string
  startingCommitSha: string
  sessionId: string
  workerId: string
}) {
  const branch = workerBranchName({ sessionId, workerId })
  const dir = join(await onyxStateDir(root), "worktrees", sessionId, workerId)
  if (!(await pathExists(dir))) {
    await withOnyxLock(root, "git-worktree", async () => {
      if (await pathExists(dir)) return
      await mkdir(join(await onyxStateDir(root), "worktrees", sessionId), {
        recursive: true,
      })
      await git(["worktree", "add", "-B", branch, dir, startingCommitSha], root)
    })
  }
  return { dir, branch }
}

/**
 * Removes a finished worker's worktree so a 100-worker session does not
 * leave 100 working trees on disk. The worker branch and any pushed refs
 * survive removal, so salvage/recovery evidence is unaffected. Set
 * ONYX_KEEP_WORKTREES=1 to keep worktrees for debugging.
 */
async function removeWorkerWorktree({
  root,
  sessionId,
  workerId,
}: {
  root: string
  sessionId: string
  workerId: string
}) {
  if (process.env.ONYX_KEEP_WORKTREES === "1") return
  const sessionDir = join(await onyxStateDir(root), "worktrees", sessionId)
  const dir = join(sessionDir, workerId)
  if (!(await pathExists(dir))) return
  await withOnyxLock(root, "git-worktree", async () => {
    try {
      await git(["worktree", "remove", "--force", dir], root)
    } catch {
      // Leave the directory for the next prune rather than failing the
      // worker lifecycle over cleanup.
      await git(["worktree", "prune"], root).catch(() => {})
    }
    // Last worker out removes the session directory; rmdir refuses to
    // delete a non-empty directory, so earlier workers no-op here.
    await rmdir(sessionDir).catch(() => {})
  })
}

function workerBranchName({
  sessionId,
  workerId,
}: {
  sessionId: string
  workerId: string
}) {
  return [
    "onyx",
    safeBranchSegment(sessionId),
    safeBranchSegment(workerId),
  ].join("/")
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
  const attempts = await listLocalAttempts(root).catch(() => [])
  const commits = new Set<string>()
  for (const record of attempts) {
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
  const attempts = await listLocalAttempts(root).catch(() => [])
  return attempts.some((record) => record.workerId === workerId)
}

async function findRemoteWorkerExperimentForCommit({
  campaignId,
  sessionId,
  workerId,
  resultCommitSha,
  args,
}: {
  campaignId: string
  sessionId: string
  workerId: string
  resultCommitSha: string
  args: Args
}) {
  const page = await listCampaignExperiments(campaignId, args, {
    limit: 5,
    sessionId,
    workerId,
    resultCommitSha,
  })
  return (
    page.items.find(
      (experiment) =>
        experiment.sessionId === sessionId &&
        experiment.workerId === workerId &&
        experiment.resultCommitSha === resultCommitSha
    ) ?? null
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
    commits = (
      await git(
        ["rev-list", "--reverse", `${baseCommitSha}..${headCommitSha}`],
        worktree
      )
    )
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
  if (unloggedCommits.length === 1 && unloggedCommits[0] === headCommitSha) {
    const parentLine = await git(
      ["rev-list", "--parents", "-n", "1", headCommitSha],
      worktree
    )
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
  startingCommitSha,
  sessionId,
  assignmentId,
  workerId,
  workerBranch,
  activityManifest,
  args,
  workerFailed,
  pushWorkerBranch,
}: {
  root: string
  worktree: string
  campaign: ApiCampaign
  hypothesis: ApiHypothesis
  startingCommitSha: string
  sessionId: string
  assignmentId: string
  workerId: string
  workerBranch: string
  activityManifest?: WorkerLaunchManifest | null
  args: Args
  workerFailed: boolean
  pushWorkerBranch: WorkerBranchPusher
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
    const warnings = await recordWorkerHarnessWarnings(activityManifest)
    if (warnings.length > 0) manifest.warnings = warnings
    const headBefore = await currentCommit(worktree)
    const dirty = (await git(["status", "--porcelain"], worktree)).trim()
    const hasResult =
      (Boolean(dirty) && dirty.length > 0) || headBefore !== startingCommitSha
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

    const remoteHeadExperiment = await findRemoteWorkerExperimentForCommit({
      campaignId: campaign.id,
      sessionId,
      workerId,
      resultCommitSha: commit.commitSha,
      args,
    }).catch(() => null)
    if (remoteHeadExperiment) {
      manifest.unloggedCommitCount = 0
      manifest.measurementBaseCommitSha = null
      manifest.finalizationStatus = "already_logged"
      manifest.salvaged = false
    }

    if (manifest.finalizationStatus === "none") {
      const loggedCommits = await localExperimentCommitSetFor({
        root,
        campaignName: campaign.name,
        hypothesisId: hypothesis.id,
      })
      const analysis = await analyzeFinalizationCommits({
        worktree,
        baseCommitSha: startingCommitSha,
        headCommitSha: commit.commitSha,
        loggedCommits,
      })
      manifest.unloggedCommitCount = analysis.unloggedCommits.length
      manifest.measurementBaseCommitSha = analysis.measurementBaseCommitSha

      if (analysis.kind === "already_logged") {
        manifest.finalizationStatus = "already_logged"
        manifest.salvaged = false
        manifest.unloggedCommitCount = 0
      } else if (analysis.kind === "salvage_only") {
        const stopCheck = await collectResearchStopReasons({
          root,
          sessionId,
        }).catch(() => null)
        if (stopCheck?.shouldStop) {
          manifest.finalizationStatus = "discarded_after_completion"
          manifest.salvaged = false
          manifest.error = [
            "Session stop condition reached before final measurement; discarded unlogged work without creating an experiment.",
            analysis.reason,
          ]
            .filter(Boolean)
            .join(" ")
          if (activityManifest) {
            await appendWorkerActivityEvent(activityManifest, {
              type: "finalization",
              phase: "discarded",
              summary: "Session completed before final measurement",
              metadata: {
                finalizationStatus: manifest.finalizationStatus,
                unloggedCommitCount: analysis.unloggedCommits.length,
                stopReasons: stopCheck.reasons,
                salvageReason: analysis.reason,
              },
            })
          }
        } else {
          manifest.finalizationStatus = "salvaged_unmeasured"
          manifest.salvaged = true
          manifest.error = analysis.reason
        }
      } else {
        const measurementBaseCommitSha = analysis.measurementBaseCommitSha
        const stopCheck = await collectResearchStopReasons({
          root,
          sessionId,
        }).catch(() => null)
        if (stopCheck?.shouldStop) {
          manifest.finalizationStatus = "discarded_after_completion"
          manifest.salvaged = false
          manifest.error =
            "Session stop condition reached before final measurement; discarded unlogged work without creating an experiment."
          if (activityManifest) {
            await appendWorkerActivityEvent(activityManifest, {
              type: "finalization",
              phase: "discarded",
              summary: "Session completed before final measurement",
              metadata: {
                finalizationStatus: manifest.finalizationStatus,
                measurementBaseCommitSha,
                unloggedCommitCount: analysis.unloggedCommits.length,
                stopReasons: stopCheck.reasons,
              },
            })
          }
        } else {
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
                assignment: assignmentId,
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
                assignment: assignmentId,
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
            .then(async (record) => {
              manifest.finalizationStatus = "measured_and_logged"
              if (record && activityManifest) {
                await appendWorkerActivityEvent(activityManifest, {
                  type: "metrics",
                  phase: "measured",
                  summary: `${record.primaryMetricName}=${record.primaryMetricValue ?? "null"}`,
                  metadata: {
                    runRef: record.runRef,
                    status: record.status,
                    primaryMetricName: record.primaryMetricName,
                    primaryMetricValue: record.primaryMetricValue,
                    metrics:
                      "metrics" in record
                        ? record.metrics
                        : record.secondaryMetrics,
                    resultCommitSha: record.resultCommitSha,
                    resultRef: record.resultRef,
                  },
                })
              }
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
      }
    }

    if (
      manifest.finalizationStatus.startsWith("salvaged_unmeasured") ||
      manifest.finalizationStatus === "discarded_after_completion"
    ) {
      await abandonBlockedWorkflowRunsForSession({
        root,
        sessionId,
        workerId,
        hypothesisId: hypothesis.id,
        reason: `Worker finalization ${manifest.finalizationStatus}; workflow no longer represents a loggable attempt.`,
      }).catch(() => [])
    }

    const workerBranchPush = await pushWorkerBranch({
      cwd: worktree,
      sourceRef: "HEAD",
      targetRef: `refs/heads/${workerBranch}`,
      reason: "worker-branch-finalization",
      manifest: activityManifest,
    })
    if (workerBranchPush.code === 0 && !workerBranchPush.timedOut) {
      manifest.workerBranchPushStatus = "pushed"
      if (activityManifest) {
        await appendWorkerActivityEvent(activityManifest, {
          type: "push_result",
          phase: "pushing",
          summary: "Worker branch pushed",
          metadata: {
            ref: `refs/heads/${workerBranch}`,
            commitSha: manifest.commitSha,
          },
        })
      }
    } else {
      manifest.workerBranchPushStatus = "failed"
      const workerBranchPushError =
        workerBranchPush.stderr.trim() ||
        workerBranchPush.stdout.trim() ||
        "worker branch push failed"
      manifest.error = [manifest.error, workerBranchPushError]
        .filter(Boolean)
        .join("; ")
      if (activityManifest) {
        await appendWorkerActivityEvent(activityManifest, {
          type: "push_result",
          phase: "pushing",
          summary: "Worker branch push failed",
          metadata: {
            ref: `refs/heads/${workerBranch}`,
            commitSha: manifest.commitSha,
            error: manifest.error,
          },
        })
      }
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
    campaignName: campaign.name,
    goal: setup.goal ?? campaign.description ?? "not specified",
    hypothesisId: hypothesis.id,
    hypothesisName: hypothesis.name,
    hypothesisPlan: hypothesis.plan,
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
  const summary = compactProviderErrorSummary(
    result.stderr.trim() || result.stdout.trim() || "no output"
  )
  if (result.timedOut) {
    return `${label} timed out${summary === "no output" ? "" : `: ${summary}`}`
  }
  if (result.code === 0) return null
  const logPath = "logPath" in result ? result.logPath : null
  return `${label} failed (${result.code ?? "signal"}): ${summary}${
    logPath ? ` (log: ${logPath})` : ""
  }`
}

export function compactProviderErrorSummary(input: string | null | undefined) {
  const raw = input ?? ""
  const summaries: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        for (const key of ["error", "message", "code", "type", "subtype"]) {
          const value = parsed[key]
          if (typeof value === "string" && value.trim()) {
            summaries.push(`${key}: ${value.trim()}`)
          }
        }
        if (summaries.length > 0) continue
      } catch {
        // Fall through to textual compaction.
      }
    }
    summaries.push(trimmed)
  }
  const compacted = (summaries.join(" ") || raw || "no output")
    .replace(/"signature"\s*:\s*"[^"]+"/gi, '"signature":"[redacted]"')
    .replace(/"thinking"\s*:\s*"[^"]+"/gi, '"thinking":"[redacted]"')
    .replace(/\b[A-Za-z0-9+/=_-]{96,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
  return compacted.length > 500 ? `${compacted.slice(0, 497)}...` : compacted
}

export type ResearchStopReasonCode =
  | "stop_requested"
  | "session_terminal"
  | "deadline_reached"
  | "experiment_target_reached"

export type ResearchStopCheck = {
  shouldStop: boolean
  sessionId: string
  reasonCodes: ResearchStopReasonCode[]
  reasons: string[]
  controlState?: ApiSessionControlState
}

function addResearchStopReason(
  reasonCodes: Set<ResearchStopReasonCode>,
  reasons: string[],
  code: ResearchStopReasonCode,
  reason: string
) {
  reasonCodes.add(code)
  if (!reasons.includes(reason)) reasons.push(reason)
}

function terminalReasonForStopCheck(
  stopCheck: ResearchStopCheck
): SessionTerminalReason | null {
  if (stopCheck.reasonCodes.includes("stop_requested")) {
    return "user_stopped"
  }
  if (stopCheck.reasonCodes.includes("experiment_target_reached")) {
    return "experiment_target_reached"
  }
  if (stopCheck.reasonCodes.includes("deadline_reached")) {
    return "deadline_reached"
  }
  return null
}

export async function collectResearchStopReasons({
  root,
  sessionId,
  nowMs = Date.now(),
}: {
  root: string
  sessionId: string
  nowMs?: number
}): Promise<ResearchStopCheck> {
  const localCheck = await collectLocalResearchStopReasons({
    root,
    sessionId,
    nowMs,
  })
  const reasons = [...localCheck.reasons]
  const reasonCodes = new Set<ResearchStopReasonCode>(
    localCheck.reasonCodes as ResearchStopReasonCode[]
  )

  return {
    shouldStop: reasons.length > 0,
    sessionId,
    reasonCodes: [...reasonCodes],
    reasons,
    ...(localCheck.controlState
      ? { controlState: localCheck.controlState }
      : {}),
  }
}

export function createResearchSessionStopChecker({
  root,
  sessionId,
  assignmentId,
  args,
  settleBeforeCheck = false,
  settlementNudgeIntervalMs = 5_000,
}: {
  root: string
  sessionId: string
  assignmentId?: string
  args: Args
  settleBeforeCheck?: boolean
  settlementNudgeIntervalMs?: number
}) {
  let lastSettlementNudgeMs = 0
  return {
    async check({ nowMs = Date.now() }: { nowMs?: number } = {}) {
      try {
        const shouldNudge =
          settleBeforeCheck &&
          nowMs - lastSettlementNudgeMs >= settlementNudgeIntervalMs
        let control: Awaited<ReturnType<typeof getResearchSessionControlState>>
        if (shouldNudge) {
          lastSettlementNudgeMs = nowMs
          control = await settleResearchSession(sessionId, args, {
            mode: "try",
          }).catch(() => getResearchSessionControlState(sessionId, args))
        } else {
          control = await getResearchSessionControlState(sessionId, args)
        }
        const reasons: string[] = []
        const reasonCodes = new Set<ResearchStopReasonCode>()
        const add = (code: ResearchStopReasonCode, reason: string) =>
          addResearchStopReason(reasonCodes, reasons, code, reason)
        if (control.status !== "running") {
          add(
            control.progress.terminalReason === "user_stopped"
              ? "stop_requested"
              : control.progress.terminalReason ===
                    "experiment_target_reached" ||
                  control.progress.terminalReason === "deadline_reached"
                ? control.progress.terminalReason
                : "session_terminal",
            `session ${control.status}`
          )
        }
        if (
          control.progress.deadlineAt &&
          nowMs >= Date.parse(control.progress.deadlineAt)
        ) {
          add("deadline_reached", "deadline reached")
        }
        if (control.progress.remainingExperimentCount === 0) {
          add("experiment_target_reached", "experiment target reached")
        }
        if (
          assignmentId &&
          control.assignments.some(
            (assignment) =>
              assignment.id === assignmentId && assignment.canceledAt !== null
          )
        ) {
          add("stop_requested", "hypothesis assignment canceled")
        }
        return {
          shouldStop: reasons.length > 0,
          sessionId,
          reasonCodes: [...reasonCodes],
          reasons,
          controlState: control,
        }
      } catch {
        return collectResearchStopReasons({
          root,
          sessionId,
          nowMs,
        })
      }
    },
  }
}

function createSessionStateBriefRefresher({
  root,
  sessionId,
  args,
  intervalMs = 5_000,
}: {
  root: string
  sessionId: string
  args: Args
  intervalMs?: number
}) {
  let latestSnapshot: SessionStateBriefSnapshot | null = null
  let sequence = 0
  let lastRefreshAttemptMs = 0
  let inFlight: Promise<void> | null = null

  const write = async (snapshot: SessionStateBriefSnapshot) => {
    latestSnapshot = snapshot
    sequence = Math.max(sequence, snapshot.sequence)
    await writeSessionStateBriefSnapshot({ root, sessionId, snapshot })
  }

  const writePlaceholder = async () => {
    await write(placeholderSessionStateBrief())
  }

  const refresh = ({ force = false }: { force?: boolean } = {}) => {
    const nowMs = Date.now()
    if (inFlight) return inFlight
    if (!force && nowMs - lastRefreshAttemptMs < intervalMs) {
      return Promise.resolve()
    }
    lastRefreshAttemptMs = nowMs
    const lastRefreshAttemptAt = new Date(nowMs).toISOString()
    inFlight = (async () => {
      try {
        const brief = await getResearchSessionStateBrief(sessionId, args)
        await write({
          schemaVersion: 1,
          sequence: sequence + 1,
          refreshStatus: "ok",
          generatedAt: brief.generatedAt,
          fetchedAt: new Date().toISOString(),
          lastRefreshAttemptAt,
          lastError: null,
          message: null,
          brief,
        })
      } catch (error) {
        const previous = latestSnapshot
        await write({
          schemaVersion: 1,
          sequence,
          refreshStatus: "failed",
          generatedAt: previous?.generatedAt ?? new Date().toISOString(),
          fetchedAt: previous?.fetchedAt ?? null,
          lastRefreshAttemptAt,
          lastError: errorMessage(error),
          message: previous?.brief
            ? "Supervisor could not refresh remote state; using previous session state brief."
            : "Supervisor could not fetch remote session state brief yet.",
          brief: previous?.brief ?? null,
        })
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  return { writePlaceholder, refresh }
}

async function harnessShouldStopSession({
  checker,
}: {
  checker: ReturnType<typeof createResearchSessionStopChecker>
}) {
  const result = await checker.check()
  return result.shouldStop
}

async function withWorkerHeartbeat<T>({
  root,
  args,
  workerId,
  leaseToken,
  sessionId,
  hypothesisId,
  latestStatePath,
  phase,
  progressMessage,
  metadata,
  quiet = false,
  consoleEveryMs = 30_000,
  heartbeatSampleEveryMs = 60_000,
  run,
}: {
  root: string
  args: Args
  workerId: string
  leaseToken?: string
  sessionId: string
  hypothesisId: string
  latestStatePath?: string | null
  phase: string
  progressMessage: string | (() => string)
  metadata?: () => Record<string, unknown>
  quiet?: boolean
  consoleEveryMs?: number
  heartbeatSampleEveryMs?: number
  run: () => Promise<T>
}): Promise<T> {
  void root
  let lastConsoleAt = 0
  let lastSampleAt = Date.now()
  const publishProgress = async (sample: boolean) => {
    const now = Date.now()
    const message =
      typeof progressMessage === "function"
        ? progressMessage()
        : progressMessage
    const shouldSample =
      sample &&
      heartbeatSampleEveryMs > 0 &&
      now - lastSampleAt >= heartbeatSampleEveryMs
    if (shouldSample) lastSampleAt = now
    const snapshotMetadata = metadata?.()
    let latestWrite: Promise<void> = Promise.resolve()
    if (latestStatePath) {
      latestWrite = writeWorkerLatestState(latestStatePath, {
        schemaVersion: 1,
        at: new Date(now).toISOString(),
        sessionId,
        workerId,
        hypothesisId,
        status: "running",
        phase,
        progressMessage: message,
        metadata: snapshotMetadata,
      }).catch(() => {})
    }
    if (shouldSample) {
      void heartbeatWorker(
        workerId,
        {
          leaseToken,
          status: "running",
          sessionId,
          hypothesisId,
          phase,
          event: "heartbeat_sampled",
          progressMessage: message,
          metadata: snapshotMetadata,
        },
        args
      ).catch(() => {})
    }
    if (!quiet && now - lastConsoleAt >= consoleEveryMs) {
      lastConsoleAt = now
      console.log(`worker progress: ${message}`)
    }
    await latestWrite
  }
  await publishProgress(false)
  const timer = setInterval(() => {
    void publishProgress(true)
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

export function finalizationStatusLabel(status: WorkerFinalizationStatus) {
  switch (status) {
    case "none":
      return "no result changes"
    case "already_logged":
      return "already logged"
    case "measured_and_logged":
      return "measured and logged"
    case "salvaged_unmeasured":
      return "salvaged without measurement"
    case "discarded_after_completion":
      return "discarded after session completion"
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
    ...workerModelMetadata(invocation.workerModel ?? null),
    workerLogPath: manifest.logPath,
    workerActivityLogPath: manifest.activityLogPath,
    workerActivityJsonlPath: manifest.activityJsonlPath,
    workerLatestStatePath: manifest.latestStatePath,
    workerPromptPath: manifest.promptPath,
    lastOutputAt: manifest.lastOutputAt,
    version: manifest.version,
    onyxWorkerPath: manifest.onyxWorkerPath,
    workerContextPath: manifest.workerContextPath,
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
        onyxWorkerPath: manifest.onyxWorkerPath,
        workerContextPath: manifest.workerContextPath,
        latestStatePath: manifest.latestStatePath,
        addedWritableRoots: manifest.addedWritableRoots,
        ...workerModelMetadata(manifest.workerModel ?? null),
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
  leaseUnavailable?: boolean
  startupTimedOut?: boolean
}

function isLeaseUnavailableError(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    /no_worker_slots|no_active_hypotheses|session_not_running|session_deadline_reached|experiment_target_reached/i.test(
      error.message
    )
  )
}

function isRetryableBatchLeaseError(error: unknown) {
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  return true
}

async function runHypothesisOnce({
  root,
  projectPath,
  campaign,
  setup,
  sessionId,
  supervisorRunId,
  hypothesis,
  workerCommand,
  agentKind,
  workerModel,
  endTimeMs,
  hardEndTimeMs,
  workerTimeoutMs,
  startupTimeoutMs,
  stopGraceMs,
  quiet,
  refPushQueue,
  preacquiredLease,
  slotIndex = null,
  onRegistered,
  args,
}: {
  root: string
  projectPath: string
  campaign: ApiCampaign
  setup: ResearchSetupFile
  sessionId: string
  supervisorRunId: string
  hypothesis: ApiHypothesis
  workerCommand?: string
  agentKind: string
  workerModel: string | null
  endTimeMs: number
  hardEndTimeMs: number
  workerTimeoutMs: number
  startupTimeoutMs: number
  stopGraceMs: number
  quiet: boolean
  refPushQueue: ReturnType<typeof createRefPushQueue>
  preacquiredLease?: ApiWorkerLease | null
  /** Supervisor capacity slot this worker occupies (stable across relaunches). */
  slotIndex?: number | null
  onRegistered?: (worker: {
    workerId: string
    hypothesisId: string
    leaseToken: string
  }) => void
  args: Args
}): Promise<HypothesisRunResult> {
  let workerId: string | undefined
  let leaseToken: string | undefined
  let resultCommitSha: string | undefined
  let workerBranch = "unknown"
  let launchManifest: WorkerLaunchManifest | null = null
  let launchPersistQueue: Promise<void> = Promise.resolve()
  const persistLaunchManifest = (manifest: WorkerLaunchManifest) => {
    const snapshot = manifest
    const write = launchPersistQueue
      .catch(() => {})
      .then(() =>
        persistWorkerLaunchState({ root, manifest: snapshot, workerBranch })
      )
    launchPersistQueue = write
    return write
  }
  let workerCliWrapper: WorkerCliWrapper | null = null
  let runtimePaths: WorkerRuntimePaths | null = null
  const cleanupWorkerRuntimeTempDir = async () => {
    if (!runtimePaths) return
    await rm(runtimePaths.tempDir, { recursive: true, force: true }).catch(
      () => {}
    )
  }

  try {
    const effectiveAgentKind = workerCommand ? "custom" : agentKind
    const lease =
      preacquiredLease ??
      (await acquireResearchWorkerLease(
        sessionId,
        {
          siteId: await getResearchSiteId(root),
          supervisorRunId,
          workerName: `${hypothesis.name}-${effectiveAgentKind}`,
          agentKind: effectiveAgentKind,
          runtime: "local",
          leaseSeconds: 180,
          metadata: workerModelMetadata(workerModel),
        },
        args
      ).catch((error) => {
        if (isLeaseUnavailableError(error)) {
          return null
        }
        throw error
      }))
    if (!lease) {
      return {
        hypothesis,
        status: "stopped",
        leaseUnavailable: true,
        error: "server did not grant a worker lease",
      }
    }
    const worker = lease.worker
    leaseToken = lease.leaseToken
    hypothesis = lease.hypothesis
    workerId = worker.id
    await registerLocalWorker({
      root,
      campaignId: campaign.id,
      sessionId,
      hypothesisId: hypothesis.id,
      workerId: worker.id,
      workerName: worker.workerName,
      agentKind: worker.agentKind,
      runtime: worker.runtime,
      metadata: worker.metadata,
    }).catch(() => {})
    onRegistered?.({
      workerId: worker.id,
      hypothesisId: hypothesis.id,
      leaseToken,
    })
    await heartbeatWorker(
      worker.id,
      {
        leaseToken,
        status: "running",
        sessionId,
        hypothesisId: hypothesis.id,
        phase: "starting",
        event: "hypothesis_started",
        progressMessage: `Preparing ${hypothesis.name} worker preflight`,
        metadata: workerModelMetadata(workerModel),
      },
      args
    )

    const worktreeInfo = await ensureWorktree({
      root,
      startingCommitSha: lease.assignment.startingCommitSha,
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
      endTimeMs,
    })
    runtimePaths = await workerRuntimePaths({
      root,
      sessionId,
      workerId: worker.id,
    })
    const projectRoot = projectPath ? join(worktree, projectPath) : worktree
    await writeWorkerRuntimeContext({
      paths: runtimePaths,
      context: {
        schemaVersion: 2,
        campaignId: campaign.id,
        campaignName: campaign.name,
        sessionId,
        assignmentId: lease.assignment.id,
        startingCommitSha: lease.assignment.startingCommitSha,
        hypothesisId: hypothesis.id,
        hypothesisName: hypothesis.name,
        workerId: worker.id,
        workerLeaseToken: leaseToken,
        workerBranch,
        worktreeRoot: worktree,
        projectPath,
        projectRoot,
        setupFile: setupPath(worktree, projectPath),
        validationFile: validationPath(worktree, projectPath),
        researchSpecFile: onyxPath(worktree, projectPath, "onyx.md"),
      },
    })
    workerCliWrapper = await writeWorkerCliWrapper({ paths: runtimePaths })
    const workerBaseEnv = workerRuntimeEnvironment({
      baseEnv: process.env,
      wrapper: workerCliWrapper,
      paths: runtimePaths,
    })
    const workerApiEnv = await frozenWorkerApiEnv(args)
    const workerRunEnv = {
      ...workerBaseEnv,
      ...workerApiEnv,
      ONYX_CAMPAIGN_ID: campaign.id,
      ONYX_CAMPAIGN_NAME: campaign.name,
      ONYX_SESSION_ID: sessionId,
      ONYX_HYPOTHESIS_ID: hypothesis.id,
      ONYX_HYPOTHESIS_NAME: hypothesis.name,
      ONYX_WORKER_BRANCH: workerBranch,
      ONYX_WORKER_ID: worker.id,
      ONYX_WORKER_LEASE_TOKEN: leaseToken,
      ONYX_WORKER_PROMPT_FILE: prompt.path,
      ONYX_WORKTREE_ROOT: worktree,
      ONYX_PROJECT_ROOT: projectRoot,
      ONYX_SETUP_FILE: setupPath(worktree, projectPath),
      ONYX_VALIDATION_FILE: validationPath(worktree, projectPath),
      ONYX_RESEARCH_SPEC_FILE: onyxPath(worktree, projectPath, "onyx.md"),
      ONYX_RESEARCH_DEADLINE_AT: new Date(
        prompt.researchDeadlineMs
      ).toISOString(),
      ONYX_SHUTDOWN_DEADLINE_AT: new Date(
        prompt.shutdownDeadlineMs
      ).toISOString(),
      ONYX_SHUTDOWN_CUSHION_SECONDS: String(
        Math.ceil(prompt.shutdownCushionMs / 1000)
      ),
      ...(effectiveAgentKind === "opencode"
        ? { OPENCODE_DISABLE_PROJECT_CONFIG: "1" }
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
      workerModel,
      workerTitle: worker.id,
    })
    await heartbeatWorker(
      worker.id,
      {
        leaseToken,
        status: "running",
        sessionId,
        hypothesisId: hypothesis.id,
        phase: "orienting",
        event: "context_ready",
        progressMessage: `Worker context files are ready for ${hypothesis.name}`,
        metadata: workerModelMetadata(workerModel),
      },
      args
    )
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
      workerModel: invocation.workerModel ?? null,
      command: invocation.command,
      args: invocation.redactedArgs,
      onyxWorkerPath: workerCliWrapper.workerPath,
      workerContextPath: runtimePaths.contextPath,
      addedWritableRoots: invocation.addedWritableRoots,
      cwd: worktree,
      promptPath: prompt.path,
      logPath: launchPaths.logPath,
      activityLogPath: launchPaths.activityLogPath,
      activityJsonlPath: launchPaths.activityJsonlPath,
      latestStatePath: launchPaths.latestStatePath,
      manifestPath: launchPaths.manifestPath,
      sessionId,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
      workerName: worker.workerName,
      supervisorRunId,
      pid: null,
      processStartedAt: null,
      commandIdentity: null,
      slotIndex,
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
    await persistLaunchManifest(launchManifest)
    console.log(`worker: ${worker.id}`)
    console.log(`hypothesis: ${hypothesis.id} ${hypothesis.name}`)
    console.log(`worktree: ${worktree}`)
    console.log(`manifest: ${launchPaths.manifestPath}`)
    console.log(`raw log: ${launchPaths.logPath}`)
    console.log(`activity log: ${launchPaths.activityLogPath}`)
    console.log(`activity events: ${launchPaths.activityJsonlPath}`)
    await appendWorkerActivityEvent(launchManifest, {
      type: "process_start",
      phase: "starting",
      summary: `Starting ${invocation.agentKind} worker for ${hypothesis.name}`,
      metadata: {
        command: invocation.command,
        args: invocation.redactedArgs,
        workerBranch,
        ...workerModelMetadata(workerModel),
      },
    })
    await appendWorkerActivityEvent(launchManifest, {
      type: "phase_change",
      phase: "orienting",
      summary: "Worker context files are ready",
    })
    const firstAttemptWarningMs =
      nonnegativeNumberOption(
        args,
        "first-attempt-warning-seconds",
        DEFAULT_FIRST_ATTEMPT_WARNING_MS / 1000
      ) * 1000
    let firstAttemptWarningTimer: ReturnType<typeof setTimeout> | null = null
    const heartbeatSampleEveryMs =
      nonnegativeNumberOption(args, "heartbeat-sample-interval", 0) * 1000
    if (firstAttemptWarningMs > 0) {
      firstAttemptWarningTimer = setTimeout(() => {
        void hasWorkerLoggedAttempt({ root, workerId: worker.id })
          .then((hasAttempt) => {
            if (hasAttempt) return
            return heartbeatWorker(
              worker.id,
              {
                leaseToken,
                status: "running",
                sessionId,
                hypothesisId: hypothesis.id,
                phase: "orienting",
                event: "first_attempt_delayed",
                progressMessage:
                  "No logged workflow attempt yet; worker may still be orienting or sweeping.",
                metadata: {
                  warningAfterSeconds: Math.round(firstAttemptWarningMs / 1000),
                },
              },
              args
            )
          })
          .catch(() => {})
      }, firstAttemptWarningMs)
      firstAttemptWarningTimer.unref?.()
    }
    await appendWorkerActivityEvent(launchManifest, {
      type: "phase_change",
      phase: "running",
      summary: "Provider process started",
    })
    const stopChecker = createResearchSessionStopChecker({
      root,
      sessionId,
      assignmentId: lease.assignment.id,
      args,
    })
    const workerResult = await withWorkerHeartbeat({
      root,
      args,
      workerId: worker.id,
      leaseToken,
      sessionId,
      hypothesisId: hypothesis.id,
      latestStatePath:
        launchManifest?.latestStatePath ?? launchPaths.latestStatePath,
      phase: "running",
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
          onSpawn: (pid) => {
            if (!launchManifest) return
            const identity = inspectProcessIdentity(pid)
            launchManifest = {
              ...launchManifest,
              pid,
              supervisorRunId,
              processStartedAt: identity?.startedAt ?? null,
              commandIdentity: identity?.command ?? null,
            }
            void persistLaunchManifest(launchManifest).catch(() => {})
          },
          cancel: {
            graceMs: stopGraceMs,
            pollMs: 5000,
            shouldCancel: () =>
              harnessShouldStopSession({ checker: stopChecker }),
          },
          onOutput: ({ at }) => {
            if (!launchManifest) return
            launchManifest = {
              ...launchManifest,
              status: "running",
              lastOutputAt: at,
            }
            void persistLaunchManifest(launchManifest).catch(() => {})
          },
          terminateOnOutput:
            invocation.agentKind === "opencode"
              ? ({ text }) => shouldTerminateOpenCodeOnOutput(text)
              : undefined,
        }),
      quiet,
      heartbeatSampleEveryMs,
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
      await persistLaunchManifest(launchManifest)
      await appendWorkerActivityEvent(launchManifest, {
        type: "process_exit",
        phase: launchManifest.status,
        summary: `${invocation.agentKind} exited with code ${workerResult.code ?? "null"}`,
        metadata: {
          exitCode: workerResult.code,
          signal: workerResult.signal,
          timedOut: workerResult.timedOut,
          startupTimedOut: workerResult.startupTimedOut,
          cancelled: stoppedByHarness,
        },
      })
    }
    const workerFailure = processFailure(
      workerResult,
      `Worker process for ${hypothesis.name}`
    )
    await heartbeatWorker(
      worker.id,
      {
        leaseToken,
        status: "running",
        sessionId,
        hypothesisId: hypothesis.id,
        phase: "finalizing",
        event: "finalization_started",
        progressMessage: `Finalizing ${hypothesis.name} worker output`,
        gitLabel: resultCommitSha ?? null,
      },
      args
    )
    if (launchManifest) {
      await appendWorkerActivityEvent(launchManifest, {
        type: "phase_change",
        phase: "finalizing",
        summary: "Finalizing worker output",
      })
    }
    const finalization = await finalizeHypothesisAttempt({
      root,
      worktree,
      campaign,
      hypothesis,
      startingCommitSha: lease.assignment.startingCommitSha,
      sessionId,
      assignmentId: lease.assignment.id,
      workerId: worker.id,
      workerBranch,
      activityManifest: launchManifest,
      args,
      workerFailed: Boolean(workerFailure) || stoppedByHarness,
      pushWorkerBranch: refPushQueue.pushRef,
    })
    if (finalization.commitSha) resultCommitSha = finalization.commitSha
    if (launchManifest) {
      launchManifest = {
        ...launchManifest,
        finalization,
      }
      await persistLaunchManifest(launchManifest)
      await appendWorkerActivityEvent(launchManifest, {
        type: "finalization_result",
        phase: "finalizing",
        summary: finalizationStatusLabel(finalization.finalizationStatus),
        metadata: {
          finalizationStatus: finalization.finalizationStatus,
          commitSha: finalization.commitSha,
          unloggedCommitCount: finalization.unloggedCommitCount,
          workerBranchPushStatus: finalization.workerBranchPushStatus,
          rootDriftStatus: finalization.rootDriftStatus,
          error: finalization.error,
        },
      })
    }
    if (finalization.rootDriftStatus === "dirty") {
      // Keep the worktree for inspection when the main checkout drifted.
      throw new Error(
        finalization.error ??
          "Main checkout changed during worker run; see worker manifest."
      )
    }
    await removeWorkerWorktree({
      root,
      sessionId,
      workerId: worker.id,
    }).catch(() => {})

    if (stoppedByHarness) {
      if (launchManifest) {
        await appendWorkerActivityEvent(launchManifest, {
          type: "stop",
          phase: "stopped",
          summary: "Worker stopped after session stop request",
        })
      }
      await heartbeatWorker(
        worker.id,
        {
          leaseToken,
          status: "stopped",
          sessionId,
          hypothesisId: hypothesis.id,
          phase: "stopped",
          event: "stop_requested",
          progressMessage: `${hypothesis.name} stopped after session stop request`,
          gitLabel: resultCommitSha,
        },
        args
      )
      await upsertCampaignSummary(
        campaign.id,
        {
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
            finalization.error
              ? `Finalization note: ${finalization.error}`
              : "",
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
        },
        args
      )
      await cleanupWorkerRuntimeTempDir()
      return {
        hypothesis,
        workerId: worker.id,
        resultCommitSha,
        status: "stopped",
        startupTimedOut: workerResult.startupTimedOut,
      }
    }

    if (workerFailure) {
      throw new Error(
        `${workerFailure}. ${
          finalization.attempted
            ? `Best-effort finalization ${finalizationStatusLabel(finalization.finalizationStatus)} for ${finalization.commitSha ?? "unknown commit"}. `
            : ""
        }`
      )
    }

    await heartbeatWorker(
      worker.id,
      {
        leaseToken,
        status: "completed",
        sessionId,
        hypothesisId: hypothesis.id,
        phase: "completed",
        event: "hypothesis_completed",
        progressMessage: `${hypothesis.name} completed`,
        gitLabel: resultCommitSha,
      },
      args
    )
    await upsertCampaignSummary(
      campaign.id,
      {
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
      },
      args
    )
    await cleanupWorkerRuntimeTempDir()
    return {
      hypothesis,
      workerId: worker.id,
      resultCommitSha,
      status: "completed",
      startupTimedOut: workerResult.startupTimedOut,
    }
  } catch (error) {
    const message = compactProviderErrorSummary(errorMessage(error))
    if (launchManifest) {
      launchManifest = {
        ...launchManifest,
        completedAt: new Date().toISOString(),
        status: "failed",
        error: message,
      }
      await persistLaunchManifest(launchManifest).catch(() => {})
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
      await heartbeatWorker(
        workerId,
        {
          leaseToken,
          status: "failed",
          sessionId,
          hypothesisId: hypothesis.id,
          phase: "failed",
          event: "worker_failed",
          progressMessage: message.slice(0, 1000),
          gitLabel: resultCommitSha ?? null,
          metadata,
        },
        args
      ).catch(() => {})
    }
    if (workerId) {
      await upsertCampaignSummary(
        campaign.id,
        {
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
        },
        args
      ).catch(() => {})
    }
    await cleanupWorkerRuntimeTempDir()
    return {
      hypothesis,
      workerId,
      resultCommitSha,
      status: "failed",
      error: message,
      startupTimedOut: launchManifest?.startupTimedOut,
    }
  }
}

export async function commandResearchHypothesisAdd(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  if (args.options.session) {
    throw new Error(
      "--session is not valid when adding a hypothesis; session membership is immutable. Pass --campaign <name>."
    )
  }
  const sessionId: string | undefined = undefined
  if (!args.options.campaign) {
    throw new Error("Pass --campaign <name>.")
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
  const rawAgentKind =
    args.options.agent ??
    (typeof sessionMetadata.agentKind === "string"
      ? sessionMetadata.agentKind
      : "codex")
  const agentKind =
    rawAgentKind === "custom"
      ? "custom"
      : validateBuiltInWorkerAgent(rawAgentKind)
  const workerModel =
    agentKind === "custom"
      ? null
      : await resolveWorkerModel(
          agentKind,
          metadataString(sessionMetadata, "workerModel"),
          { cwd: root }
        )
  const created = await createCampaignHypothesis(
    campaign.id,
    {
      plan,
      name: args.options.name,
      description: args.options.description ?? undefined,
      metadata: {
        createdBy: "onyx-research",
        ...(sessionId ? { createdBySessionId: sessionId } : {}),
      },
    },
    args
  )
  const createdHypothesis = created.hypothesis
  if (before?.session) {
    await cacheResearchSessionState({
      root,
      campaign,
      session: before.session,
      hypotheses: [
        ...before.hypotheses.filter(
          (hypothesis) => hypothesis.id !== createdHypothesis.id
        ),
        createdHypothesis,
      ],
      workers: before.workers,
      experiments: before.latestExperiments,
      summaries: before.summaries,
      knowledge: before.knowledge,
    }).catch(() => {})
  }

  const maxMinutes =
    typeof sessionMetadata.maxMinutes === "number"
      ? sessionMetadata.maxMinutes
      : null
  const deadlineAt =
    before?.session.deadlineAt ??
    (sessionId ? state.sessions?.[sessionId]?.deadlineAt : null) ??
    null
  if (sessionId) {
    state.sessions = state.sessions ?? {}
    state.sessions[sessionId] = {
      ...(state.sessions[sessionId] ?? {}),
      campaignName: campaign.name,
      campaignId: campaign.id,
      deadlineAt,
      experimentTarget:
        before?.session.experimentTarget ??
        state.sessions[sessionId]?.experimentTarget ??
        null,
      acceptedExperimentCount:
        before?.session.acceptedExperimentCount ??
        state.sessions[sessionId]?.acceptedExperimentCount ??
        0,
      remainingExperimentCount:
        before?.session.remainingExperimentCount ??
        state.sessions[sessionId]?.remainingExperimentCount ??
        null,
      schedulerSiteId:
        before?.session.schedulerSiteId ??
        state.sessions[sessionId]?.schedulerSiteId ??
        null,
      status: "running",
    }
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

  console.log(`Research hypothesis: ${hypothesis.id}`)
  if (sessionId) console.log(`Session: ${sessionId}`)
  console.log(`Hypothesis: ${hypothesis.name}: ${hypothesis.plan.focus}`)
  if (sessionId) {
    const budgetOptions =
      maxMinutes === null ? "" : workerBudgetOptions({ maxMinutes })
    console.log(
      `onyx worker run --session ${sessionId} --hypothesis ${hypothesis.id} --agent ${agentKind}${workerModel ? ` --model ${workerModel}` : ""}${budgetOptions}`
    )
  } else {
    console.log("This hypothesis is available to the next research session.")
  }
}

export async function commandResearchHypothesisList(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const hypotheses = await listCampaignHypotheses(campaign.id, args)
  if (args.options.json === "true") {
    console.log(JSON.stringify(hypotheses, null, 2))
    return
  }
  if (hypotheses.length === 0) {
    console.log(`No hypotheses in ${campaign.name}.`)
    return
  }
  for (const hypothesis of hypotheses) {
    console.log(
      `${hypothesis.id}  ${hypothesis.status.padEnd(6)}  ${hypothesis.name}`
    )
  }
}

async function resolveCampaignHypothesis(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const selector = args.options.hypothesis ?? args.options.name
  if (!selector) throw new Error("Pass --hypothesis <name-or-id>.")
  const hypotheses = await listCampaignHypotheses(campaign.id, args)
  const hypothesis = hypotheses.find(
    (candidate) => candidate.id === selector || candidate.name === selector
  )
  if (!hypothesis) {
    throw new Error(`Hypothesis ${JSON.stringify(selector)} was not found.`)
  }
  return { campaign, hypothesis }
}

export async function commandResearchHypothesisClose(args: Args) {
  const { campaign, hypothesis } = await resolveCampaignHypothesis(args)
  const result = await closeCampaignHypothesis(
    hypothesis.id,
    { reason: args.options.reason },
    args
  )
  console.log(
    `Closed ${hypothesis.name} in ${campaign.name}; canceled ${result.canceledAssignmentIds.length} assignment(s) and stopped ${result.stoppedWorkerIds.length} worker(s).`
  )
}

export async function commandResearchHypothesisReopen(args: Args) {
  const { campaign, hypothesis } = await resolveCampaignHypothesis(args)
  await reopenCampaignHypothesis(hypothesis.id, args)
  console.log(
    `Reopened ${hypothesis.name} in ${campaign.name}; it is eligible for future sessions.`
  )
}

export async function commandResearchScale(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    selectLocalOpenSessionId({
      state,
      projectPath,
      campaignName: args.options.campaign,
      operation: "scale",
    })
  if (!sessionId) throw new Error("Pass --session <id>.")
  const campaignId =
    state.sessions?.[sessionId]?.campaignId ??
    (await getResearchSessionState(sessionId, args)).campaign.id
  const workerTarget = positiveIntegerOption(args, "workers", Number.NaN)
  if (
    !Number.isInteger(workerTarget) ||
    workerTarget < 1 ||
    workerTarget > 500
  ) {
    throw new Error("--workers must be an integer from 1 to 500.")
  }
  const { session } = await scaleCampaignSession(
    sessionId,
    {
      campaignId,
      workerTarget,
      siteId: await getResearchSiteId(root),
      supervisorRunId:
        state.sessions?.[sessionId]?.supervisor?.supervisorRunId ?? undefined,
      metadata: { source: "onyx-research-scale" },
    },
    args
  )
  console.log(
    `Session ${session.id} worker target is now ${session.workerTarget}. Existing workers drain naturally when scaling down.`
  )
}

export async function commandResearchClean(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const stateDir = await onyxStateDir(root)
  const targets = [
    join(stateDir, "worker-runtime"),
    join(stateDir, "worker-logs"),
    join(stateDir, "workflow-runs"),
    join(stateDir, "attempts"),
    join(stateDir, "worktrees"),
    join(stateDir, SUPERVISOR_LOG_DIR),
  ]
  if (args.options["dry-run"] === "true") {
    console.log(targets.join("\n"))
    return
  }
  for (const target of targets) {
    await rm(target, { recursive: true, force: true })
  }
  await updateState(root, (state) => {
    state.sessions = {}
    for (const campaign of Object.values(state.campaigns ?? {})) {
      delete campaign.sessionId
    }
  })
  console.log(
    "Removed local Onyx research runtime, attempt, worktree, and log artifacts."
  )
}

export async function commandResearchBrief(args: Args) {
  let sessionId = args.options.session ?? process.env.ONYX_SESSION_ID
  if (!sessionId) {
    const root = await repoRoot(args.options.cwd)
    const projectPath = await resolveProjectPath(root, args)
    const state = await readState(root)
    const { campaign, overview } = await campaignForName(root, args)
    sessionId =
      activeSessionIdFromState({
        state,
        projectPath,
        campaignName: campaign.name,
      }) ??
      overview.sessions?.find((session) =>
        ["running", "stop_requested"].includes(session.status)
      )?.id
  }
  if (!sessionId) {
    throw new Error(
      "Pass --session <id> or start/select a campaign with an active research session."
    )
  }
  const hypothesisId =
    args.options.hypothesis ?? process.env.ONYX_HYPOTHESIS_ID ?? undefined
  const brief = await getResearchSessionBrief(sessionId, args, { hypothesisId })

  if (args.options.json === "true") {
    console.log(JSON.stringify(brief, null, 2))
    return
  }
  console.log(renderSessionBrief(brief))
}

export async function commandResearchStatus(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const shouldReconcile = args.options.reconcile === "true"
  const campaignInfo = await campaignForName(root, args, {
    persistState: shouldReconcile,
  })
  const { campaign } = campaignInfo
  let freshOverview = campaignInfo.overview
  const projectPath = await resolveProjectPath(root, args)
  if (shouldReconcile) {
    await reconcileCampaignIntoLocalState({
      root,
      campaignId: campaign.id,
      projectPath,
      args,
    }).catch(() => {})
    freshOverview = await getCampaignOverview(campaign.id, args).catch(
      () => freshOverview
    )
  }
  const state = await readState(root)
  const locallyOwnedOpenSessions = Object.entries(state.sessions ?? {})
    .filter(
      ([, session]) =>
        session.campaignId === campaign.id &&
        (session.status === "running" ||
          session.status === "stop_requested" ||
          session.stopPendingRemote === true)
    )
    .map(([id, session]) => ({ id, ...session }))
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
        campaign: freshOverview.campaign,
        gitVerification: freshOverview.gitVerification,
        hypotheses: localSessionState.hypotheses,
        workers: localSessionState.workers,
        summaries: localSessionState.summaries,
        knowledge: localSessionState.knowledge,
      }
    : freshOverview
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
  const target = sessionState?.session.workerTarget ?? null
  let sessionStatus =
    sessionState?.session.status ??
    (activeSessionId ? state.sessions?.[activeSessionId]?.status : null) ??
    null
  const stopping =
    sessionStatus === "stop_requested" ||
    (activeSessionId
      ? Boolean(state.sessions?.[activeSessionId]?.stopRequested)
      : false)
  const live = activeSessionId
    ? await getResearchSessionLive(activeSessionId, args).catch(() => null)
    : null
  if (live?.session.status) {
    sessionStatus = live.session.status
  }
  const statusCampaign = live?.campaign ?? freshOverview.campaign
  const liveWorkerById = new Map(
    (live?.workers ?? []).map((worker) => [worker.id, worker])
  )
  const observedAt = new Date().toISOString()
  const statusWorkerById = new Map<string, ApiWorker>()
  for (const worker of workers) {
    statusWorkerById.set(worker.id, worker)
  }
  if (activeSessionId) {
    for (const manifest of manifests) {
      if (statusWorkerById.has(manifest.workerId)) continue
      statusWorkerById.set(
        manifest.workerId,
        apiWorkerFromManifest({
          manifest,
          campaignId: campaign.id,
          sessionId: activeSessionId,
          observedAt,
        })
      )
    }
  }
  for (const liveWorker of live?.workers ?? []) {
    if (statusWorkerById.has(liveWorker.id)) continue
    if (!liveWorker.matched || !liveWorker.hypothesisId) continue
    if (
      activeSessionId &&
      liveWorker.sessionId &&
      liveWorker.sessionId !== activeSessionId
    ) {
      continue
    }
    statusWorkerById.set(liveWorker.id, {
      id: liveWorker.id,
      campaignId: liveWorker.campaignId ?? campaign.id,
      sessionId: liveWorker.sessionId ?? activeSessionId ?? null,
      hypothesisId: liveWorker.hypothesisId,
      workerName: liveWorker.workerName ?? liveWorker.id,
      agentKind: liveWorker.agentKind ?? "unknown",
      runtime: liveWorker.runtime ?? "local",
      status: liveWorker.status,
      liveness: liveWorker.liveness,
      currentExperimentId: liveWorker.currentExperimentId,
      phase: liveWorker.phase,
      progressMessage: liveWorker.progressMessage,
      gitLabel: liveWorker.gitLabel,
      lastSeenAt: liveWorker.receivedAt,
      startedAt: liveWorker.observedAt ?? liveWorker.receivedAt,
      metadata: {
        source: "remote-live-presence",
      },
      createdAt: liveWorker.observedAt ?? liveWorker.receivedAt,
      updatedAt: liveWorker.receivedAt,
    })
  }
  const workersForStatus = [...statusWorkerById.values()].map((worker) => {
    const liveWorker = liveWorkerById.get(worker.id)
    const manifest = manifestByWorker.get(worker.id)
    const manifestStatus = manifest
      ? workerStatusFromManifest(manifest)
      : worker.status
    return liveWorker
      ? {
          ...worker,
          liveness: liveWorker.liveness,
          status: manifestStatus,
          phase: liveWorker.phase ?? manifest?.status ?? worker.phase,
          progressMessage: liveWorker.progressMessage ?? worker.progressMessage,
          gitLabel:
            liveWorker.gitLabel ??
            worker.gitLabel ??
            manifest?.finalization?.commitSha ??
            null,
          currentExperimentId:
            liveWorker.currentExperimentId ?? worker.currentExperimentId,
          lastSeenAt: liveWorker.receivedAt ?? worker.lastSeenAt,
        }
      : {
          ...worker,
          status: manifestStatus,
          phase: manifest?.status ?? worker.phase,
          gitLabel:
            worker.gitLabel ?? manifest?.finalization?.commitSha ?? null,
        }
  })
  const activeWorkers = workersForStatus.filter(workerIsActive).length
  const terminalWorkers = workersForStatus.filter((worker) =>
    ["completed", "failed", "stopped"].includes(worker.status)
  ).length
  const openSlots =
    typeof target === "number" ? Math.max(0, target - activeWorkers) : null
  const bestExperiment =
    localSessionState?.bestExperiment ??
    ("bestExperiment" in campaignInfo.overview
      ? campaignInfo.overview.bestExperiment
      : null)
  const sessionRuntimeState = activeSessionId
    ? state.sessions?.[activeSessionId]
    : undefined
  const supervisorTelemetry = freshSupervisorTelemetry(
    sessionRuntimeState?.supervisor
  )
  const ignoredPresence = sessionRuntimeState?.ignoredPresence ?? null
  const providerBackoff =
    supervisorTelemetry?.providerBackoff ??
    sessionRuntimeState?.providerBackoff ??
    null
  const sessionMetadata: Record<string, unknown> = {}
  const launchRate = supervisorTelemetry?.launchRate ?? {
    batchSize:
      typeof sessionMetadata.launchBatchSize === "number"
        ? sessionMetadata.launchBatchSize
        : null,
    intervalSeconds:
      typeof sessionMetadata.launchIntervalSeconds === "number"
        ? sessionMetadata.launchIntervalSeconds
        : null,
  }
  const activeProcessCount =
    supervisorTelemetry?.activeProcessCount ?? activeWorkers
  const recentFailedLaunches =
    supervisorTelemetry?.recentFailedLaunches ??
    providerBackoff?.recentFailures ??
    []
  const failureSummary = workersForStatus
    .filter((worker) => worker.status === "failed")
    .slice(0, 10)
    .map((worker) => {
      const manifest = manifestByWorker.get(worker.id)
      return {
        workerId: worker.id,
        workerName: worker.workerName,
        status: worker.status,
        phase: worker.phase,
        errorSummary: manifest?.error
          ? compactProviderErrorSummary(manifest.error)
          : null,
        logPath: manifest?.logPath ?? null,
      }
    })
  const localDiscardedAfterCompletion = manifests
    .filter(
      (manifest) =>
        manifest.finalization?.finalizationStatus ===
        "discarded_after_completion"
    )
    .slice(0, 25)
    .map((manifest) => ({
      workerId: manifest.workerId,
      workerName: manifest.workerName,
      status: manifest.status,
      unloggedCommitCount: manifest.finalization?.unloggedCommitCount ?? null,
      workerBranchPushStatus:
        manifest.finalization?.workerBranchPushStatus ?? null,
      logPath: manifest.logPath,
      manifestPath: manifest.manifestPath,
    }))
  const localUnloggedAttempts = manifests
    .filter(
      (manifest) =>
        manifest.finalization?.finalizationStatus.startsWith(
          "salvaged_unmeasured"
        ) ||
        ((manifest.finalization?.unloggedCommitCount ?? 0) > 0 &&
          manifest.finalization?.finalizationStatus !==
            "discarded_after_completion") ||
        (!manifest.finalization &&
          ["completed", "failed", "stopped"].includes(manifest.status))
    )
    .slice(0, 25)
    .map((manifest) => ({
      workerId: manifest.workerId,
      workerName: manifest.workerName,
      status: manifest.status,
      finalizationStatus: manifest.finalization?.finalizationStatus ?? null,
      unloggedCommitCount: manifest.finalization?.unloggedCommitCount ?? null,
      logPath: manifest.logPath,
      manifestPath: manifest.manifestPath,
    }))
  const workerWarnings = manifests
    .filter(
      (manifest) =>
        (manifest.warnings?.length ?? 0) +
          (manifest.finalization?.warnings?.length ?? 0) >
        0
    )
    .map((manifest) => ({
      workerId: manifest.workerId,
      workerName: manifest.workerName,
      warnings: [
        ...(manifest.warnings ?? []),
        ...(manifest.finalization?.warnings ?? []),
      ].slice(0, 10),
      warningCount:
        (manifest.warnings?.length ?? 0) +
        (manifest.finalization?.warnings?.length ?? 0),
      manifestPath: manifest.manifestPath,
    }))
  const progress = live?.progress ?? sessionState?.session ?? null
  const targetReached =
    progress?.remainingExperimentCount === 0 ||
    (typeof progress?.experimentTarget === "number" &&
      typeof progress?.acceptedExperimentCount === "number" &&
      progress.acceptedExperimentCount >= progress.experimentTarget)
  const shouldSuggestLaunches =
    !supervisorTelemetry &&
    !providerBackoff &&
    !targetReached &&
    !(sessionStatus && sessionStatusIsTerminal(sessionStatus)) &&
    activeProcessCount === 0
  const launchSuggestions = shouldSuggestLaunches
    ? launchSuggestionsForSession({
        sessionId: activeSessionId ?? null,
        sessionStatus,
        openSlots,
        stopping,
        hypotheses,
        workers: workersForStatus,
      })
    : []

  if (args.options.json === "true") {
    console.log(
      JSON.stringify(
        {
          campaign: statusCampaign,
          sessions: freshOverview.sessions,
          locallyOwnedOpenSessions,
          session: activeSessionId
            ? {
                id: activeSessionId,
                status: sessionStatus,
                workerTarget: target,
                activeWorkers,
                terminalWorkers,
                openSlots,
                stopping,
                launchRate,
                activeProcessCount,
                supervisor: supervisorTelemetry
                  ? {
                      pid: supervisorTelemetry.pid ?? null,
                      supervisorRunId:
                        supervisorTelemetry.supervisorRunId ?? null,
                      logPath: supervisorTelemetry.logPath ?? null,
                      updatedAt: supervisorTelemetry.updatedAt ?? null,
                    }
                  : null,
                progress: live?.progress ?? null,
              }
            : null,
          hypotheses,
          workers: workersForStatus,
          activeWorkers,
          terminalWorkers,
          ignoredPresence,
          gitVerification: freshOverview.gitVerification ?? null,
          bestExperiment,
          providerBackoff,
          recentFailedLaunches,
          failures: failureSummary,
          sites: live?.sites ?? [],
          finalization: live?.finalization ?? null,
          localUnloggedAttempts: {
            count: localUnloggedAttempts.length,
            workers: localUnloggedAttempts,
          },
          localDiscardedAfterCompletion: {
            count: localDiscardedAfterCompletion.length,
            workers: localDiscardedAfterCompletion,
          },
          workerWarnings,
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
  console.log(
    `sessions: ${freshOverview.sessions.length} recent remote, ${locallyOwnedOpenSessions.length} locally owned open`
  )
  for (const session of freshOverview.sessions) {
    console.log(
      `  ${session.id}: ${session.runtimeState} workers=${session.workerTarget} accepted=${session.acceptedExperimentCount}${session.endedAt ? ` ended=${session.endReason ?? "ended"}` : ""}`
    )
  }
  if (shouldReconcile && freshOverview.gitVerification) {
    const summary = freshOverview.gitVerification
    const suffix =
      summary.recommendedAction === "none"
        ? ""
        : ` needsVerification=${summary.needsVerificationCount} hardFailures=${summary.hardFailureCount}`
    console.log(`git verification: ${summary.message}${suffix}`)
  }
  if (activeSessionId) {
    console.log(`session: ${activeSessionId} ${sessionStatus ?? ""}`.trim())
  }
  if (live?.sites?.length) {
    console.log(`sites: ${live.sites.length} reporting`)
  }
  if (providerBackoff) {
    console.log(`provider backoff: ${JSON.stringify(providerBackoff)}`)
  }
  if (live?.finalization) {
    console.log(
      `finalization: ${live.finalization.status} terminalReason=${live.finalization.terminalReason ?? "-"}`
    )
  }
  if (localUnloggedAttempts.length > 0) {
    console.log(`local unlogged attempts: ${localUnloggedAttempts.length}`)
  }
  if (localDiscardedAfterCompletion.length > 0) {
    console.log(
      `local discarded late work: ${localDiscardedAfterCompletion.length}`
    )
  }
  if (workerWarnings.length > 0) {
    console.log(
      `worker warnings: ${workerWarnings.reduce(
        (total, worker) => total + worker.warningCount,
        0
      )}`
    )
  }
  if (recentFailedLaunches.length > 0) {
    const latestFailure = recentFailedLaunches[recentFailedLaunches.length - 1]
    console.log(
      `recent launch failures: ${recentFailedLaunches.length} latest=${latestFailure?.reason ?? "unknown"}`
    )
  }
  if (ignoredPresence && ignoredPresence.total > 0) {
    console.log(
      `presence ignored: ${ignoredPresence.total} (${formatPresenceReasonCounts(
        ignoredPresence.byReason
      )}) last=${ignoredPresence.lastAt ?? "-"}`
    )
  }

  if (activeSessionId) {
    const progress = live?.progress ?? sessionState?.session ?? null
    if (progress) {
      console.log(
        `experiments: accepted=${progress.acceptedExperimentCount}${
          progress.experimentTarget === null
            ? ""
            : `/${progress.experimentTarget}`
        } remaining=${progress.remainingExperimentCount ?? "-"} deadline=${progress.deadlineAt ?? "-"}`
      )
    }
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
    const relatedWorkers = workersForStatus.filter(
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
  console.log(`workers: ${workersForStatus.length}`)
  for (const worker of workersForStatus) {
    const manifest = manifestByWorker.get(worker.id)
    const lastSeen = formatAge(worker.lastSeenAt, Date.now())
    const lastOutput = manifest
      ? formatAge(manifest.lastOutputAt, Date.now())
      : "—"
    const manifestError = manifest?.error
      ? compactProviderErrorSummary(manifest.error).slice(0, 160)
      : null
    const warningCount =
      (manifest?.warnings?.length ?? 0) +
      (manifest?.finalization?.warnings?.length ?? 0)
    console.log(
      [
        `  ${worker.workerName}: ${worker.status}`,
        worker.liveness ? `live=${worker.liveness}` : null,
        worker.phase ? `phase=${worker.phase}` : null,
        `seen=${lastSeen}`,
        `lastOutput=${lastOutput}`,
        manifest?.timedOut ? "timeout=true" : null,
        warningCount > 0 ? `warnings=${warningCount}` : null,
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

function selectLocalOpenSessionId({
  state,
  projectPath,
  campaignName,
  operation,
}: {
  state: Awaited<ReturnType<typeof readState>>
  projectPath: string
  campaignName?: string
  operation: "stop" | "scale"
}) {
  const selectedCampaignName = campaignName ?? state.activeCampaign
  const selectedCampaignId = selectedCampaignName
    ? state.campaigns?.[campaignStateKey(projectPath, selectedCampaignName)]
        ?.campaignId
    : undefined
  const openSessionIds = Object.entries(state.sessions ?? {})
    .filter(([, session]) => {
      if (selectedCampaignId && session.campaignId !== selectedCampaignId) {
        return false
      }
      if (
        !selectedCampaignId &&
        selectedCampaignName &&
        session.campaignName !== selectedCampaignName
      ) {
        return false
      }
      return (
        session.stopPendingRemote === true ||
        session.status === "running" ||
        session.status === "stop_requested"
      )
    })
    .map(([sessionId]) => sessionId)
  if (openSessionIds.length > 1) {
    throw new Error(
      `Multiple local research sessions are open (${openSessionIds.join(", ")}). Pass --session <id> to ${operation} one.`
    )
  }
  return (
    openSessionIds[0] ??
    activeSessionIdFromState({ state, projectPath, campaignName })
  )
}

function renderSessionBrief(brief: ApiSessionBrief) {
  const lines: string[] = [
    `# ${brief.campaign.name}`,
    "",
    `Session: ${brief.session.id} (${brief.session.status})`,
    `Accepted: ${brief.session.acceptedExperimentCount}${brief.session.experimentTarget === null ? "" : `/${brief.session.experimentTarget}`}`,
    `Metric: ${brief.campaign.metricName} (${brief.campaign.metricDirection})`,
  ]
  if (brief.hypothesis) {
    lines.push("", "## Assigned Hypothesis", brief.hypothesis.name)
    if (brief.hypothesis.description) lines.push(brief.hypothesis.description)
  }
  if (brief.bestExperiment) {
    lines.push(
      "",
      "## Best Experiment",
      `${brief.bestExperiment.name}: ${brief.bestExperiment.primaryMetricName}=${brief.bestExperiment.primaryMetricValue ?? "n/a"} (${brief.bestExperiment.status})`
    )
  }
  if (brief.activeHypotheses.length > 0) {
    lines.push("", "## Active Hypotheses")
    for (const hypothesis of brief.activeHypotheses.slice(0, 10)) {
      lines.push(`- ${hypothesis.name}: ${hypothesis.description ?? ""}`.trim())
    }
  }
  if (brief.latestExperiments.length > 0) {
    lines.push("", "## Recent Experiments")
    for (const experiment of brief.latestExperiments.slice(0, 10)) {
      lines.push(
        `- ${experiment.name}: ${experiment.primaryMetricName}=${experiment.primaryMetricValue ?? "n/a"} ${experiment.status}`
      )
    }
  }
  if (brief.summaries.length > 0) {
    lines.push("", "## Summaries")
    for (const summary of brief.summaries.slice(0, 8)) {
      lines.push(`- ${summary.summaryKind}: ${summary.title}`)
      const preview = summary.body.replace(/\s+/g, " ").trim().slice(0, 240)
      if (preview) lines.push(`  ${preview}`)
    }
  }
  if (brief.knowledge.length > 0) {
    lines.push("", "## Knowledge")
    for (const item of brief.knowledge.slice(0, 12)) {
      lines.push(`- ${item.kind}: ${item.title}`)
      const preview = item.body.replace(/\s+/g, " ").trim().slice(0, 240)
      if (preview) lines.push(`  ${preview}`)
    }
  }
  lines.push("", `Updated: ${brief.updatedAt}`)
  return lines.join("\n")
}

function sessionStatusIsTerminal(status: string | null | undefined) {
  return status === "completed" || status === "failed" || status === "stopped"
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
  await applyRemoteProjectionDeltas({
    root,
    deltas: {
      campaigns: [response.campaign],
      sessions: [],
      hypotheses: response.hypotheses,
      workers: response.workers,
      experiments: response.experiments,
      summaries: [],
      knowledge: [],
    },
  }).catch(() => {})
  return response
}

async function workerSessionStopGuidance({
  root,
  context,
  snapshot,
}: {
  root: string
  context: Awaited<ReturnType<typeof readWorkerRuntimeContext>>
  snapshot: SessionStateBriefSnapshot | null
}): Promise<WorkerSessionStopGuidance> {
  if (!context) {
    return {
      shouldStopStartingNewWork: false,
      reasonCodes: [],
      reasons: [],
      recommendedAction: "continue",
      activeWorkflowCount: 0,
      unloggedAttemptCount: 0,
    }
  }
  const stopCheck = await collectLocalResearchStopReasons({
    root,
    sessionId: context.sessionId,
    snapshot,
  })
  let activeWorkflowCount = 0
  let unloggedAttemptCount = 0
  if (stopCheck.shouldStop) {
    const [activeWorkflows, unloggedAttempts] = await Promise.all([
      listWorkflowRuns(root, {
        campaignName: context.campaignName,
        projectPath: context.projectPath,
        sessionId: context.sessionId,
        workerId: context.workerId,
        hypothesisId: context.hypothesisId,
        statuses: ["running", "paused"],
      }),
      listLocalAttempts(root, {
        campaignName: context.campaignName,
        projectPath: context.projectPath,
        sessionId: context.sessionId,
        workerId: context.workerId,
        hypothesisId: context.hypothesisId,
      }),
    ])
    activeWorkflowCount = activeWorkflows.length
    unloggedAttemptCount = unloggedAttempts.length
  }
  const hasWorkToFinish = activeWorkflowCount > 0 || unloggedAttemptCount > 0
  return {
    shouldStopStartingNewWork: stopCheck.shouldStop,
    reasonCodes: stopCheck.reasonCodes,
    reasons: stopCheck.reasons,
    recommendedAction: stopCheck.shouldStop
      ? hasWorkToFinish
        ? "finish_current_attempt_then_exit"
        : "exit"
      : "continue",
    activeWorkflowCount,
    unloggedAttemptCount,
  }
}

export async function commandResearchSessionStateBrief(args: Args) {
  const context = await readWorkerRuntimeContext()
  if (!context) {
    throw new Error(
      "session-state-brief is only available inside a supervised worker context."
    )
  }
  let snapshot: SessionStateBriefSnapshot | null = null
  const warnings: string[] = []
  try {
    snapshot = await readSessionStateBriefSnapshot({
      root: context.worktreeRoot,
      sessionId: context.sessionId,
    })
  } catch (error) {
    warnings.push(errorMessage(error))
  }
  const stop = await workerSessionStopGuidance({
    root: context.worktreeRoot,
    context,
    snapshot,
  })
  const stateBrief = workerSessionStateBriefFromSnapshot({
    context,
    snapshot,
    stop,
    warnings,
  })
  if (args.options.json === "true") {
    console.log(JSON.stringify(stateBrief, null, 2))
    return
  }
  console.log(
    [
      `Worker: ${stateBrief.worker.id}`,
      `Session: ${stateBrief.worker.sessionId}${
        stateBrief.session ? ` (${stateBrief.session.status})` : ""
      }`,
      `Brief: ${stateBrief.refreshStatus} sequence=${stateBrief.sequence}`,
      `Accepted: ${
        stateBrief.progress
          ? stateBrief.progress.acceptedExperimentCount
          : "unknown"
      }${
        !stateBrief.progress || stateBrief.progress.experimentTarget === null
          ? ""
          : `/${stateBrief.progress.experimentTarget}`
      }`,
      `Stop: ${stateBrief.stop.recommendedAction}${
        stateBrief.stop.reasonCodes.length > 0
          ? ` (${stateBrief.stop.reasonCodes.join(", ")})`
          : ""
      }`,
      `Hypothesis: ${stateBrief.worker.hypothesisName}`,
      `Generated: ${stateBrief.generatedAt}`,
      stateBrief.warnings.length > 0
        ? `Warnings: ${stateBrief.warnings.join("; ")}`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n")
  )
}

export async function commandResearchStop(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    selectLocalOpenSessionId({
      state,
      projectPath,
      campaignName: args.options.campaign,
      operation: "stop",
    })
  if (!sessionId) {
    throw new Error("Pass --session <id> or start a research session first.")
  }
  if (args.options.offline === "true") {
    throw new Error(
      "`--offline` was removed. Research stop is applied directly through the Onyx API."
    )
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
  const stopMarkerDir = join(
    await onyxStateDir(root),
    "worker-runtime",
    sessionId
  )
  await mkdir(stopMarkerDir, { recursive: true })
  await writeFile(
    join(stopMarkerDir, "stop-marker.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sessionId,
        supervisorRunId:
          state.sessions[sessionId]?.supervisor?.supervisorRunId ?? null,
        requestedAt: new Date().toISOString(),
        reason: args.options.reason ?? "user requested stop",
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  await writeState(root, state)

  const supervisor = state.sessions[sessionId]?.supervisor
  if (supervisor?.pid) {
    const currentIdentity = inspectProcessIdentity(supervisor.pid)
    const processManifest = await readSupervisorProcessManifest(root, sessionId)
    const identityMatches = supervisorProcessIdentityMatches({
      runtime: supervisor,
      manifest: processManifest,
      identity: currentIdentity,
    })
    if (identityMatches) {
      try {
        process.kill(-supervisor.pid, "SIGTERM")
      } catch {
        process.kill(supervisor.pid, "SIGTERM")
      }
    } else {
      console.warn(
        `Supervisor ${supervisor.pid} identity could not be verified; no local signal was sent. The remote stop cutoff will still apply.`
      )
    }
  }

  if (campaignId) {
    try {
      await stopCampaignSession(
        sessionId,
        {
          campaignId,
          endReason: "user_stopped",
          reason: args.options.reason ?? "stop requested",
        },
        args
      )
      await updateState(root, (next) => {
        if (next.sessions?.[sessionId]) {
          next.sessions[sessionId]!.stopPendingRemote = false
        }
      })
    } catch (error) {
      await updateState(root, (next) => {
        next.sessions = next.sessions ?? {}
        next.sessions[sessionId] = {
          ...(next.sessions[sessionId] ?? {}),
          campaignId,
          stopRequested: true,
          stopPendingRemote: true,
        }
      })
      throw new Error(
        `Local stop was applied, but the remote cutoff is pending: ${errorMessage(error)}\nRetry exactly: onyx research stop --session ${sessionId}`
      )
    }
  } else {
    const control = await getResearchSessionControlState(sessionId, args)
    throw new Error(
      `Could not resolve campaign id for session ${sessionId} (remote status ${control.status}). Pass --campaign <name>.`
    )
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

export async function commandResearchSummarize(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  await reconcileCampaign(campaign.id, args).catch(() => null)
  const overview = await getCampaignOverview(campaign.id, args)
  const revisionRows = await listCampaignEvaluationRevisions(campaign.id, args)
  const experiments = [] as typeof overview.latestExperiments
  let cursor: string | undefined
  do {
    const page = await listCampaignExperiments(campaign.id, args, {
      limit: 100,
      cursor,
    })
    experiments.push(...page.items)
    cursor = page.page.nextCursor ?? undefined
  } while (cursor)
  const revisions = new Map<string, typeof experiments>()
  for (const experiment of experiments) {
    const items = revisions.get(experiment.evaluationRevisionId) ?? []
    items.push(experiment)
    revisions.set(experiment.evaluationRevisionId, items)
  }
  const body = [
    `Campaign checkpoint for ${campaign.name}.`,
    `Accepted experiments: ${overview.campaign.experimentCount}.`,
    `Current evaluation revision: ${overview.campaign.currentEvaluationRevisionId ?? "none"}.`,
    ...revisionRows.map((revision) => {
      const experiments = revisions.get(revision.id) ?? []
      const measured = experiments.filter(
        (experiment) => experiment.primaryMetricValue !== null
      )
      const best = measured.sort((left, right) =>
        campaign.metricDirection === "maximize"
          ? (right.primaryMetricValue ?? -Infinity) -
            (left.primaryMetricValue ?? -Infinity)
          : (left.primaryMetricValue ?? Infinity) -
            (right.primaryMetricValue ?? Infinity)
      )[0]
      return `Revision ${revision.id}${revision.id === campaign.currentEvaluationRevisionId ? " (current)" : ""}: ${experiments.length} experiment(s); best=${best?.primaryMetricValue ?? "n/a"} (${best?.resultCommitSha ?? "n/a"}).`
    }),
  ].join("\n")
  const summary = await upsertCampaignSummary(
    campaign.id,
    {
      summaryKind: "campaign_brief",
      title: `${campaign.name} checkpoint`,
      body,
      isCurrent: true,
      metadata: { authoredBy: "onyx-research-summarize" },
    },
    args
  )
  console.log(summary.body)
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
  if (args.options.sync === "true" || args.options.offline === "true") {
    throw new Error(
      "`--sync` and `--offline` were removed. Summaries are written directly to the Onyx API."
    )
  }
  const summary = await upsertCampaignSummary(
    campaign.id,
    {
      sessionId,
      hypothesisId,
      authoredByWorkerId,
      summaryKind: kind,
      title,
      body,
    },
    args
  )
  if (args.options.json === "true") {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  console.log(`Updated ${summary.summaryKind} for ${campaign.name}`)
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
  if (args.options.offline === "true") {
    throw new Error(
      "`--offline` was removed. Summaries are read directly from the Onyx API."
    )
  }
  const sourceSummaries = await getCampaignOverview(campaign.id, args).then(
    (overview) => overview.summaries
  )
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

  if (args.options.sync === "true" || args.options.offline === "true") {
    throw new Error(
      "`--sync` and `--offline` were removed. Knowledge is written directly to the Onyx API."
    )
  }
  const item = await createCampaignKnowledge(
    campaign.id,
    {
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
    },
    args
  )
  if (args.options.json === "true") {
    console.log(JSON.stringify(item, null, 2))
    return
  }
  console.log(`Added ${item.kind} knowledge for ${campaign.name}`)
}

export async function commandKnowledgeList(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const limit = positiveIntegerOption(args, "limit", 50)
  if (args.options.offline === "true") {
    throw new Error(
      "`--offline` was removed. Knowledge is read directly from the Onyx API."
    )
  }
  const knowledge = (await listCampaignKnowledge(campaign.id, args)).slice(
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

function supervisorWorkerTarget(args: Args, fallback: number) {
  const target = positiveIntegerOption(args, "workers", fallback)
  if (target > MAX_LOCAL_SUPERVISOR_WORKERS) {
    throw new Error(
      `--workers is capped at ${MAX_LOCAL_SUPERVISOR_WORKERS} for the local supervisor`
    )
  }
  return target
}

async function resolveCommitRef(root: string, ref: string) {
  return (await git(["rev-parse", "--verify", `${ref}^{commit}`], root)).trim()
}

async function committedSetupAt({
  root,
  projectPath,
  commitSha,
}: {
  root: string
  projectPath: string
  commitSha: string
}) {
  const path = [projectPath, "onyx", "setup.json"].filter(Boolean).join("/")
  const raw = await git(["show", `${commitSha}:${path}`], root)
  const setup = normalizeSetupFile(JSON.parse(raw))
  const evaluation = await evaluationFingerprint({
    root,
    projectPath,
    commitSha,
    setup,
  })
  return { setup, setupHash: setupHash(setup), ...evaluation }
}

function selectRunHypotheses(args: Args, hypotheses: ApiHypothesis[]) {
  const active = hypotheses.filter(
    (hypothesis) => hypothesis.status === "active"
  )
  const selected = optionValues(args, "hypothesis")
  if (selected.length === 0) return active
  const resolved = selected.map((selector) => {
    const hypothesis = active.find(
      (candidate) => candidate.id === selector || candidate.name === selector
    )
    if (!hypothesis) {
      throw new Error(
        `Active hypothesis ${JSON.stringify(selector)} was not found. Run \`onyx research hypothesis list --campaign ${args.options.campaign ?? "<name>"}\`.`
      )
    }
    return hypothesis
  })
  if (new Set(resolved.map((item) => item.id)).size !== resolved.length) {
    throw new Error("Each --hypothesis selection must be unique.")
  }
  return resolved
}

async function resolveHypothesisBaseOverrides({
  campaignId,
  hypotheses,
  args,
}: {
  campaignId: string
  hypotheses: ApiHypothesis[]
  args: Args
}) {
  const overrides = new Map<
    string,
    { ref: string; sourceExperimentId?: string }
  >()
  for (const value of optionValues(args, "hypothesis-base")) {
    const split = value.indexOf("=")
    if (split <= 0 || split === value.length - 1) {
      throw new Error(
        `Invalid --hypothesis-base ${JSON.stringify(value)}; expected <hypothesis>=<ref|experiment:id>.`
      )
    }
    const selector = value.slice(0, split)
    const hypothesis = hypotheses.find(
      (candidate) => candidate.id === selector || candidate.name === selector
    )
    if (!hypothesis) {
      throw new Error(
        `--hypothesis-base refers to unselected hypothesis ${selector}.`
      )
    }
    const rawRef = value.slice(split + 1)
    if (rawRef.startsWith("experiment:")) {
      const experimentId = rawRef.slice("experiment:".length)
      let cursor: string | undefined
      let experiment: ApiCampaignExperiment | undefined
      do {
        const page = await listCampaignExperiments(campaignId, args, {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })
        experiment = page.items.find((item) => item.id === experimentId)
        cursor = page.page.nextCursor ?? undefined
      } while (!experiment && cursor)
      if (!experiment) {
        throw new Error(
          `Experiment ${experimentId} was not found in this campaign.`
        )
      }
      overrides.set(hypothesis.id, {
        ref: experiment.resultCommitSha,
        sourceExperimentId: experiment.id,
      })
    } else {
      overrides.set(hypothesis.id, { ref: rawRef })
    }
  }
  return overrides
}

function defaultPresenceIntervalSeconds(workerTarget: number) {
  if (workerTarget >= 100) return 15
  if (workerTarget >= 50) return 10
  return 5
}

export type ProviderBackoffReason =
  | "startup_timeout"
  | "quota_exhausted"
  | "rate_limit"
  | "overloaded"
  | "auth_error"
  | "provider_degraded"

export function providerBackoffReasonForResult(
  result: Pick<HypothesisRunResult, "status" | "error" | "startupTimedOut">
): ProviderBackoffReason | null {
  if (result.status !== "failed") return null
  if (result.startupTimedOut) return "startup_timeout"
  const message = result.error ?? ""
  if (
    /session limit|usage limit|out[_ -]?of[_ -]?credits|credit balance|insufficient credits|overage|spending limit|billing limit|quota exceeded/i.test(
      message
    )
  ) {
    return "quota_exhausted"
  }
  if (
    /rate limit|too many requests|429|throttl|retry[- ]?after/i.test(message)
  ) {
    return "rate_limit"
  }
  if (
    /auth|authentication|unauthorized|forbidden|401|403|invalid api key|login required|not logged in|permission denied/i.test(
      message
    )
  ) {
    return "auth_error"
  }
  if (
    /overloaded|capacity|temporarily unavailable|503|529|server busy/i.test(
      message
    )
  ) {
    return "overloaded"
  }
  if (
    /degraded|service unavailable|upstream|gateway|5\d\d|timeout connecting|connection timed out|network timeout/i.test(
      message
    )
  ) {
    return "provider_degraded"
  }
  return null
}

function shouldTerminateOpenCodeOnOutput(text: string) {
  const looksLikeStreamError =
    /AI_APICallError|APICallError|message="stream error"|stream error/i.test(
      text
    )
  if (!looksLikeStreamError) {
    return false
  }
  return (
    providerBackoffReasonForResult({
      status: "failed",
      error: text,
      startupTimedOut: false,
    }) !== null
  )
}

export function providerBackoffDelayMs({
  baseMs,
  attempt,
  random = Math.random,
}: {
  baseMs: number
  attempt: number
  random?: () => number
}) {
  const maxMs = 10 * 60_000
  const exponent = Math.max(0, Math.min(5, attempt - 1))
  const floorMs = Math.min(maxMs, Math.max(1, baseMs) * 2 ** exponent)
  const jitterMaxMs = Math.min(maxMs - floorMs, floorMs * 0.25)
  return Math.round(floorMs + jitterMaxMs * random())
}

function providerBackoffReasonIsTerminal(reason: ProviderBackoffReason) {
  return reason === "auth_error" || reason === "quota_exhausted"
}

function sessionStopRequested({
  state,
  sessionId,
}: {
  state: Awaited<ReturnType<typeof readState>>
  sessionId: string
}) {
  const session = state.sessions?.[sessionId]
  return Boolean(session?.stopRequested || session?.status === "stop_requested")
}

function freshSupervisorTelemetry(
  supervisor: SupervisorRuntimeTelemetry | undefined
) {
  if (!supervisor || supervisor.status !== "running") return null
  const updatedAt = supervisor.updatedAt
    ? Date.parse(supervisor.updatedAt)
    : NaN
  if (!Number.isFinite(updatedAt)) return null
  if (Date.now() - updatedAt > SUPERVISOR_TELEMETRY_STALE_MS) return null
  return supervisor
}

function inspectProcessIdentity(pid: number) {
  const inspect = (field: "lstart" | "command") => {
    const result = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
    })
    return typeof result?.stdout === "string" ? result.stdout.trim() : ""
  }
  const startedAt = inspect("lstart")
  const command = inspect("command")
  return startedAt && command ? { startedAt, command } : null
}

type SupervisorProcessManifest = {
  schemaVersion: 1
  sessionId: string
  pid: number
  supervisorRunId: string
  processStartedAt: string
  commandIdentity: string
  mode: "detached" | "foreground"
  createdAt: string
}

async function supervisorProcessManifestPath(root: string, sessionId: string) {
  return join(
    await onyxStateDir(root),
    "worker-runtime",
    sessionId,
    "supervisor-process.json"
  )
}

async function writeSupervisorProcessManifest({
  root,
  manifest,
}: {
  root: string
  manifest: SupervisorProcessManifest
}) {
  const path = await supervisorProcessManifestPath(root, manifest.sessionId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

async function readSupervisorProcessManifest(
  root: string,
  sessionId: string
): Promise<SupervisorProcessManifest | null> {
  const path = await supervisorProcessManifestPath(root, sessionId)
  try {
    const value = JSON.parse(
      await readFile(path, "utf8")
    ) as Partial<SupervisorProcessManifest>
    if (
      value.schemaVersion !== 1 ||
      value.sessionId !== sessionId ||
      typeof value.pid !== "number" ||
      typeof value.supervisorRunId !== "string" ||
      typeof value.processStartedAt !== "string" ||
      typeof value.commandIdentity !== "string" ||
      (value.mode !== "detached" && value.mode !== "foreground") ||
      typeof value.createdAt !== "string"
    ) {
      return null
    }
    return value as SupervisorProcessManifest
  } catch {
    return null
  }
}

function supervisorProcessIdentityMatches({
  runtime,
  manifest,
  identity,
}: {
  runtime: NonNullable<NonNullable<CliState["sessions"]>[string]["supervisor"]>
  manifest: SupervisorProcessManifest | null
  identity: ReturnType<typeof inspectProcessIdentity>
}) {
  return Boolean(
    manifest &&
    identity &&
    runtime.pid === manifest.pid &&
    runtime.supervisorRunId === manifest.supervisorRunId &&
    runtime.processStartedAt === manifest.processStartedAt &&
    runtime.commandIdentity === manifest.commandIdentity &&
    identity.startedAt === manifest.processStartedAt &&
    identity.command === manifest.commandIdentity &&
    (manifest.mode === "foreground" ||
      identity.command.includes(`--supervise-session ${manifest.sessionId}`))
  )
}

async function cleanupIdentityVerifiedOrphanWorkers({
  root,
  sessionId,
  supervisorRunId,
}: {
  root: string
  sessionId: string
  supervisorRunId: string | null | undefined
}) {
  if (!supervisorRunId) return 0
  const manifests = await readWorkerLaunchManifests(root, sessionId).catch(
    () => []
  )
  let stopped = 0
  for (const manifest of manifests) {
    if (
      manifestIsTerminal(manifest) ||
      manifest.supervisorRunId !== supervisorRunId ||
      !manifest.pid ||
      !manifest.processStartedAt ||
      !manifest.commandIdentity
    ) {
      continue
    }
    const identity = inspectProcessIdentity(manifest.pid)
    const matches = Boolean(
      identity &&
      identity.startedAt === manifest.processStartedAt &&
      identity.command === manifest.commandIdentity
    )
    if (!matches) {
      console.warn(
        `Worker ${manifest.workerId} process identity could not be verified; no orphan signal was sent.`
      )
      continue
    }
    try {
      process.kill(-manifest.pid, "SIGTERM")
    } catch {
      try {
        process.kill(manifest.pid, "SIGTERM")
      } catch {
        continue
      }
    }
    stopped += 1
    await writeWorkerLaunchManifest({
      ...manifest,
      status: "stopped",
      completedAt: new Date().toISOString(),
      signal: "SIGTERM",
      error:
        "Identity-verified orphan process stopped after supervisor failure",
    }).catch(() => {})
  }
  return stopped
}

async function persistSupervisorTelemetry({
  root,
  sessionId,
  campaignName,
  campaignId,
  telemetry,
}: {
  root: string
  sessionId: string
  campaignName: string
  campaignId: string
  telemetry: Omit<SupervisorRuntimeTelemetry, "updatedAt">
}) {
  const updatedAt = new Date().toISOString()
  await updateState(root, (state) => {
    state.sessions = state.sessions ?? {}
    const current = state.sessions[sessionId] ?? {}
    const supervisor = {
      ...(current.supervisor ?? {}),
      ...telemetry,
      updatedAt,
    }
    state.sessions[sessionId] = {
      ...current,
      campaignName,
      campaignId,
      providerBackoff: telemetry.providerBackoff ?? null,
      supervisor,
    }
  }).catch(() => {})
}

function supervisorCliCommand() {
  const execPath = process.execPath
  const argv1 = process.argv[1]
  if (execPath && /(?:^|\/)onyx(?:\.exe)?$/.test(execPath)) {
    return { command: execPath, args: [] }
  }
  if (argv1 && /(?:^|\/)onyx\.js$/.test(argv1)) {
    return { command: execPath, args: [argv1] }
  }
  return {
    command: execPath,
    args: [fileURLToPath(new URL("../../bin/onyx.js", import.meta.url))],
  }
}

function researchRunChildArgv({
  args,
  root,
  sessionId,
  logPath,
}: {
  args: Args
  root: string
  sessionId: string
  logPath: string
}) {
  const options: Record<string, string | undefined> = {
    ...args.options,
    "supervise-session": sessionId,
    cwd: root,
    foreground: "true",
    "supervisor-log-path": logPath,
  }
  delete options.json
  delete options.hypotheses

  const argv = [...args.positional]
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    argv.push(`--${key}`)
    if (value !== "true") argv.push(value)
  }
  return argv
}

async function supervisorLogPath(root: string, sessionId: string) {
  const dir = join(await onyxStateDir(root), SUPERVISOR_LOG_DIR)
  await mkdir(dir, { recursive: true })
  return join(dir, `${sessionId}-${Date.now()}.log`)
}

function statusCommand(campaignName: string) {
  return `onyx research status --campaign ${campaignName} --json`
}

function listenCommand() {
  return "onyx listen"
}

async function launchDetachedResearchSupervisor({
  root,
  args,
  sessionId,
  campaign,
  launchRate,
}: {
  root: string
  args: Args
  sessionId: string
  campaign: ApiCampaign
  launchRate: { batchSize: number | null; intervalSeconds: number | null }
}) {
  const latest = await readState(root).catch(() => null)
  const existing = freshSupervisorTelemetry(
    latest?.sessions?.[sessionId]?.supervisor
  )
  if (existing?.pid) {
    const payload = {
      sessionId,
      pid: existing.pid,
      supervisorRunId: existing.supervisorRunId ?? null,
      logPath: existing.logPath ?? null,
      statusCommand: statusCommand(campaign.name),
      listenCommand: listenCommand(),
      alreadyRunning: true,
    }
    if (args.options.json === "true") {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      console.log(`Research supervisor already running: ${sessionId}`)
      console.log(`PID: ${existing.pid}`)
      if (existing.logPath) console.log(`Log: ${existing.logPath}`)
      console.log(`Status: ${payload.statusCommand}`)
      console.log(`Listen: ${payload.listenCommand}`)
    }
    return payload
  }

  const logPath = await supervisorLogPath(root, sessionId)
  await appendFile(
    logPath,
    `[${new Date().toISOString()}] starting Onyx research supervisor ${sessionId}\n`,
    "utf8"
  )
  const command = supervisorCliCommand()
  const childArgv = researchRunChildArgv({ args, root, sessionId, logPath })
  const supervisorRunId =
    process.env.ONYX_SUPERVISOR_RUN_ID ?? `local-${randomUUID()}`
  const outputFd = openSync(logPath, "a")
  let pid: number | null = null
  try {
    const child = spawn(command.command, [...command.args, ...childArgv], {
      cwd: root,
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
      env: {
        ...process.env,
        ONYX_LAUNCHER_BYPASS: "1",
        ONYX_SUPERVISOR_RUN_ID: supervisorRunId,
      },
    })
    pid = child.pid ?? null
    child.unref()
  } finally {
    closeSync(outputFd)
  }

  const processIdentity = pid ? inspectProcessIdentity(pid) : null

  if (pid && processIdentity) {
    await writeSupervisorProcessManifest({
      root,
      manifest: {
        schemaVersion: 1,
        sessionId,
        pid,
        supervisorRunId,
        processStartedAt: processIdentity.startedAt,
        commandIdentity: processIdentity.command,
        mode: "detached",
        createdAt: new Date().toISOString(),
      },
    })
  }

  await persistSupervisorTelemetry({
    root,
    sessionId,
    campaignName: campaign.name,
    campaignId: campaign.id,
    telemetry: {
      pid,
      supervisorRunId,
      processStartedAt: processIdentity?.startedAt ?? null,
      commandIdentity: processIdentity?.command ?? null,
      logPath,
      activeProcessCount: 0,
      launchRate,
      providerBackoff: null,
      recentFailedLaunches: [],
      status: "running",
    },
  })

  const payload = {
    sessionId,
    pid,
    supervisorRunId,
    logPath,
    statusCommand: statusCommand(campaign.name),
    listenCommand: listenCommand(),
    alreadyRunning: false,
  }
  if (args.options.json === "true") {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log(`Research supervisor started: ${sessionId}`)
    if (pid) console.log(`PID: ${pid}`)
    console.log(`Log: ${logPath}`)
    console.log(`Status: ${payload.statusCommand}`)
    console.log(`Listen: ${payload.listenCommand}`)
  }
  return payload
}

export async function commandResearchRun(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const internalSessionId =
    process.env.ONYX_LAUNCHER_BYPASS === "1"
      ? args.options["supervise-session"]
      : undefined
  if (
    args.options.session ||
    (args.options["supervise-session"] && !internalSessionId)
  ) {
    throw new Error(
      "--session was removed from `onyx research run`; every run creates a new bounded session."
    )
  }
  if (args.options.hypotheses) {
    throw new Error(
      "--hypotheses was removed. Add durable hypotheses with `onyx research hypothesis add`, then select them with repeated --hypothesis flags."
    )
  }
  const state = await readState(root)
  const campaignInfo = await campaignForName(root, args)
  const campaign = campaignInfo.campaign
  const effectiveProjectPath = campaignInfo.projectPath
  const internalSession = internalSessionId
    ? await getResearchSessionState(internalSessionId, args)
    : null
  if (campaign.status === "archived") {
    throw new Error(
      `Campaign ${campaign.name} is archived. Unarchive it before starting research.`
    )
  }
  if (!internalSessionId) {
    for (const [cachedSessionId, local] of Object.entries(
      state.sessions ?? {}
    )) {
      if (
        local.campaignId !== campaign.id ||
        local.status !== "running" ||
        !local.supervisor?.pid
      ) {
        continue
      }
      const processManifest = await readSupervisorProcessManifest(
        root,
        cachedSessionId
      )
      const supervisorAlive = supervisorProcessIdentityMatches({
        runtime: local.supervisor,
        manifest: processManifest,
        identity: inspectProcessIdentity(local.supervisor.pid),
      })
      if (supervisorAlive) continue
      await cleanupIdentityVerifiedOrphanWorkers({
        root,
        sessionId: cachedSessionId,
        supervisorRunId: local.supervisor.supervisorRunId,
      })
      await stopCampaignSession(
        cachedSessionId,
        {
          campaignId: campaign.id,
          endReason: "supervisor_failed",
          reason: "cached local supervisor process is no longer running",
        },
        args
      ).catch((error) => {
        console.warn(
          `Could not persist supervisor_failed for ${cachedSessionId}: ${errorMessage(error)}. Server abandonment reconciliation remains authoritative.`
        )
      })
      local.status = "failed"
      local.stopRequested = false
      local.stopPendingRemote = false
    }
    await writeState(root, state)
  }
  if (!internalSessionId && args.options.new !== "true") {
    const live = Object.entries(state.sessions ?? {}).find(([, local]) => {
      if (local.campaignId !== campaign.id || local.status !== "running")
        return false
      const pid = local.supervisor?.pid
      if (!pid) return false
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
    if (live) {
      throw new Error(
        `This machine already has a live supervisor for ${campaign.name} (${live[0]}). Pass --new to create a concurrent session.`
      )
    }
  }
  const internalAssignmentHypothesisIds = new Set(
    internalSession?.session.assignments.map(
      (assignment) => assignment.hypothesisId
    ) ?? []
  )
  const selectedHypotheses = internalSession
    ? internalSession.hypotheses.filter((hypothesis) =>
        internalAssignmentHypothesisIds.has(hypothesis.id)
      )
    : selectRunHypotheses(args, campaignInfo.overview.hypotheses)
  if (selectedHypotheses.length === 0) {
    throw new Error(
      `Campaign ${campaign.name} has no active hypotheses. Add one with: onyx research hypothesis add --campaign ${campaign.name} --focus <focus> --hypothesis <statement>`
    )
  }
  const { setup } = await assertLocalSetupReady(root, effectiveProjectPath)
  const sessionBaseCommitSha = internalSession
    ? internalSession.session.baseCommitSha
    : await resolveCommitRef(root, args.options.base ?? "HEAD")
  await assertSetupCommitted({
    root,
    projectPath: effectiveProjectPath,
    baseCommitSha: sessionBaseCommitSha,
  })
  await assertMainWorktreeClean(root, "before running research")

  if (args.options["worker-command"] && args.options.model !== undefined) {
    throw new Error("Pass either --worker-command or --model, not both.")
  }
  if (args.options["max-worker-iterations"] !== undefined) {
    throw new Error("--max-worker-iterations is no longer a worker option.")
  }
  const workerSettings = args.options["worker-command"]
    ? ({ agentKind: "codex", workerModel: null } satisfies WorkerSettings)
    : await resolveWorkerSettings({
        args,
        sessionMetadata: null,
        cwd: root,
      })
  const agentKind = workerSettings.agentKind
  const workerModel = workerSettings.workerModel
  const resolvedWorkerArgs: Args = {
    ...args,
    options: {
      ...args.options,
      agent: agentKind,
      ...(workerModel ? { model: workerModel } : {}),
    },
  }
  const sessionAgentKind = args.options["worker-command"] ? "custom" : agentKind
  if (args.options["max-experiments"] !== undefined) {
    throw new Error("--max-experiments was removed. Use --experiments.")
  }
  if (args.options["max-worker-iterations"] !== undefined) {
    throw new Error(
      "--max-worker-iterations is no longer a research session option."
    )
  }
  if (args.options["max-launches"] !== undefined) {
    throw new Error("--max-launches was removed.")
  }
  const experimentTarget =
    optionalPositiveIntegerOption(args, "experiments") ?? null
  const maxMinutes =
    args.options["max-minutes"] === undefined
      ? null
      : positiveNumberOption(args, "max-minutes", 120)
  const workerTarget = supervisorWorkerTarget(args, 1)
  const maxConcurrency = positiveIntegerOption(
    args,
    "max-concurrency",
    MAX_LOCAL_SUPERVISOR_WORKERS
  )
  if (maxConcurrency > MAX_LOCAL_SUPERVISOR_WORKERS) {
    throw new Error(
      `--max-concurrency is capped at ${MAX_LOCAL_SUPERVISOR_WORKERS}`
    )
  }
  const now = Date.now()
  const deadlineAt =
    maxMinutes === null
      ? null
      : new Date(now + maxMinutes * 60_000).toISOString()
  if (experimentTarget === null && deadlineAt === null) {
    throw new Error("Pass --experiments <n> or --max-minutes <n>.")
  }
  const endTimeMs = deadlineAt
    ? Date.parse(deadlineAt)
    : Number.POSITIVE_INFINITY
  const defaultWorkerBudgetMs = 120 * 60_000
  const sessionBudgetMs = Number.isFinite(endTimeMs)
    ? Math.max(1, endTimeMs - now)
    : defaultWorkerBudgetMs
  const shutdownCushionMs = workerShutdownCushionMs(sessionBudgetMs)
  const hardStopGraceMs = workerHardStopGraceMs(shutdownCushionMs)
  const hardEndTimeMs = Number.isFinite(endTimeMs)
    ? endTimeMs + hardStopGraceMs
    : Number.POSITIVE_INFINITY
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
  if (
    args.options["sync-interval"] !== undefined ||
    args.options["sync-concurrency"] !== undefined ||
    args.options["sync-drain-batches"] !== undefined ||
    args.options["sync-batch-size"] !== undefined ||
    args.options["final-sync-timeout"] !== undefined
  ) {
    throw new Error(
      "Sync tuning flags were removed. Workers now push refs and report directly to the Onyx API."
    )
  }
  const presenceIntervalMs =
    positiveNumberOption(
      args,
      "presence-interval",
      defaultPresenceIntervalSeconds(workerTarget)
    ) * 1000
  const launchBatchSize = Math.min(
    maxConcurrency,
    25,
    positiveIntegerOption(
      args,
      "launch-batch-size",
      workerTarget >= 100 ? 10 : Math.min(10, maxConcurrency)
    )
  )
  const launchIntervalMs =
    positiveNumberOption(args, "launch-interval-seconds", 5) * 1000
  const launchRate = {
    batchSize: launchBatchSize,
    intervalSeconds: launchIntervalMs / 1000,
  }
  const providerBackoffMs =
    positiveNumberOption(args, "provider-backoff-seconds", 30) * 1000
  const finalRefPushTimeoutMs =
    positiveNumberOption(args, "final-ref-push-timeout", 120) * 1000

  const schedulerSiteId = await getResearchSiteId(root)
  const sessionEvaluation = await committedSetupAt({
    root,
    projectPath: effectiveProjectPath,
    commitSha: sessionBaseCommitSha,
  })
  if (
    sessionEvaluation.setup.metric.name !== campaign.metricName ||
    sessionEvaluation.setup.metric.unit !== campaign.metricUnit ||
    sessionEvaluation.setup.metric.direction !== campaign.metricDirection
  ) {
    throw new Error(
      `Committed setup metric does not match immutable campaign metric ${campaign.metricName}. Create a new campaign for a different metric contract.`
    )
  }
  const overrides = internalSession
    ? new Map<string, { ref: string; sourceExperimentId?: string }>(
        internalSession.session.assignments.map((assignment) => [
          assignment.hypothesisId,
          {
            ref: assignment.startingCommitSha,
            ...(assignment.sourceExperimentId
              ? { sourceExperimentId: assignment.sourceExperimentId }
              : {}),
          },
        ])
      )
    : await resolveHypothesisBaseOverrides({
        campaignId: campaign.id,
        hypotheses: selectedHypotheses,
        args,
      })
  const assignments = [] as Array<{
    hypothesisId: string
    startingCommitSha: string
    sourceExperimentId?: string
    setupHash: string
    evaluationFingerprint: string
  }>
  for (const hypothesis of selectedHypotheses) {
    const override = overrides.get(hypothesis.id)
    const startingCommitSha = await resolveCommitRef(
      root,
      override?.ref ?? sessionBaseCommitSha
    )
    const snapshot = await committedSetupAt({
      root,
      projectPath: effectiveProjectPath,
      commitSha: startingCommitSha,
    })
    if (
      snapshot.setupHash !== sessionEvaluation.setupHash ||
      snapshot.fingerprint !== sessionEvaluation.fingerprint
    ) {
      throw new Error(
        `Hypothesis ${hypothesis.name} base ${startingCommitSha} does not contain the session setup/evaluation snapshot. Rebase or cherry-pick the code onto a commit containing the current setup.`
      )
    }
    assignments.push({
      hypothesisId: hypothesis.id,
      startingCommitSha,
      ...(override?.sourceExperimentId
        ? { sourceExperimentId: override.sourceExperimentId }
        : {}),
      setupHash: snapshot.setupHash,
      evaluationFingerprint: snapshot.fingerprint,
    })
  }
  const result = internalSession
    ? {
        session: internalSession.session,
        hypotheses: internalSession.hypotheses,
      }
    : await createCampaignSession(
        campaign.id,
        {
          name: args.options.name ?? `research-${new Date().toISOString()}`,
          baseCommitSha: sessionBaseCommitSha,
          setupHash: sessionEvaluation.setupHash,
          evaluationFingerprint: sessionEvaluation.fingerprint,
          evaluationManifest: sessionEvaluation.manifest,
          workerTarget,
          assignments,
          ...(experimentTarget === null ? {} : { experimentTarget }),
          ...(deadlineAt === null ? {} : { deadlineAt }),
          schedulerSiteId,
          metadata: {
            startedBy: "onyx-research-supervisor",
            experimentTarget,
            maxMinutes,
            agentKind: sessionAgentKind,
            ...workerModelMetadata(workerModel),
            maxConcurrency,
            launchBatchSize,
            launchIntervalSeconds: launchIntervalMs / 1000,
            presenceIntervalSeconds: presenceIntervalMs / 1000,
          },
        },
        args
      )
  const sessionId = result.session.id
  await cacheResearchSessionState({
    root,
    campaign,
    session: result.session,
    hypotheses: result.hypotheses,
  }).catch(() => {})

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
    deadlineAt,
    experimentTarget,
    acceptedExperimentCount: 0,
    remainingExperimentCount:
      experimentTarget === null ? null : Math.max(0, experimentTarget - 0),
    schedulerSiteId,
    status: "running",
  }
  await writeState(root, nextState)

  await emitEvent(root, {
    type: "research_started",
    campaignName: campaign.name,
    campaignId: campaign.id,
    sessionId,
    message: `supervisor target ${workerTarget}, concurrency ${maxConcurrency}`,
  })

  if (args.options.foreground !== "true") {
    await launchDetachedResearchSupervisor({
      root,
      args: resolvedWorkerArgs,
      sessionId,
      campaign,
      launchRate,
    })
    return
  }

  const refPushQueue = createRefPushQueue({ args })
  const supervisorRunId =
    process.env.ONYX_SUPERVISOR_RUN_ID ?? `local-${randomUUID()}`
  const leaseTokensByWorkerId = new Map<string, string>()
  resetApiTimingSummary()
  try {
    await waitForStartupSessionReady({
      args,
      sessionId,
    })
  } catch (error) {
    const reason = `startup session readiness failed: ${errorMessage(error)}`
    await stopLocalSession({
      root,
      sessionId,
      status: "failed",
      finalizationStatus: "failed",
      terminalReason: "failed",
      reason,
      metadata: {
        terminalReason: "failed",
        finalizationReasons: [reason],
      },
    }).catch(() => {})
    refPushQueue.stop()
    throw new Error(reason)
  }
  const sessionStateBriefRefresher = createSessionStateBriefRefresher({
    root,
    sessionId,
    args,
  })
  await sessionStateBriefRefresher.writePlaceholder().catch(() => {})
  await sessionStateBriefRefresher.refresh({ force: true }).catch(() => {})
  const presenceSupervisor = createPresenceSupervisor({
    root,
    args,
    sessionId,
    supervisorRunId,
    intervalMs: presenceIntervalMs,
    leaseTokensByWorkerId,
  })
  presenceSupervisor.request()

  const activeRuns = new Map<string, Promise<HypothesisRunResult>>()
  // Capacity slot per active run: workers launched into freed slots reuse the
  // lowest index, keeping `onyx listen` rows positionally stable.
  const activeSlotsByRunKey = new Map<string, number>()
  let launched = 0
  let nextWorkerRefOrdinal = 1
  let completed = 0
  let failed = 0
  let stopped = 0
  let waitingLogged = false
  let lastLaunchBatchAt = 0
  let providerBackoffUntil = 0
  let serverLeasePausedUntil = 0
  let providerBackoffReason: string | null = null
  let providerBackoffAttempt = 0
  let providerBackoffLogged = false
  let recentProviderFailures: ProviderLaunchFailure[] = []
  let terminalReason: SessionTerminalReason | null = null
  let providerTerminalFailure: ProviderLaunchFailure | null = null
  let lastStopCheck: ResearchStopCheck | null = null
  let lastGitVerificationAt = 0
  // Verification is push-webhook-first server-side; this loop is only the
  // slow backstop for lost webhooks, plus the final verify at completion.
  const gitVerificationIntervalMs = GIT_VERIFICATION_BACKSTOP_INTERVAL_MS
  let gitVerificationPausedUntil = 0
  let gitVerificationInFlight: Promise<unknown> | null = null
  const supervisorPid = process.pid
  const supervisorProcessIdentity = inspectProcessIdentity(supervisorPid)
  if (supervisorProcessIdentity) {
    await writeSupervisorProcessManifest({
      root,
      manifest: {
        schemaVersion: 1,
        sessionId,
        pid: supervisorPid,
        supervisorRunId,
        processStartedAt: supervisorProcessIdentity.startedAt,
        commandIdentity: supervisorProcessIdentity.command,
        mode: "foreground",
        createdAt: new Date().toISOString(),
      },
    })
  }
  const supervisorLogPath = args.options["supervisor-log-path"] ?? null
  let lastTelemetryAt = 0
  let stopLogged = false
  // Clear stale worktree bookkeeping left by crashed runs before launching.
  await git(["worktree", "prune"], root).catch(() => {})
  const sessionStopChecker = createResearchSessionStopChecker({
    root,
    sessionId,
    args,
    settleBeforeCheck: true,
  })
  const currentProviderBackoff = () => {
    if (!providerBackoffReason || Date.now() >= providerBackoffUntil) {
      return null
    }
    return {
      reason: providerBackoffReason,
      until: new Date(providerBackoffUntil).toISOString(),
      attempt: providerBackoffAttempt,
      recentFailures: recentProviderFailures,
    }
  }
  const persistRuntimeTelemetry = async (
    options: {
      force?: boolean
      status?: string
      activeProcessCount?: number
      providerBackoff?: {
        reason: string
        until: string
        attempt?: number
        delayMs?: number
        recentFailures?: ProviderLaunchFailure[]
      } | null
    } = {}
  ) => {
    const now = Date.now()
    if (!options.force && now - lastTelemetryAt < 2_000) return
    lastTelemetryAt = now
    await persistSupervisorTelemetry({
      root,
      sessionId,
      campaignName: campaign.name,
      campaignId: campaign.id,
      telemetry: {
        pid: supervisorPid,
        supervisorRunId,
        processStartedAt: supervisorProcessIdentity?.startedAt ?? null,
        commandIdentity: supervisorProcessIdentity?.command ?? null,
        logPath: supervisorLogPath,
        activeProcessCount: options.activeProcessCount ?? activeRuns.size,
        launchRate,
        providerBackoff:
          options.providerBackoff === undefined
            ? currentProviderBackoff()
            : options.providerBackoff,
        recentFailedLaunches: recentProviderFailures,
        status: options.status ?? "running",
      },
    })
  }

  await persistRuntimeTelemetry({ force: true, activeProcessCount: 0 })

  console.log(`Research supervisor: ${sessionId}`)
  console.log(`Campaign: ${campaign.name}`)
  console.log(`Workers: target=${workerTarget} concurrency=${maxConcurrency}`)
  console.log(`Experiment target: ${experimentTarget ?? "deadline only"}`)
  console.log(`Deadline: ${deadlineAt ?? "none"}`)
  console.log(
    `Launch ramp: batch=${launchBatchSize} interval=${launchIntervalMs / 1000}s`
  )
  console.log(
    `Agent: ${args.options["worker-command"] ? "custom" : agentKind}${
      workerModel ? ` (${workerModel})` : ""
    }`
  )
  console.log(`Presence: every ${presenceIntervalMs / 1000}s`)

  let supervisorLoopCompleted = false
  try {
    while (Date.now() < hardEndTimeMs) {
      const loopNow = Date.now()
      void sessionStateBriefRefresher.refresh().catch(() => {})
      await persistRuntimeTelemetry({ activeProcessCount: activeRuns.size })
      if (providerTerminalFailure && activeRuns.size === 0) break
      if (providerTerminalFailure) {
        await Promise.race([
          ...activeRuns.values(),
          sleep(Math.min(5000, Math.max(1, hardEndTimeMs - Date.now()))),
        ])
        continue
      }
      let stopCheck: ResearchStopCheck = {
        shouldStop: false,
        sessionId,
        reasonCodes: [],
        reasons: [],
      }
      try {
        stopCheck = await sessionStopChecker.check({ nowMs: loopNow })
        lastStopCheck = stopCheck
      } catch {
        // Local state is checked again by workers.
      }
      if (
        !gitVerificationInFlight &&
        loopNow >= gitVerificationPausedUntil &&
        loopNow - lastGitVerificationAt >= gitVerificationIntervalMs
      ) {
        lastGitVerificationAt = loopNow
        gitVerificationInFlight = verifyResearchCampaignGit(campaign.id, args, {
          gitVerifyLimit: 50,
        })
          .then((verification) => {
            // The server surfaces GitHub budget state; honor it instead of
            // sweeping into an exhausted budget.
            const retryAfterSeconds = verification?.rateLimit?.limited
              ? verification.rateLimit.retryAfterSeconds
              : null
            if (retryAfterSeconds && retryAfterSeconds > 0) {
              gitVerificationPausedUntil = Date.now() + retryAfterSeconds * 1000
            }
            return null
          })
          .catch(() => null)
          .finally(() => {
            gitVerificationInFlight = null
          })
      }
      const stopShouldEndSupervisor = stopCheck.shouldStop
      if (stopShouldEndSupervisor && !stopLogged) {
        stopLogged = true
        terminalReason = terminalReasonForStopCheck(stopCheck)
        console.warn(
          `Stop requested for session ${sessionId}: ${stopCheck.reasons.join(", ")}`
        )
      }
      if (stopShouldEndSupervisor) {
        if (!terminalReason) {
          terminalReason = terminalReasonForStopCheck(stopCheck)
        }
        if (activeRuns.size === 0) break
        await Promise.race([
          ...activeRuns.values(),
          sleep(Math.min(5000, Math.max(1, hardEndTimeMs - Date.now()))),
        ])
        continue
      }

      let controlState = stopCheck.controlState
      if (!controlState) {
        controlState = await getResearchSessionControlState(
          sessionId,
          args
        ).catch(() => undefined)
      }
      if (controlState?.status && controlState.status !== "running") break
      if (!controlState) {
        const local = await getLocalSessionState(root, sessionId).catch(
          () => null
        )
        if (local && local.session.status !== "running") break
      }
      const activeWorkers =
        controlState?.launch.activeWorkerCount ?? activeRuns.size
      const occupiedWorkerSlots = Math.max(activeWorkers, activeRuns.size)
      const openSlots =
        controlState?.launch.openWorkerSlotCount ??
        Math.max(0, workerTarget - occupiedWorkerSlots)
      const remainingExperimentSlots =
        typeof controlState?.progress.remainingExperimentCount === "number"
          ? Math.max(
              0,
              controlState.progress.remainingExperimentCount -
                occupiedWorkerSlots
            )
          : Number.POSITIVE_INFINITY
      const concurrencySlots = Math.max(0, maxConcurrency - activeRuns.size)
      const providerBackoffActive = Date.now() < providerBackoffUntil
      const serverLeasePaused = Date.now() < serverLeasePausedUntil
      const rampWaiting =
        lastLaunchBatchAt > 0 &&
        Date.now() - lastLaunchBatchAt < launchIntervalMs
      const launchStateAllowsWork =
        !controlState ||
        (controlState.launch.acceptingExperiments &&
          controlState.launch.activeHypothesisCount > 0)
      const launchSlots =
        providerBackoffActive ||
        serverLeasePaused ||
        rampWaiting ||
        !launchStateAllowsWork
          ? 0
          : Math.min(
              openSlots,
              concurrencySlots,
              launchBatchSize,
              remainingExperimentSlots
            )
      let launchedThisTick = 0

      if (providerBackoffActive && !providerBackoffLogged) {
        providerBackoffLogged = true
        console.warn(
          `Provider backoff active (${providerBackoffReason ?? "startup failure"}); pausing launches for ${Math.ceil(
            (providerBackoffUntil - Date.now()) / 1000
          )}s.`
        )
      }
      if (launchSlots > 0) {
        const effectiveAgentKind = args.options["worker-command"]
          ? "custom"
          : agentKind
        const firstOrdinal = nextWorkerRefOrdinal
        const requestedWorkers = Array.from(
          { length: launchSlots },
          (_, index) => {
            const ordinal = firstOrdinal + index
            return {
              workerRef: `${supervisorRunId}:${ordinal}`,
              workerName: `${effectiveAgentKind}-${ordinal}`,
              agentKind: effectiveAgentKind,
              runtime: "local" as const,
              leaseSeconds: 180,
              metadata: {
                ...workerModelMetadata(workerModel),
                launchOrdinal: ordinal,
              },
            }
          }
        )
        let leaseBatch: Awaited<
          ReturnType<typeof acquireResearchWorkerLeasesBatch>
        > | null = null
        const siteId = await getResearchSiteId(root)
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            leaseBatch = await acquireResearchWorkerLeasesBatch(
              sessionId,
              {
                siteId,
                supervisorRunId,
                workers: requestedWorkers,
              },
              args
            )
            break
          } catch (error) {
            if (isLeaseUnavailableError(error)) {
              serverLeasePausedUntil =
                Date.now() + Math.max(1000, Math.min(5000, launchIntervalMs))
              break
            }
            if (attempt < 2 && isRetryableBatchLeaseError(error)) {
              await sleep(250 * (attempt + 1))
              continue
            }
            throw error
          }
        }
        if (leaseBatch) {
          nextWorkerRefOrdinal += requestedWorkers.length
          if (
            leaseBatch.unavailable.length > 0 &&
            leaseBatch.grants.length === 0
          ) {
            serverLeasePausedUntil =
              Date.now() + Math.max(1000, Math.min(5000, launchIntervalMs))
          }
        }

        const grants = leaseBatch?.grants ?? []
        for (const grant of grants) {
          leaseTokensByWorkerId.set(grant.worker.id, grant.leaseToken)
        }
        if (grants.length > 0) {
          const existingLocal = await getLocalSessionState(
            root,
            sessionId
          ).catch(() => null)
          const workersById = new Map(
            (existingLocal?.workers ?? []).map((worker) => [worker.id, worker])
          )
          const hypothesesById = new Map(
            (existingLocal?.hypotheses ?? []).map((hypothesis) => [
              hypothesis.id,
              hypothesis,
            ])
          )
          for (const grant of grants) {
            workersById.set(grant.worker.id, grant.worker)
            hypothesesById.set(grant.hypothesis.id, grant.hypothesis)
          }
          await cacheResearchSessionState({
            root,
            campaign,
            session: grants[0]!.session,
            hypotheses: [...hypothesesById.values()],
            workers: [...workersById.values()],
          }).catch(() => {})
        }

        for (const grant of grants) {
          if (activeRuns.size >= maxConcurrency) break
          const hypothesis = grant.hypothesis
          waitingLogged = false
          launched += 1
          launchedThisTick += 1
          const runKey = `${Date.now()}:${launched}:${grant.worker.id}`
          const slotIndex = lowestFreeSlot(activeSlotsByRunKey.values())
          activeSlotsByRunKey.set(runKey, slotIndex)
          const run = runHypothesisOnce({
            root,
            projectPath: effectiveProjectPath,
            campaign,
            setup,
            sessionId,
            supervisorRunId,
            hypothesis,
            workerCommand: args.options["worker-command"],
            agentKind,
            workerModel,
            endTimeMs: Number.isFinite(endTimeMs)
              ? endTimeMs
              : Date.now() + workerTimeoutMs,
            hardEndTimeMs,
            workerTimeoutMs,
            startupTimeoutMs,
            stopGraceMs,
            quiet: args.options.quiet === "true",
            refPushQueue,
            preacquiredLease: grant,
            slotIndex,
            onRegistered: ({ workerId, leaseToken }) => {
              leaseTokensByWorkerId.set(workerId, leaseToken)
            },
            args,
          })
            .then(async (result) => {
              if (result.leaseUnavailable) {
                serverLeasePausedUntil =
                  Date.now() + Math.max(1000, Math.min(5000, launchIntervalMs))
                return result
              }
              if (result.workerId) {
                await recordLocalWorkerHeartbeat({
                  root,
                  workerId: result.workerId,
                  status: result.status,
                  sessionId,
                  hypothesisId: result.hypothesis.id,
                  phase: result.status,
                  event: "worker_finished",
                  progressMessage: `Worker finished ${result.hypothesis.name}`,
                  gitLabel: result.resultCommitSha ?? null,
                }).catch(() => {})
              }
              if (result.status === "completed") {
                completed += 1
                if (providerBackoffAttempt > 0 || providerBackoffUntil > 0) {
                  providerBackoffAttempt = 0
                  providerBackoffUntil = 0
                  providerBackoffReason = null
                  providerBackoffLogged = false
                  await persistRuntimeTelemetry({
                    force: true,
                    providerBackoff: null,
                    activeProcessCount: activeRuns.size,
                  })
                }
              } else if (result.status === "stopped") stopped += 1
              else failed += 1
              const backoffReason = providerBackoffReasonForResult(result)
              if (backoffReason) {
                const failure: ProviderLaunchFailure = {
                  at: new Date().toISOString(),
                  reason: backoffReason,
                  workerId: result.workerId ?? null,
                  hypothesisId: result.hypothesis.id,
                  errorSummary: result.error
                    ? compactProviderErrorSummary(result.error)
                    : null,
                }
                recentProviderFailures = [
                  ...recentProviderFailures,
                  failure,
                ].slice(-20)
                const terminalProviderFailure =
                  providerBackoffReasonIsTerminal(backoffReason)
                providerBackoffAttempt += 1
                const delayMs = terminalProviderFailure
                  ? 0
                  : providerBackoffDelayMs({
                      baseMs: providerBackoffMs,
                      attempt: providerBackoffAttempt,
                    })
                if (terminalProviderFailure) {
                  terminalReason = "provider_capacity_exhausted"
                  providerTerminalFailure = failure
                  providerBackoffReason = backoffReason
                  providerBackoffUntil = Date.now()
                  providerBackoffLogged = true
                  await persistRuntimeTelemetry({
                    force: true,
                    activeProcessCount: activeRuns.size,
                    providerBackoff: {
                      reason: backoffReason,
                      until: new Date().toISOString(),
                      attempt: providerBackoffAttempt,
                      delayMs,
                      recentFailures: recentProviderFailures,
                    },
                  })
                  return result
                }
                providerBackoffReason = backoffReason
                providerBackoffUntil = Date.now() + delayMs
                providerBackoffLogged = false
                const until = new Date(providerBackoffUntil).toISOString()
                if (result.workerId) {
                  const manifest = (
                    await readWorkerLaunchManifests(root, sessionId).catch(
                      () => []
                    )
                  ).find((manifest) => manifest.workerId === result.workerId)
                  if (manifest) {
                    await appendWorkerActivityEvent(manifest, {
                      type:
                        backoffReason === "rate_limit"
                          ? "rate_limit"
                          : "provider_backoff",
                      phase: "backoff",
                      summary: backoffReason,
                      metadata: {
                        attempt: providerBackoffAttempt,
                        delayMs,
                        until,
                      },
                    })
                  }
                }
                await persistRuntimeTelemetry({
                  force: true,
                  activeProcessCount: activeRuns.size,
                  providerBackoff: {
                    reason: backoffReason,
                    until,
                    attempt: providerBackoffAttempt,
                    delayMs,
                    recentFailures: recentProviderFailures,
                  },
                })
              }
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
                startupTimedOut: false,
              }
            })
            .finally(() => {
              leaseTokensByWorkerId.delete(grant.worker.id)
              activeRuns.delete(runKey)
              activeSlotsByRunKey.delete(runKey)
              void persistRuntimeTelemetry({
                force: true,
                activeProcessCount: activeRuns.size,
              })
              presenceSupervisor.request()
            })
          activeRuns.set(runKey, run)
          await persistRuntimeTelemetry({
            force: true,
            activeProcessCount: activeRuns.size,
          })
          presenceSupervisor.request()
        }
      }
      if (launchedThisTick > 0) lastLaunchBatchAt = Date.now()

      if (launchedThisTick === 0) {
        const hasActiveHypotheses =
          controlState?.launch.activeHypothesisCount === undefined ||
          controlState.launch.activeHypothesisCount > 0
        if (activeRuns.size === 0 && openSlots > 0 && !hasActiveHypotheses) {
          terminalReason = "all_hypotheses_closed"
          break
        }
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
    if (!supervisorLoopCompleted) refPushQueue.stop()
  }

  const finalState = await readState(root)
  const explicitStop = sessionStopRequested({ state: finalState, sessionId })
  const postLoopLocal = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
  terminalReason =
    (explicitStop ? "user_stopped" : terminalReason) ??
    (lastStopCheck ? terminalReasonForStopCheck(lastStopCheck) : null) ??
    postLoopLocal?.session.terminalReason ??
    (Number.isFinite(endTimeMs) && Date.now() >= endTimeMs
      ? "deadline_reached"
      : null) ??
    "all_hypotheses_closed"
  let finalStatus: ApiSession["status"] = providerTerminalFailure
    ? "failed"
    : explicitStop
      ? "stopped"
      : "completed"
  const initialTerminalMetadata = {
    terminalReason,
    providerFailure: providerTerminalFailure,
    finalizationReasons: [],
  }
  finalState.sessions = finalState.sessions ?? {}
  finalState.sessions[sessionId] = {
    ...(finalState.sessions[sessionId] ?? {}),
    campaignName: campaign.name,
    campaignId: campaign.id,
    status: finalStatus,
    finalizationStatus: "running",
    stopRequested: false,
    providerBackoff: null,
    terminalReason,
  }
  await writeState(root, finalState)
  await stopLocalSession({
    root,
    sessionId,
    status: finalStatus,
    finalizationStatus: "running",
    terminalReason,
    reason: explicitStop
      ? "stop requested"
      : providerTerminalFailure
        ? "provider capacity exhausted"
        : "research run completed",
    metadata: initialTerminalMetadata,
  }).catch(() => {})
  await refPushQueue.drain(finalRefPushTimeoutMs)
  const finalization = await computeSessionFinalizationStatus({
    root,
    sessionId,
  })
  if (finalization.reasons.length > 0) {
    console.warn(
      `finalization ${finalization.status}: ${finalization.reasons
        .slice(0, 5)
        .join("; ")}`
    )
  }
  if (finalization.status === "failed") {
    finalStatus = "failed"
    terminalReason = "failed"
  }
  await writeRemoteSessionFinalization({
    sessionId,
    campaignId: campaign.id,
    status: finalStatus,
    finalization,
    terminalReason,
    args,
  })
  const finalSessionState = await readState(root)
  finalSessionState.sessions = finalSessionState.sessions ?? {}
  finalSessionState.sessions[sessionId] = {
    ...(finalSessionState.sessions[sessionId] ?? {}),
    campaignName: campaign.name,
    campaignId: campaign.id,
    status: finalStatus,
    finalizationStatus: finalization.status,
    stopRequested: false,
    providerBackoff: null,
    terminalReason,
  }
  await writeState(root, finalSessionState)
  await stopLocalSession({
    root,
    sessionId,
    status: finalStatus,
    finalizationStatus: finalization.status,
    terminalReason,
    reason:
      finalization.reasons.length > 0
        ? finalization.reasons.slice(0, 5).join("; ")
        : explicitStop
          ? "stop requested"
          : providerTerminalFailure
            ? "provider capacity exhausted"
            : "research run completed",
    metadata: {
      terminalReason,
      providerFailure: providerTerminalFailure,
      finalizationReasons: finalization.reasons,
    },
  }).catch(() => {})
  await verifyResearchCampaignGit(campaign.id, args, {
    gitVerifyLimit: 100,
  }).catch(() => null)
  const reportedFinalizationStatus = finalization.status
  const completionLive = await getResearchSessionLive(sessionId, args).catch(
    () => null
  )
  const completionLocal = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
  const completionManifests = await readWorkerLaunchManifests(
    root,
    sessionId
  ).catch(() => [])
  const unmeasuredSalvageCount =
    completionLive?.finalization?.unmeasuredSalvageCount ??
    completionManifests.filter(
      (manifest) =>
        manifest.finalization?.salvaged &&
        manifest.finalization.finalizationStatus.startsWith(
          "salvaged_unmeasured"
        )
    ).length
  const discardedAfterCompletionCount = completionManifests.filter(
    (manifest) =>
      manifest.finalization?.finalizationStatus === "discarded_after_completion"
  ).length
  const acceptedExperiments =
    completionLive?.session.acceptedExperimentCount ??
    completionLocal?.session.acceptedExperimentCount ??
    0
  const completedExperimentTarget =
    completionLive?.session.experimentTarget ??
    completionLocal?.session.experimentTarget ??
    null
  await persistRuntimeTelemetry({
    force: true,
    status: finalStatus,
    providerBackoff: null,
    activeProcessCount: 0,
  })
  await Promise.race([
    presenceSupervisor.flush({ terminal: true }),
    sleep(5000),
  ]).catch(() => {})

  console.log(
    `Research run ${finalStatus}: launched=${launched} completed=${completed} failed=${failed} stopped=${stopped}; finalization=${reportedFinalizationStatus}.`
  )
  console.log(
    `Experiment counts: accepted=${acceptedExperiments}${completedExperimentTarget === null ? "" : `/${completedExperimentTarget}`} unmeasuredSalvage=${unmeasuredSalvageCount} discardedAfterCompletion=${discardedAfterCompletionCount}.`
  )
  const apiTimingSummary = renderApiTimingSummary(args)
  if (apiTimingSummary) console.error(apiTimingSummary)
}

export async function commandWorkerRun(args: Args) {
  if (args.options.lane) {
    throw new Error(
      "Use --hypothesis <id>; lanes have been replaced by hypotheses."
    )
  }
  if (args.options["worker-command"] && args.options.model !== undefined) {
    throw new Error("Pass either --worker-command or --model, not both.")
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
  const workerSettings = args.options["worker-command"]
    ? ({ agentKind: "codex", workerModel: null } satisfies WorkerSettings)
    : await resolveWorkerSettings({
        args,
        sessionMetadata,
        cwd: root,
      })
  const deadlineMs = sessionState.session.deadlineAt
    ? Date.parse(sessionState.session.deadlineAt)
    : Number.NaN
  const maxMinutes =
    args.options["max-minutes"] === undefined
      ? null
      : positiveNumberOption(args, "max-minutes", 120)
  const sessionBudgetMs =
    maxMinutes !== null
      ? maxMinutes * 60_000
      : Number.isFinite(deadlineMs)
        ? Math.max(1, deadlineMs - Date.now())
        : 120 * 60_000
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
  if (
    args.options["sync-interval"] !== undefined ||
    args.options["sync-concurrency"] !== undefined ||
    args.options["sync-drain-batches"] !== undefined ||
    args.options["sync-batch-size"] !== undefined ||
    args.options["final-sync-timeout"] !== undefined
  ) {
    throw new Error(
      "Sync tuning flags were removed. Workers now push refs and report directly to the Onyx API."
    )
  }
  const finalRefPushTimeoutMs =
    positiveNumberOption(args, "final-ref-push-timeout", 120) * 1000
  const refPushQueue = createRefPushQueue({ args })
  const supervisorRunId =
    process.env.ONYX_SUPERVISOR_RUN_ID ?? `manual-${randomUUID()}`

  const result = await runHypothesisOnce({
    root,
    projectPath,
    campaign,
    setup,
    sessionId,
    supervisorRunId,
    hypothesis,
    workerCommand: args.options["worker-command"],
    agentKind: workerSettings.agentKind,
    workerModel: workerSettings.workerModel,
    slotIndex: 1,
    endTimeMs:
      maxMinutes !== null || Number.isFinite(deadlineMs)
        ? Date.now() + sessionBudgetMs
        : Date.now() + workerTimeoutMs,
    hardEndTimeMs:
      maxMinutes !== null || Number.isFinite(deadlineMs)
        ? Date.now() + sessionBudgetMs + hardStopGraceMs
        : Number.POSITIVE_INFINITY,
    workerTimeoutMs,
    startupTimeoutMs,
    stopGraceMs,
    quiet: args.options.quiet === "true",
    refPushQueue,
    args,
  })
  if (result.workerId) {
    await recordLocalWorkerHeartbeat({
      root,
      workerId: result.workerId,
      status: result.status,
      sessionId,
      hypothesisId: hypothesis.id,
      phase: result.status,
      event: "worker_finished",
      progressMessage: `Worker finished ${hypothesis.name}`,
      gitLabel: result.resultCommitSha ?? null,
    }).catch(() => {})
  }
  const pendingRefPushes = await refPushQueue.drain(finalRefPushTimeoutMs)
  if (result.status === "failed") {
    throw new Error(
      `Worker failed for ${hypothesis.name}: ${result.error ?? "unknown error"}`
    )
  }
  console.log(
    `Worker ${result.status} ${hypothesis.name} at ${result.resultCommitSha ?? "unknown"}; ${pendingRefPushes} ref push(es) pending.`
  )
}
