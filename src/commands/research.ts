import { randomBytes, randomUUID } from "node:crypto"
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
import { freemem } from "node:os"

import {
  researchHypothesisPlanSchema,
  type ResearchHypothesisPlan,
} from "../protocol"
import { optionValues, type Args } from "../lib/args"
import {
  deliverTerminalExperimentAttempt,
  ExperimentDeliveryError,
} from "./exp"
import {
  ApiError,
  closeCampaignHypothesis,
  getCampaignOverview,
  acquireResearchWorkerLease,
  acquireResearchWorkerLeasesBatch,
  createCampaignHypothesis,
  createCampaignSession,
  createCampaignKnowledge,
  createWorkerKnowledge,
  getResearchSessionControlState,
  getResearchSessionBrief,
  getWorkerResearchBrief,
  getResearchSessionStateBrief,
  getResearchSessionLive,
  getResearchSessionState,
  heartbeatWorkersBatch,
  heartbeatWorker,
  listCampaignExperiments,
  listCampaignHypotheses,
  listCampaignKnowledge,
  listWorkerKnowledge,
  listProjectCampaigns,
  reconcileCampaign,
  reopenCampaignHypothesis,
  renderApiTimingSummary,
  resetApiTimingSummary,
  settleResearchSession,
  scaleCampaignSession,
  stopCampaignSession,
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
  normalizeWorkerModel,
  profileNameFromArgs,
  readConfig,
  validateBuiltInWorkerAgent,
  type BuiltInWorkerAgent,
} from "../lib/config"
import { emitEvent } from "../lib/events"
import { currentCommit, git, repoRoot } from "../lib/git"
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
import {
  readSupervisorControlStateSnapshot,
  supervisorControlStateIsFresh,
  writeSupervisorControlStateSnapshot,
} from "../lib/supervisor-control-state"
import {
  getWorkerRuntimeContextCached,
  readWorkerRuntimeContext,
} from "../lib/worker-context"
import {
  readWorkerFinishMarker,
  type WorkerFinishMarker,
} from "../lib/worker-finish"
import { readWorkerReportMarker } from "../lib/worker-reports"
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
  abandonNonterminalWorkflowRunsForWorker,
  clearLocalAttempt,
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
import { formatAge } from "../lib/tui"
import {
  activitySummaryForManifest,
  readWorkerLatestState,
  type WorkerLatestState,
  writeWorkerLatestState,
} from "../lib/worker-activity"
import {
  buildWorkerInvocation,
  classifyProviderFailure,
  lowestFreeSlot,
  manifestIsTerminal,
  preflightWorkerInvocation,
  preflightProviderModel,
  preflightWorkerProtocol,
  providerRuntimeEnvironment,
  resolveProviderExecutable,
  readWorkerLaunchManifests,
  workerRuntimeEnvironment,
  workerRuntimePaths,
  workerGitWritableRoots,
  workerLaunchPaths,
  writeWorkerCliWrapper,
  writeWorkerLaunchManifest,
  writeWorkerRuntimeContext,
  type WorkerTeardownManifest,
  type WorkerInvocation,
  type WorkerLaunchManifest,
  type WorkerAgentKind,
  type WorkerCliWrapper,
  type WorkerRuntimePaths,
  type WorkerTerminalReasonCode,
  type ProviderFailureClass,
} from "../lib/worker-launcher"
import { readHypothesisWorkerPrompt } from "../lib/worker-prompt"

function createWorkerCredential() {
  return `owx_worker_v1_${randomBytes(32).toString("base64url")}`
}

function markResearchPreflightFailure(error: unknown) {
  if (
    !(
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
    )
  )
    return
  try {
    Object.defineProperty(
      error,
      Symbol.for("onyx.telemetry.research_preflight_failure"),
      { value: true, configurable: true, enumerable: false }
    )
  } catch {
    // Frozen/non-object throws still propagate normally without the optional marker.
  }
}

function aggregateChildRssBytes(manifests: WorkerLaunchManifest[]) {
  const pids = manifests
    .filter(
      (manifest) =>
        manifest.status === "starting" || manifest.status === "running"
    )
    .map((manifest) => manifest.pid)
    .filter((pid): pid is number => typeof pid === "number" && pid > 0)
  if (pids.length === 0) return 0
  const result = spawnSync("ps", ["-o", "rss=", "-p", pids.join(",")], {
    encoding: "utf8",
  })
  if (result.status !== 0) return 0
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .reduce((total, value) => total + (Number(value) || 0) * 1024, 0)
}

const MAX_WORKER_SHUTDOWN_CUSHION_MS = 90_000
const MIN_WORKER_SHUTDOWN_CUSHION_MS = 15_000
const MAX_WORKER_HARD_STOP_GRACE_MS = 30_000
const BUILTIN_AGENT_MIN_USEFUL_LAUNCH_MS = 5 * 60_000
const CUSTOM_WORKER_MIN_USEFUL_LAUNCH_MS = 30_000
const DEFAULT_FIRST_ATTEMPT_WARNING_MS = 180_000
const MAX_LOCAL_SUPERVISOR_WORKERS = 250
// Server-side verification is push-webhook-first; the supervisor sweep is a
// backstop for lost webhooks, not the primary heal path.
const GIT_VERIFICATION_BACKSTOP_INTERVAL_MS = 10 * 60_000
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
  return env
}

type SessionCleanupStatus = ApiSession["cleanupStatus"]
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
type NoProgressWorkerExit = {
  at: string
  workerId: string | null
  hypothesisId: string
  status: HypothesisRunResult["status"]
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
  let serialized = JSON.stringify(record)
  const originalBytes = Buffer.byteLength(serialized)
  if (originalBytes > 8 * 1024) {
    serialized = JSON.stringify({
      ...record,
      ...(event.summary ? { summary: event.summary.slice(0, 4000) } : {}),
      metadata: {
        truncated: true,
        originalBytes,
      },
    })
  }
  await appendFile(manifest.activityJsonlPath, `${serialized}\n`, "utf8").catch(
    () => {}
  )
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
      "Review recent experiments, experiment notes, and shared knowledge before editing.",
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

function durableTeardownResultCommit(
  teardown: WorkerTeardownManifest | null | undefined
) {
  return teardown &&
    (teardown.attemptDelivery === "delivered" ||
      teardown.attemptDelivery === "duplicate")
    ? teardown.resultCommitSha
    : null
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
    gitLabel: durableTeardownResultCommit(manifest.teardown),
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
        durableTeardownResultCommit(manifest.teardown) ?? worker.gitLabel,
      metadata: {
        manifestPath: manifest.manifestPath,
        reconciledFrom: "worker-manifest",
        ...(manifest.teardown ? { terminal: manifest.teardown } : {}),
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

function createPresenceSupervisor({
  root,
  args,
  sessionId,
  supervisorRunId,
  intervalMs,
  maxConcurrency,
  workerCredentialsByWorkerId,
}: {
  root: string
  args: Args
  sessionId: string
  supervisorRunId: string
  intervalMs: number
  maxConcurrency: number
  workerCredentialsByWorkerId: Map<string, string>
}) {
  const lastSent = new Map<string, string>()
  let sequence = 0
  let lastFullSnapshotAt = 0
  let lastLeaseRenewalAt = 0
  let running: Promise<void> | null = null
  let stopped = false
  let memoryWarningEmitted = false
  let timer: ReturnType<typeof setInterval> | null = null

  type PresenceSnapshotOptions = {
    forceFull?: boolean
    terminal?: boolean
    runtimeStatus?: "starting" | "active" | "draining" | "complete" | "failed"
  }

  let cleanupStartedAt: string | null = null

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
    const runtimeStatus =
      options.runtimeStatus ?? (terminal ? "complete" : "active")
    if (runtimeStatus === "draining" && !cleanupStartedAt) {
      cleanupStartedAt = new Date().toISOString()
    }
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
    const supervisorRssBytes = process.memoryUsage().rss
    const childRssBytes = aggregateChildRssBytes(manifests)
    const availableHostMemoryBytes = freemem()
    const activeChildCount = manifests.filter(
      (manifest) =>
        manifest.status === "starting" || manifest.status === "running"
    ).length
    const averageChildRssBytes =
      activeChildCount > 0 ? childRssBytes / activeChildCount : 0
    const projectedMemoryBytes =
      supervisorRssBytes + averageChildRssBytes * maxConcurrency
    if (
      !memoryWarningEmitted &&
      projectedMemoryBytes > availableHostMemoryBytes * 0.7
    ) {
      memoryWarningEmitted = true
      console.warn(
        `Research processes are using more than 70% of currently available host memory. Reduce --max-concurrency if the host becomes unstable.`
      )
    }
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
            teardown: manifest.teardown,
          }
        : {}
      const status = snapshotStatus({ worker, manifest, latest })
      const snapshot = {
        id: worker.id,
        status,
        phase: latest?.phase ?? manifest?.status ?? worker.phase,
        progressMessage: latest?.progressMessage ?? worker.progressMessage,
        gitLabel:
          worker.gitLabel ??
          durableTeardownResultCommit(manifest?.teardown) ??
          null,
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
            runtimeStatus,
            cleanupStartedAt:
              runtimeStatus === "draining" || terminal
                ? (cleanupStartedAt ?? observedAt)
                : null,
            cleanupCompletedAt: terminal ? observedAt : null,
            cleanupSummary: terminal
              ? { activeProcessCount: 0, workerCount: workerSnapshots.length }
              : {},
            activeWorkerCount,
            launchedWorkerCount: workerSnapshots.length,
            failedLaunchCount,
            uploadedWorkerCount: selectedWorkers.length,
            unchangedWorkerCount,
            droppedOrDeferredWorkerCount,
            providerBackoff: terminal ? null : providerBackoff,
            ignoredPresence:
              cliState?.sessions?.[sessionId]?.ignoredPresence ?? {},
            lastUploadAt: observedAt,
            metadata: {
              splitIndex: index + 1,
              splitCount,
              terminal,
              supervisorRssBytes,
              childRssBytes,
              availableHostMemoryBytes,
              projectedMemoryBytes,
              noProgressBreaker: supervisorTelemetry?.noProgressBreaker ?? null,
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
          const token = workerCredentialsByWorkerId.get(worker.snapshot.id)
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
              status: "running" as const,
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
        const response = await heartbeatWorkersBatch(
          { sessionId, siteId, supervisorRunId, heartbeats },
          args
        )
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

  const jitteredIntervalMs =
    intervalMs + Math.floor(Math.random() * Math.max(1, intervalMs * 0.2))
  timer = setInterval(() => {
    if (!stopped) void run()
  }, jitteredIntervalMs)

  return {
    request() {
      if (!stopped) void run()
    },
    async flush(options: PresenceSnapshotOptions = {}) {
      await run({ ...options, forceFull: true }).catch(() => {})
    },
    async stop(options: PresenceSnapshotOptions = {}) {
      stopped = true
      if (timer) clearInterval(timer)
      await run({ ...options, forceFull: true }).catch(() => {})
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

type SessionCleanupComputation = {
  status: SessionCleanupStatus
  reasons: string[]
  live: ApiSessionLive | null
}

async function computeSessionCleanupStatus({
  root,
  sessionId,
}: {
  root: string
  sessionId: string
}): Promise<SessionCleanupComputation> {
  const cleanupFailures: string[] = []
  const [manifests] = await Promise.all([
    readWorkerLaunchManifests(root, sessionId).catch(() => []),
  ])

  for (let index = 0; index < manifests.length; index += 25) {
    const batch = manifests.slice(index, index + 25)
    if (manifests.length > 25) {
      console.log(
        `cleanup check: workers ${index + 1}-${index + batch.length}/${manifests.length}`
      )
    }
    for (const manifest of batch) {
      if (manifest.status === "starting" || manifest.status === "running") {
        cleanupFailures.push(
          `worker ${manifest.workerId} still ${manifest.status}`
        )
      }
      const teardown = manifest.teardown
      if (!teardown) {
        if (
          manifest.status === "completed" ||
          manifest.status === "failed" ||
          manifest.status === "stopped"
        ) {
          cleanupFailures.push(
            `worker ${manifest.workerId} has no teardown result`
          )
        }
        continue
      }
      if (teardown.worktreeCleanup === "failed") {
        cleanupFailures.push(
          `worker ${manifest.workerId} worktree cleanup failed${
            teardown.error ? `: ${teardown.error}` : ""
          }`
        )
      }
    }
  }

  const live: ApiSessionLive | null = null

  const reasons = cleanupFailures
  return {
    status: cleanupFailures.length > 0 ? "failed" : "complete",
    reasons,
    live,
  }
}

async function writeRemoteSessionCleanup({
  sessionId,
  campaignId,
  status,
  cleanup,
  terminalReason,
  metadata,
  args,
  requireOnline = false,
}: {
  sessionId: string
  campaignId: string
  status: "completed" | "failed" | "stopped"
  cleanup: SessionCleanupComputation
  terminalReason?: SessionTerminalReason | null
  metadata?: Record<string, unknown>
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
          cleanup.reasons.length > 0
            ? cleanup.reasons.slice(0, 5).join("; ")
            : "research session finalized",
        metadata: {
          ...(terminalReason ? { terminalReason } : {}),
          cleanupReasons: cleanup.reasons,
          ...metadata,
        },
      },
      args
    )
  } catch (error) {
    if (requireOnline) throw error
    console.warn(
      `Remote session cleanup was not written: ${errorMessage(error)}`
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
  const dir = join(await onyxStateDir(root), "worktrees", sessionId, workerId)
  if (!(await pathExists(dir))) {
    await withOnyxLock(root, "git-worktree", async () => {
      if (await pathExists(dir)) return
      await mkdir(join(await onyxStateDir(root), "worktrees", sessionId), {
        recursive: true,
      })
      await git(["worktree", "add", "--detach", dir, startingCommitSha], root)
    })
  }
  return { dir }
}

/**
 * Removes a finished worker's disposable worktree. Experiment refs are the
 * only durable Git output; incomplete workspace state is intentionally lost.
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
  const sessionDir = join(await onyxStateDir(root), "worktrees", sessionId)
  const dir = join(sessionDir, workerId)
  if (!(await pathExists(dir))) return
  await withOnyxLock(root, "git-worktree", async () => {
    await git(["worktree", "remove", "--force", dir], root)
    await git(["worktree", "prune"], root).catch(() => {})
    // Last worker out removes the session directory; rmdir refuses to
    // delete a non-empty directory, so earlier workers no-op here.
    await rmdir(sessionDir).catch(() => {})
  })
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

async function withoutProcessExitCode<T>(fn: () => Promise<T>) {
  const previous = process.exitCode
  process.exitCode = undefined
  try {
    return await fn()
  } finally {
    process.exitCode = previous
  }
}

function boundedText(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`
}

async function workspaceDiagnostics({
  worktree,
  startingCommitSha,
}: {
  worktree: string
  startingCommitSha: string
}) {
  const headCommitSha = await currentCommit(worktree).catch(() => null)
  const commitsAhead = headCommitSha
    ? Number(
        await git(
          ["rev-list", "--count", `${startingCommitSha}..${headCommitSha}`],
          worktree
        ).catch(() => "0")
      ) || 0
    : 0
  const status = await git(["status", "--porcelain"], worktree).catch(() => "")
  const changedPaths = status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .slice(0, 50)
  const committedDiff = headCommitSha
    ? await git(
        ["diff", "--stat", startingCommitSha, headCommitSha],
        worktree
      ).catch(() => "")
    : ""
  const dirtyDiff = await git(["diff", "--stat", "HEAD"], worktree).catch(
    () => ""
  )
  const diffStat = boundedText(
    [committedDiff.trim(), dirtyDiff.trim()].filter(Boolean).join("\n"),
    4096
  )
  return {
    headCommitSha,
    commitsAhead,
    dirty: Boolean(status.trim()),
    changedPaths,
    diffStat: diffStat || null,
  }
}

export async function teardownHypothesisAttempt({
  root,
  worktree,
  projectPath,
  campaign,
  setup,
  hypothesis,
  startingCommitSha,
  sessionId,
  assignmentId,
  workerId,
  workerCredential,
  activityManifest,
  args,
  providerExitCode,
  providerSignal,
  timedOut,
  startupTimedOut,
  phase,
  providerError,
  reasonCode,
}: {
  root: string
  worktree: string
  projectPath: string
  campaign: ApiCampaign
  setup: ResearchSetupFile
  hypothesis: ApiHypothesis
  startingCommitSha: string
  sessionId: string
  assignmentId: string
  workerId: string
  workerCredential: string
  activityManifest?: WorkerLaunchManifest | null
  args: Args
  providerExitCode: number | null
  providerSignal: string | null
  timedOut: boolean
  startupTimedOut: boolean
  phase: "completed" | "failed" | "stopped"
  providerError: string | null
  reasonCode: WorkerTerminalReasonCode
}): Promise<WorkerTeardownManifest> {
  const diagnostics = await workspaceDiagnostics({
    worktree,
    startingCommitSha,
  })
  const manifest: WorkerTeardownManifest = {
    attemptDelivery: "none",
    runRef: null,
    resultCommitSha: null,
    resultRefPushStatus: "not_attempted",
    resultRefPushError: null,
    ...diagnostics,
    worktreeCleanup: "pending",
    providerExitCode,
    providerSignal,
    timedOut,
    startupTimedOut,
    phase,
    providerError: providerError ? boundedText(providerError, 1000) : null,
    reasonCode,
    error: null,
  }

  try {
    const warnings = await recordWorkerHarnessWarnings(activityManifest)
    if (warnings.length > 0) manifest.warnings = warnings
    await abandonNonterminalWorkflowRunsForWorker({
      root,
      sessionId,
      workerId,
      hypothesisId: hypothesis.id,
      reason: `Worker teardown: ${reasonCode}`,
    }).catch((error) => {
      manifest.warnings = [
        ...(manifest.warnings ?? []),
        `Could not abandon nonterminal workflow runs: ${boundedText(errorMessage(error), 500)}`,
      ]
    })
    const attempts = await listLocalAttempts(root, {
      sessionId,
      workerId,
      hypothesisId: hypothesis.id,
    })
    if (attempts.length > 1) {
      manifest.attemptDelivery = "ambiguous_discarded"
      manifest.reasonCode = "worker_protocol_violation"
      manifest.error = `Worker produced ${attempts.length} terminal attempt manifests; none were delivered.`
      await Promise.all(
        attempts.map((attempt) =>
          clearLocalAttempt(root, { runRef: attempt.runRef })
        )
      )
      return manifest
    }
    const attempt = attempts[0]
    if (!attempt) return manifest

    manifest.runRef = attempt.runRef
    manifest.resultCommitSha = attempt.resultCommitSha
    const record = await withoutProcessExitCode(() =>
      deliverTerminalExperimentAttempt({
        args,
        context: {
          root: worktree,
          projectPath,
          campaign,
          setup,
          runRef: attempt.runRef,
          sessionId,
          assignmentId,
          hypothesisId: hypothesis.id,
          workerId,
          workerCredential,
        },
      })
    )
    manifest.attemptDelivery =
      record.deliveryOutcome === "duplicate" ? "duplicate" : "delivered"
    manifest.resultRefPushStatus =
      record.deliveryResultRefPushStatus === "failed" ? "failed" : "pushed"
    manifest.resultRefPushError = record.deliveryResultRefPushError
      ? boundedText(record.deliveryResultRefPushError, 1000)
      : null
    return manifest
  } catch (error) {
    manifest.attemptDelivery = "failed"
    manifest.reasonCode = "terminal_attempt_delivery_failed"
    manifest.error = boundedText(errorMessage(error), 1000)
    if (error instanceof ExperimentDeliveryError) {
      manifest.resultRefPushStatus = error.resultRefPushStatus
      manifest.resultRefPushError = error.resultRefPushError
        ? boundedText(error.resultRefPushError, 1000)
        : null
    }
    if (manifest.runRef) {
      await clearLocalAttempt(root, { runRef: manifest.runRef }).catch(() => {})
    }
    return manifest
  }
}

function emptyWorkerTeardown({
  phase,
  reasonCode,
  providerExitCode,
  providerSignal,
  timedOut,
  startupTimedOut,
  providerError,
  error = null,
}: {
  phase: "completed" | "failed" | "stopped"
  reasonCode: WorkerTerminalReasonCode
  providerExitCode: number | null
  providerSignal: string | null
  timedOut: boolean
  startupTimedOut: boolean
  providerError: string | null
  error?: string | null
}): WorkerTeardownManifest {
  return {
    attemptDelivery: "none",
    runRef: null,
    resultCommitSha: null,
    resultRefPushStatus: "not_attempted",
    resultRefPushError: null,
    headCommitSha: null,
    commitsAhead: 0,
    dirty: false,
    changedPaths: [],
    diffStat: null,
    worktreeCleanup: "pending",
    providerExitCode,
    providerSignal,
    timedOut,
    startupTimedOut,
    phase,
    providerError: providerError ? boundedText(providerError, 1000) : null,
    reasonCode,
    error: error ? boundedText(error, 1000) : null,
  }
}

function appendBoundedTeardownError(current: string | null, next: unknown) {
  return boundedText(
    [current, errorMessage(next)].filter(Boolean).join("; "),
    1000
  )
}

async function writeWorkerPrompt({
  root,
  sessionId,
  hypothesis,
  workerId,
  endTimeMs,
}: {
  root: string
  sessionId: string
  hypothesis: ApiHypothesis
  workerId: string
  endTimeMs: number
}) {
  const dir = join(await onyxStateDir(root), "worker-prompts", sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(
    dir,
    `${safeFileSegment(hypothesis.name)}-${safeFileSegment(workerId).slice(0, 12)}.md`
  )
  const nowMs = Date.now()
  const budgetRemainingMs = Math.max(0, endTimeMs - nowMs)
  const shutdownCushionMs = workerShutdownCushionMs(budgetRemainingMs)
  const researchDeadlineMs = Math.max(nowMs, endTimeMs - shutdownCushionMs)
  const shutdownDeadlineMs = Math.max(nowMs, endTimeMs)
  const markdown = await readHypothesisWorkerPrompt()

  await writeFile(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8")
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
  | "assignment_canceled"
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
  controlPollIntervalMs = 1_000,
  preferLocalSupervisorControl = false,
  onRemoteControlState,
}: {
  root: string
  sessionId: string
  assignmentId?: string
  args: Args
  settleBeforeCheck?: boolean
  settlementNudgeIntervalMs?: number
  controlPollIntervalMs?: number
  preferLocalSupervisorControl?: boolean
  onRemoteControlState?: (control: ApiSessionControlState) => Promise<void>
}) {
  let nextSettlementNudgeMs = 0
  let nextControlPollMs = 0
  let cachedResult: ResearchStopCheck | null = null
  return {
    async check({
      nowMs = Date.now(),
      force = false,
    }: { nowMs?: number; force?: boolean } = {}) {
      if (!force && cachedResult && nowMs < nextControlPollMs) {
        return cachedResult
      }
      nextControlPollMs =
        nowMs +
        controlPollIntervalMs +
        Math.floor(Math.random() * Math.max(1, controlPollIntervalMs * 0.25))
      try {
        if (preferLocalSupervisorControl && !force) {
          const local = await collectResearchStopReasons({
            root,
            sessionId,
            nowMs,
          })
          if (local.shouldStop) {
            cachedResult = local
            return cachedResult
          }
        }
        const shouldNudge =
          settleBeforeCheck &&
          nowMs >= nextSettlementNudgeMs &&
          Boolean(cachedResult?.controlState?.progress.receivedExperimentCount)
        let control: Awaited<ReturnType<typeof getResearchSessionControlState>>
        const localSnapshot =
          preferLocalSupervisorControl && !force
            ? await readSupervisorControlStateSnapshot({
                root,
                sessionId,
              }).catch(() => null)
            : null
        if (
          localSnapshot &&
          supervisorControlStateIsFresh(localSnapshot, nowMs)
        ) {
          control = localSnapshot.control
        } else if (shouldNudge) {
          nextSettlementNudgeMs =
            nowMs +
            settlementNudgeIntervalMs +
            Math.floor(
              Math.random() * Math.max(1, settlementNudgeIntervalMs * 0.25)
            )
          control = await settleResearchSession(sessionId, args).catch(() =>
            getResearchSessionControlState(sessionId, args)
          )
        } else {
          control = await getResearchSessionControlState(sessionId, args)
        }
        if (!localSnapshot || control !== localSnapshot.control) {
          await onRemoteControlState?.(control).catch(() => {})
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
          control.canceledAssignmentIds.includes(assignmentId)
        ) {
          add("assignment_canceled", "hypothesis assignment canceled")
        }
        cachedResult = {
          shouldStop: reasons.length > 0,
          sessionId,
          reasonCodes: [...reasonCodes],
          reasons,
          controlState: control,
        }
        return cachedResult
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
  intervalMs = 30_000,
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

  const patchControlState = async (control: ApiSessionControlState) => {
    const previous = latestSnapshot
    if (!previous?.brief) return
    const now = new Date().toISOString()
    await write({
      ...previous,
      sequence: previous.sequence + 1,
      generatedAt: now,
      brief: {
        ...previous.brief,
        session: {
          ...previous.brief.session,
          runtimeState: control.runtimeState,
          status: control.status,
          outcome: control.outcome,
          cleanup: control.cleanup,
          deadlineAt: control.progress.deadlineAt,
          endedAt: control.progress.endedAt,
          endReason: control.progress.endReason,
        },
        campaign: {
          ...previous.brief.campaign,
          status: control.campaignStatus,
        },
        progress: control.progress,
        updatedAt: control.updatedAt,
      },
    })
  }

  const refresh = ({
    force = false,
  }: { force?: boolean } = {}): Promise<void> => {
    const nowMs = Date.now()
    if (inFlight) {
      return force ? inFlight.then(() => refresh({ force: true })) : inFlight
    }
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

  return { writePlaceholder, refresh, patchControlState }
}

export function sessionStateBriefControlSignature(
  control: ApiSessionControlState
) {
  return JSON.stringify({
    acceptedExperimentCount: control.progress.acceptedExperimentCount,
    activeHypothesisCount: control.launch.activeHypothesisCount,
    canceledAssignmentIds: [...control.canceledAssignmentIds].sort(),
    campaignStatus: control.campaignStatus,
    sessionStatus: control.status,
    outcomeStatus: control.outcome.status,
    cleanupStatus: control.cleanup.status,
  })
}

async function withWorkerHeartbeat<T>({
  root,
  args,
  workerId,
  workerCredential,
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
  workerCredential?: string
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
          workerCredential,
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

type LifecycleHeartbeat = Parameters<
  typeof heartbeatWorkersBatch
>[0]["heartbeats"][number]

export function createLifecycleHeartbeatPublisher(
  context: {
    args: Args
    sessionId: string
    siteId: string
    supervisorRunId: string
  },
  send: typeof heartbeatWorkersBatch = heartbeatWorkersBatch
) {
  const pending = new Map<
    string,
    {
      heartbeat: LifecycleHeartbeat
      waiters: Array<{ resolve: () => void; reject: (error: Error) => void }>
    }
  >()
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing: Promise<void> | null = null

  const flush = async (): Promise<void> => {
    if (flushing) return flushing
    if (timer) clearTimeout(timer)
    timer = null
    const entries = [...pending.entries()].slice(0, 500)
    if (entries.length === 0) return
    for (const [workerId] of entries) pending.delete(workerId)
    flushing = (async () => {
      try {
        const response = await send(
          {
            sessionId: context.sessionId,
            siteId: context.siteId,
            supervisorRunId: context.supervisorRunId,
            heartbeats: entries.map(([, entry]) => entry.heartbeat),
          },
          context.args
        )
        const resultByWorkerId = new Map(
          response.results.map((result) => [result.workerId, result])
        )
        for (const [workerId, entry] of entries) {
          const result = resultByWorkerId.get(workerId)
          if (result?.ok) {
            for (const waiter of entry.waiters) waiter.resolve()
            continue
          }
          const error = new Error(
            `Lifecycle heartbeat failed for worker ${workerId}: ${
              result && !result.ok
                ? result.error.message
                : "batch response omitted worker"
            }`
          )
          for (const waiter of entry.waiters) waiter.reject(error)
        }
      } catch (error) {
        const failure = new Error(
          `Lifecycle heartbeat batch failed: ${errorMessage(error)}`
        )
        for (const [, entry] of entries) {
          for (const waiter of entry.waiters) waiter.reject(failure)
        }
      } finally {
        flushing = null
      }
      if (pending.size > 0) await flush()
    })()
    return flushing
  }

  const enqueue = (heartbeat: LifecycleHeartbeat) =>
    new Promise<void>((resolve, reject) => {
      const current = pending.get(heartbeat.workerId)
      pending.set(heartbeat.workerId, {
        heartbeat,
        waiters: [...(current?.waiters ?? []), { resolve, reject }],
      })
      if (!timer) {
        timer = setTimeout(() => void flush(), 50)
      }
    })

  return { enqueue, flush }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function mainWorktreeStatus(root: string) {
  return (await git(["status", "--porcelain"], root)).trim()
}

export function teardownStatusLabel(
  status: WorkerTeardownManifest["attemptDelivery"]
) {
  switch (status) {
    case "none":
      return "no terminal attempt"
    case "delivered":
      return "terminal attempt delivered"
    case "duplicate":
      return "terminal attempt already delivered"
    case "ambiguous_discarded":
      return "ambiguous terminal attempts discarded"
    case "failed":
      return "terminal attempt delivery failed"
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
  lastOutputAt,
}: {
  hypothesisName: string
  logPath: string
  lastOutputAt: string | null
}) {
  const output = lastOutputAt
    ? `last output ${formatAge(lastOutputAt, Date.now())} ago`
    : "no output yet"
  return `${hypothesisName} phase=running; ${output}; log=${logPath}`
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
}: {
  root: string
  manifest: WorkerLaunchManifest
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
      promptPath: manifest.promptPath,
      logPath: manifest.logPath,
      activityLogPath: manifest.activityLogPath,
      manifestPath: manifest.manifestPath,
      exitCode: manifest.exitCode,
      signal: manifest.signal,
      timedOut: manifest.timedOut,
      startupTimedOut: manifest.startupTimedOut,
      lastOutputAt: manifest.lastOutputAt,
      error: manifest.error ?? manifest.teardown?.error ?? null,
      metadata: {
        agentKind: manifest.agentKind,
        command: manifest.command,
        args: manifest.args,
        onyxWorkerPath: manifest.onyxWorkerPath,
        workerContextPath: manifest.workerContextPath,
        latestStatePath: manifest.latestStatePath,
        addedWritableRoots: manifest.addedWritableRoots,
        teardown: manifest.teardown,
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
  terminalReason?: DurableWorkerTerminalReason
  siteFatal?: boolean
  providerFailureClass?: ProviderFailureClass | null
}

type DurableWorkerTerminalReason = NonNullable<
  ApiWorker["terminalOutcome"]
>["reason"]

export function classifyDurableWorkerTerminalReason({
  stoppedByHarness,
  stopReasonCodes,
  cleanupFailed,
  attemptDeliveryFailed,
  reportedExperimentCount,
  explicitFinishReason,
  timedOut,
  protocolViolation,
  processFailed,
  providerFailureClass,
  error,
}: {
  stoppedByHarness: boolean
  stopReasonCodes?: ResearchStopReasonCode[]
  cleanupFailed: boolean
  attemptDeliveryFailed: boolean
  reportedExperimentCount: number
  explicitFinishReason: WorkerFinishMarker["reason"] | null
  timedOut: boolean
  protocolViolation: boolean
  processFailed: boolean
  providerFailureClass: ProviderFailureClass | null
  error: string | null
}): DurableWorkerTerminalReason {
  if (stopReasonCodes?.includes("assignment_canceled")) {
    return "assignment_canceled"
  }
  if (
    stopReasonCodes?.includes("deadline_reached") ||
    stopReasonCodes?.includes("experiment_target_reached")
  ) {
    return "session_cutoff"
  }
  if (stoppedByHarness || stopReasonCodes?.length) return "session_stopped"
  if (reportedExperimentCount > 0) return "completed_with_experiments"
  if (timedOut) return "worker_timeout"

  const message = error ?? ""
  if (
    protocolViolation ||
    /protocol mismatch|unsupported (?:worker )?context|worker context .*mismatch|handshake failed/i.test(
      message
    )
  ) {
    return "worker_protocol_mismatch"
  }
  if (
    /network policy|network access (?:is )?(?:denied|disabled|blocked)|egress (?:denied|blocked)/i.test(
      message
    )
  ) {
    return "worker_network_policy"
  }
  if (
    /sandbox violation|sandbox denied|outside (?:the )?workspace|read-only file system|operation not permitted by sandbox/i.test(
      message
    )
  ) {
    return "worker_sandbox_failed"
  }
  if (
    /evaluation failed|metric tool failed|checks_failed|setup_violation|invalid metric output/i.test(
      message
    )
  ) {
    return "worker_evaluation_failed"
  }
  if (
    /git (?:push|commit|checkout|worktree) failed|failed to (?:push|commit|checkout)|result ref .*failed/i.test(
      message
    )
  ) {
    return "worker_git_failed"
  }
  if (processFailed) {
    switch (providerFailureClass) {
      case "auth":
        return "provider_auth"
      case "quota":
        return "provider_quota_exhausted"
      case "model_unsupported":
        return "provider_model_unsupported"
      case "rate_limit":
        return "provider_rate_limited"
      case "overloaded":
        return "provider_overloaded"
      case "unavailable":
        return "provider_unavailable"
      default:
        return "provider_process_failed"
    }
  }
  if (explicitFinishReason) return explicitFinishReason
  if (attemptDeliveryFailed) return "worker_report_delivery_failed"
  if (cleanupFailed) return "cleanup_failed"
  return "worker_no_progress"
}

export function durableWorkerReasonIsSiteFatal(
  reason: DurableWorkerTerminalReason
) {
  return (
    reason === "provider_auth" ||
    reason === "provider_quota_exhausted" ||
    reason === "provider_model_unsupported" ||
    reason === "worker_protocol_mismatch" ||
    reason === "worker_network_policy" ||
    reason === "worker_sandbox_failed"
  )
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
  preacquiredLease,
  slotIndex = null,
  onRegistered,
  lifecycleHeartbeats,
  providerExecutable,
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
  preacquiredLease?: ApiWorkerLease | null
  /** Supervisor capacity slot this worker occupies (stable across relaunches). */
  slotIndex?: number | null
  onRegistered?: (worker: {
    workerId: string
    hypothesisId: string
    workerCredential: string
  }) => void
  lifecycleHeartbeats?: ReturnType<typeof createLifecycleHeartbeatPublisher>
  providerExecutable?: string
  args: Args
}): Promise<HypothesisRunResult> {
  let workerId: string | undefined
  let workerName: string | null = null
  let workerCredential: string | undefined
  let resultCommitSha: string | undefined
  let worktree: string | null = null
  let assignmentId: string | null = null
  let startingCommitSha: string | null = null
  let teardown: WorkerTeardownManifest | null = null
  let launchManifest: WorkerLaunchManifest | null = null
  let launchPaths: Awaited<ReturnType<typeof workerLaunchPaths>> | null = null
  let terminalPhase: "completed" | "failed" | "stopped" = "failed"
  let terminalReasonCode: WorkerTerminalReasonCode = "startup_failure"
  let providerExitCode: number | null = null
  let providerSignal: string | null = null
  let providerTimedOut = false
  let providerStartupTimedOut = false
  let stoppedByHarness = false
  let harnessStopReasonCodes: ResearchStopReasonCode[] = []
  let explicitFinishMarker: WorkerFinishMarker | null = null
  let providerError: string | null = null
  let providerFailureClass: ProviderFailureClass | null = null
  let outcome: HypothesisRunResult | null = null
  let firstAttemptWarningTimer: ReturnType<typeof setTimeout> | null = null
  let launchPersistQueue: Promise<void> = Promise.resolve()
  const persistLaunchManifest = (manifest: WorkerLaunchManifest) => {
    const snapshot = manifest
    const write = launchPersistQueue
      .catch(() => {})
      .then(() => persistWorkerLaunchState({ root, manifest: snapshot }))
    launchPersistQueue = write
    return write
  }
  let workerCliWrapper: WorkerCliWrapper | null = null
  let runtimePaths: WorkerRuntimePaths | null = null

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
          leaseCredential: createWorkerCredential(),
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
    assignmentId = lease.assignment.id
    startingCommitSha = lease.assignment.startingCommitSha
    workerCredential = lease.workerCredential
    hypothesis = lease.hypothesis
    workerId = worker.id
    workerName = worker.workerName
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
      workerCredential,
    })
    if (!lifecycleHeartbeats)
      await heartbeatWorker(
        worker.id,
        {
          workerCredential,
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

    worktree = join(await onyxStateDir(root), "worktrees", sessionId, worker.id)
    const initialLaunchPaths = await workerLaunchPaths({
      root,
      sessionId,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
    })
    launchPaths = initialLaunchPaths
    const initialAgentKind: WorkerAgentKind = workerCommand
      ? "custom"
      : (agentKind as WorkerAgentKind)
    const initialManifest: WorkerLaunchManifest = {
      schemaVersion: 2,
      agentKind: initialAgentKind,
      workerModel,
      command: workerCommand ?? agentKind,
      args: [],
      onyxWorkerPath: null,
      workerContextPath: null,
      addedWritableRoots: [],
      cwd: worktree,
      promptPath: "",
      logPath: initialLaunchPaths.logPath,
      activityLogPath: initialLaunchPaths.activityLogPath,
      activityJsonlPath: initialLaunchPaths.activityJsonlPath,
      latestStatePath: initialLaunchPaths.latestStatePath,
      manifestPath: initialLaunchPaths.manifestPath,
      sessionId,
      startingCommitSha: lease.assignment.startingCommitSha,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
      workerName: worker.workerName,
      supervisorRunId,
      pid: null,
      processStartedAt: null,
      commandIdentity: null,
      slotIndex,
      version: null,
      startedAt: new Date().toISOString(),
      lastOutputAt: null,
      completedAt: null,
      status: "starting",
      exitCode: null,
      signal: null,
      timedOut: false,
      startupTimedOut: false,
      error: null,
      preflight: null,
      teardown: null,
    }
    launchManifest = initialManifest
    await persistLaunchManifest(initialManifest)
    const worktreeInfo = await ensureWorktree({
      root,
      startingCommitSha: lease.assignment.startingCommitSha,
      sessionId,
      workerId: worker.id,
    })
    worktree = worktreeInfo.dir
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
      sessionId,
      hypothesis,
      workerId: worker.id,
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
        schemaVersion: 5,
        campaignId: campaign.id,
        campaignName: campaign.name,
        sessionId,
        assignmentId: lease.assignment.id,
        startingCommitSha: lease.assignment.startingCommitSha,
        hypothesisId: hypothesis.id,
        hypothesisName: hypothesis.name,
        assignment: {
          id: lease.assignment.id,
          startingCommitSha: lease.assignment.startingCommitSha,
          sourceExperimentId: lease.assignment.sourceExperimentId,
        },
        hypothesis: {
          id: hypothesis.id,
          name: hypothesis.name,
          description: hypothesis.description,
          status: hypothesis.status,
          plan: hypothesis.plan,
          bestMetricValue: hypothesis.bestMetricValue,
          bestCommitSha: hypothesis.bestCommitSha,
          experimentCount: hypothesis.experimentCount,
          lastWorkedAt: hypothesis.lastWorkedAt,
        },
        workerId: worker.id,
        workerCredential: workerCredential,
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
      ONYX_WORKER_ID: worker.id,
      ONYX_WORKER_CREDENTIAL: workerCredential,
      ONYX_WORKER_BIN: workerCliWrapper.workerPath,
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
    const preparedInvocation = buildWorkerInvocation({
      agentKind,
      workerCommand,
      worktree,
      prompt: prompt.markdown,
      addedWritableRoots,
      workerModel,
      workerTitle: worker.id,
      providerExecutable,
    })
    const preparedLaunchPaths = await workerLaunchPaths({
      root,
      sessionId,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
    })
    launchPaths = preparedLaunchPaths
    const readyManifest: WorkerLaunchManifest = {
      ...initialManifest,
      agentKind: preparedInvocation.agentKind,
      workerModel: preparedInvocation.workerModel ?? null,
      command: preparedInvocation.command,
      args: preparedInvocation.redactedArgs,
      onyxWorkerPath: workerCliWrapper.workerPath,
      workerContextPath: runtimePaths.contextPath,
      addedWritableRoots: preparedInvocation.addedWritableRoots,
      cwd: worktree,
      promptPath: prompt.path,
      logPath: preparedLaunchPaths.logPath,
      activityLogPath: preparedLaunchPaths.activityLogPath,
      activityJsonlPath: preparedLaunchPaths.activityJsonlPath,
      latestStatePath: preparedLaunchPaths.latestStatePath,
      manifestPath: preparedLaunchPaths.manifestPath,
      sessionId,
      startingCommitSha: lease.assignment.startingCommitSha,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
      workerName: worker.workerName,
    }
    launchManifest = readyManifest
    await persistLaunchManifest(readyManifest)
    if (!lifecycleHeartbeats)
      await heartbeatWorker(
        worker.id,
        {
          workerCredential,
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
    const preflight = await preflightWorkerInvocation(preparedInvocation, {
      cwd: worktree,
      env: workerRunEnv,
      campaignName: campaign.name,
      sessionId,
      assignmentId: lease.assignment.id,
      workerId: worker.id,
      onyxWorkerPath: workerCliWrapper.workerPath,
    })
    const preflightManifest: WorkerLaunchManifest = {
      ...readyManifest,
      version: preflight.version,
      preflight,
    }
    launchManifest = preflightManifest
    await persistLaunchManifest(preflightManifest)
    console.log(
      `worker=${worker.id} hypothesis=${JSON.stringify(hypothesis.name)} status=started log=${preparedLaunchPaths.logPath}`
    )
    await appendWorkerActivityEvent(preflightManifest, {
      type: "process_start",
      phase: "starting",
      summary: `Starting ${preparedInvocation.agentKind} worker for ${hypothesis.name}`,
      metadata: {
        command: preparedInvocation.command,
        args: preparedInvocation.redactedArgs,
        ...workerModelMetadata(workerModel),
      },
    })
    await appendWorkerActivityEvent(preflightManifest, {
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
    const heartbeatSampleEveryMs =
      nonnegativeNumberOption(args, "heartbeat-sample-interval", 0) * 1000
    if (firstAttemptWarningMs > 0) {
      const warningManifest = launchManifest
      firstAttemptWarningTimer = setTimeout(() => {
        void hasWorkerLoggedAttempt({ root, workerId: worker.id })
          .then(async (hasAttempt) => {
            if (hasAttempt) return
            if (lifecycleHeartbeats) {
              await appendWorkerActivityEvent(warningManifest, {
                type: "warning",
                phase: "orienting",
                summary:
                  "No logged workflow attempt yet; worker may still be orienting or sweeping.",
                metadata: {
                  warningAfterSeconds: Math.round(firstAttemptWarningMs / 1000),
                },
              })
              return
            }
            await heartbeatWorker(
              worker.id,
              {
                workerCredential,
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
      preferLocalSupervisorControl: true,
    })
    const workerResult = await withWorkerHeartbeat({
      root,
      args,
      workerId: worker.id,
      workerCredential,
      sessionId,
      hypothesisId: hypothesis.id,
      latestStatePath:
        launchManifest?.latestStatePath ?? preparedLaunchPaths.latestStatePath,
      phase: "running",
      progressMessage: () =>
        workerProgress({
          hypothesisName: hypothesis.name,
          logPath: launchManifest?.logPath ?? preparedLaunchPaths.logPath,
          lastOutputAt: launchManifest?.lastOutputAt ?? null,
        }),
      metadata: () =>
        launchManifest
          ? workerMetadata({
              invocation: preparedInvocation,
              manifest: launchManifest,
            })
          : {},
      run: () =>
        runStreamingProcess(
          preparedInvocation.command,
          preparedInvocation.args,
          {
            cwd: worktree!,
            timeoutMs: Math.max(
              1,
              Math.min(workerTimeoutMs, hardEndTimeMs - Date.now())
            ),
            startupTimeoutMs,
            killGraceMs: 5000,
            logPath: preparedLaunchPaths.logPath,
            activityLogPath: preparedLaunchPaths.activityLogPath,
            logHeader: [
              `# agent: ${preparedInvocation.agentKind}`,
              `# prompt: ${prompt.path}`,
              `# worker: ${worker.id}`,
              `# hypothesis: ${hypothesis.id}`,
            ].join("\n"),
            stdin: preparedInvocation.stdin,
            env: workerRunEnv,
            redactValues: [
              ...(workerCredential ? [workerCredential] : []),
              ...Object.entries(workerRunEnv)
                .filter(([name, value]) =>
                  Boolean(
                    value &&
                    /(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD)$/i.test(name)
                  )
                )
                .map(([, value]) => value as string),
            ],
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
              pollMs: 5000 + Math.floor(Math.random() * 1250),
              shouldCancel: async () => {
                const check = await stopChecker.check()
                if (check.shouldStop) {
                  harnessStopReasonCodes = check.reasonCodes
                }
                return check.shouldStop
              },
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
              preparedInvocation.agentKind === "opencode"
                ? ({ text }) => shouldTerminateOpenCodeOnOutput(text)
                : undefined,
          }
        ),
      quiet,
      consoleEveryMs: 60_000,
      heartbeatSampleEveryMs: lifecycleHeartbeats ? 0 : heartbeatSampleEveryMs,
    })
    if (firstAttemptWarningTimer) clearTimeout(firstAttemptWarningTimer)
    stoppedByHarness = workerResult.cancelled
    explicitFinishMarker = runtimePaths?.contextPath
      ? await readWorkerFinishMarker(runtimePaths.contextPath)
      : null
    const finalStopCheck = await stopChecker
      .check({ force: true })
      .catch(() => null)
    if (finalStopCheck?.shouldStop) {
      harnessStopReasonCodes = finalStopCheck.reasonCodes
    }
    providerExitCode = workerResult.code
    providerSignal = workerResult.signal
    providerTimedOut = workerResult.timedOut
    providerStartupTimedOut = workerResult.startupTimedOut
    if (launchManifest) {
      launchManifest = {
        ...launchManifest,
        exitCode: workerResult.code,
        signal: workerResult.signal,
        timedOut: workerResult.timedOut,
        startupTimedOut: workerResult.startupTimedOut,
        lastOutputAt: workerResult.lastOutputAt,
      }
      await persistLaunchManifest(launchManifest)
      await appendWorkerActivityEvent(launchManifest, {
        type: "process_exit",
        phase: stoppedByHarness
          ? "stopped"
          : workerResult.code === 0
            ? "completed"
            : "failed",
        summary: `${preparedInvocation.agentKind} exited with code ${workerResult.code ?? "null"}`,
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
    terminalReasonCode = stoppedByHarness
      ? "stopped"
      : workerResult.startupTimedOut
        ? "startup_failure"
        : workerResult.timedOut
          ? "timeout"
          : workerFailure
            ? "provider_failure"
            : "completed"
    if (stoppedByHarness) {
      terminalPhase = "stopped"
      outcome = {
        hypothesis,
        workerId: worker.id,
        resultCommitSha,
        status: "stopped",
        startupTimedOut: workerResult.startupTimedOut,
      }
    } else if (workerFailure) {
      terminalPhase = "failed"
      providerError = compactProviderErrorSummary(workerFailure)
      providerFailureClass = classifyProviderFailure(workerFailure)
      outcome = {
        hypothesis,
        workerId: worker.id,
        resultCommitSha,
        status: "failed",
        error: providerError,
        startupTimedOut: workerResult.startupTimedOut,
      }
    } else {
      terminalPhase = "completed"
      outcome = {
        hypothesis,
        workerId: worker.id,
        resultCommitSha,
        status: "completed",
        startupTimedOut: workerResult.startupTimedOut,
      }
    }
  } catch (error) {
    const message = compactProviderErrorSummary(errorMessage(error))
    providerError = message
    providerFailureClass = classifyProviderFailure(message)
    terminalPhase = "failed"
    terminalReasonCode = providerStartupTimedOut
      ? "startup_failure"
      : providerTimedOut
        ? "timeout"
        : providerExitCode === null
          ? "startup_failure"
          : "provider_failure"
    outcome = {
      hypothesis,
      workerId,
      resultCommitSha,
      status: "failed",
      error: message,
      startupTimedOut: providerStartupTimedOut,
    }
  } finally {
    if (firstAttemptWarningTimer) clearTimeout(firstAttemptWarningTimer)
    if (workerId) {
      const terminalOutcome =
        outcome ??
        ({
          hypothesis,
          workerId,
          resultCommitSha,
          status: "failed",
          error: providerError ?? "Worker did not produce a terminal outcome",
          startupTimedOut: providerStartupTimedOut,
        } satisfies HypothesisRunResult)
      outcome = terminalOutcome
      const worktreeCandidate =
        worktree ??
        join(await onyxStateDir(root), "worktrees", sessionId, workerId)
      const hasWorktree = await pathExists(worktreeCandidate)

      if (!launchManifest) {
        const fallbackPaths =
          launchPaths ??
          (await workerLaunchPaths({
            root,
            sessionId,
            hypothesisId: hypothesis.id,
            hypothesisName: hypothesis.name,
            workerId,
          }).catch(() => null))
        if (fallbackPaths) {
          const fallbackAgentKind: WorkerAgentKind = workerCommand
            ? "custom"
            : (agentKind as WorkerAgentKind)
          launchManifest = {
            schemaVersion: 2,
            agentKind: fallbackAgentKind,
            workerModel,
            command: workerCommand ?? agentKind,
            args: [],
            onyxWorkerPath: workerCliWrapper?.workerPath ?? null,
            workerContextPath: runtimePaths?.contextPath ?? null,
            addedWritableRoots: [],
            cwd: worktreeCandidate,
            promptPath: "",
            logPath: fallbackPaths.logPath,
            activityLogPath: fallbackPaths.activityLogPath,
            activityJsonlPath: fallbackPaths.activityJsonlPath,
            latestStatePath: fallbackPaths.latestStatePath,
            manifestPath: fallbackPaths.manifestPath,
            sessionId,
            startingCommitSha: startingCommitSha ?? "",
            hypothesisId: hypothesis.id,
            hypothesisName: hypothesis.name,
            workerId,
            workerName: workerName ?? hypothesis.name,
            supervisorRunId,
            pid: null,
            processStartedAt: null,
            commandIdentity: null,
            slotIndex,
            version: null,
            startedAt: new Date().toISOString(),
            lastOutputAt: null,
            completedAt: null,
            status: "starting",
            exitCode: providerExitCode,
            signal: providerSignal,
            timedOut: providerTimedOut,
            startupTimedOut: providerStartupTimedOut,
            error: providerError,
            preflight: null,
            teardown: null,
          }
        }
      }

      if (!lifecycleHeartbeats)
        await heartbeatWorker(
          workerId,
          {
            workerCredential,
            status: "running",
            sessionId,
            hypothesisId: hypothesis.id,
            phase: "teardown",
            event: "teardown_started",
            progressMessage: `Delivering terminal attempt and tearing down ${hypothesis.name}`,
            gitLabel: null,
          },
          args
        ).catch(() => {})
      if (launchManifest) {
        await appendWorkerActivityEvent(launchManifest, {
          type: "phase_change",
          phase: "teardown",
          summary: "Delivering terminal attempt before workspace disposal",
        }).catch(() => {})
      }

      if (
        hasWorktree &&
        assignmentId &&
        startingCommitSha &&
        workerCredential
      ) {
        teardown = await teardownHypothesisAttempt({
          root,
          worktree: worktreeCandidate,
          projectPath,
          campaign,
          setup,
          hypothesis,
          startingCommitSha,
          sessionId,
          assignmentId,
          workerId,
          workerCredential,
          activityManifest: launchManifest,
          args,
          providerExitCode,
          providerSignal,
          timedOut: providerTimedOut,
          startupTimedOut: providerStartupTimedOut,
          phase: terminalPhase,
          providerError,
          reasonCode: terminalReasonCode,
        }).catch((teardownError) =>
          emptyWorkerTeardown({
            phase: "failed",
            reasonCode: "terminal_attempt_delivery_failed",
            providerExitCode,
            providerSignal,
            timedOut: providerTimedOut,
            startupTimedOut: providerStartupTimedOut,
            providerError,
            error: errorMessage(teardownError),
          })
        )
      } else {
        teardown = emptyWorkerTeardown({
          phase: terminalPhase,
          reasonCode: terminalReasonCode,
          providerExitCode,
          providerSignal,
          timedOut: providerTimedOut,
          startupTimedOut: providerStartupTimedOut,
          providerError,
        })
      }
      const durableAttemptDelivered =
        teardown.attemptDelivery === "delivered" ||
        teardown.attemptDelivery === "duplicate"
      const reportMarker = runtimePaths?.contextPath
        ? await readWorkerReportMarker(runtimePaths.contextPath)
        : null
      const reportedExperimentCount =
        (reportMarker?.reportedExperimentCount ?? 0) +
        (durableAttemptDelivered ? 1 : 0)
      if (teardown.resultCommitSha && durableAttemptDelivered) {
        resultCommitSha = teardown.resultCommitSha
        terminalOutcome.resultCommitSha = teardown.resultCommitSha
      } else {
        resultCommitSha = undefined
        terminalOutcome.resultCommitSha = undefined
      }

      try {
        await removeWorkerWorktree({ root, sessionId, workerId })
        teardown.worktreeCleanup = "removed"
      } catch (cleanupError) {
        teardown.worktreeCleanup = "failed"
        teardown.phase = "failed"
        teardown.reasonCode = "cleanup_failure"
        teardown.error = appendBoundedTeardownError(
          teardown.error,
          cleanupError
        )
        terminalPhase = "failed"
        terminalOutcome.status = "failed"
        terminalOutcome.error = appendBoundedTeardownError(
          terminalOutcome.error ?? null,
          cleanupError
        )
      }
      if (teardown.attemptDelivery === "failed") {
        terminalPhase = "failed"
        teardown.phase = "failed"
        terminalOutcome.status = "failed"
        terminalOutcome.error = appendBoundedTeardownError(
          terminalOutcome.error ?? null,
          teardown.error ?? "Terminal attempt delivery failed"
        )
      }

      let runtimeCleanup: "removed" | "failed" = "removed"
      if (runtimePaths) {
        try {
          await rm(runtimePaths.dir, { recursive: true, force: true })
        } catch (runtimeCleanupError) {
          runtimeCleanup = "failed"
          teardown.worktreeCleanup = "failed"
          teardown.phase = "failed"
          teardown.reasonCode = "cleanup_failure"
          teardown.error = appendBoundedTeardownError(
            teardown.error,
            runtimeCleanupError
          )
          terminalOutcome.status = "failed"
          terminalOutcome.error = appendBoundedTeardownError(
            terminalOutcome.error ?? null,
            runtimeCleanupError
          )
        }
      }

      const durableReason = classifyDurableWorkerTerminalReason({
        stoppedByHarness,
        stopReasonCodes: harnessStopReasonCodes,
        cleanupFailed: teardown.worktreeCleanup === "failed",
        attemptDeliveryFailed: teardown.attemptDelivery === "failed",
        reportedExperimentCount,
        explicitFinishReason: explicitFinishMarker?.reason ?? null,
        timedOut: providerTimedOut,
        protocolViolation: teardown.reasonCode === "worker_protocol_violation",
        processFailed: terminalOutcome.status === "failed",
        providerFailureClass,
        error: terminalOutcome.error ?? providerError,
      })
      if (
        durableReason === "completed_with_experiments" ||
        durableReason === "hypothesis_exhausted" ||
        durableReason === "goal_satisfied" ||
        durableReason === "no_viable_change"
      ) {
        terminalOutcome.status = "completed"
        terminalOutcome.error = undefined
      } else if (
        durableReason === "session_stopped" ||
        durableReason === "session_cutoff" ||
        durableReason === "assignment_canceled"
      ) {
        terminalOutcome.status = "stopped"
      } else {
        terminalOutcome.status = "failed"
        if (durableReason === "worker_no_progress") {
          terminalOutcome.error =
            terminalOutcome.error ??
            "Provider exited successfully without a delivered experiment or an explicit finish marker."
        }
      }
      terminalOutcome.terminalReason = durableReason
      terminalOutcome.siteFatal = durableWorkerReasonIsSiteFatal(durableReason)
      terminalOutcome.providerFailureClass = providerFailureClass

      if (launchManifest) {
        launchManifest = {
          ...launchManifest,
          completedAt: new Date().toISOString(),
          status: terminalOutcome.status,
          exitCode: providerExitCode,
          signal: providerSignal,
          timedOut: providerTimedOut,
          startupTimedOut: providerStartupTimedOut,
          error: terminalOutcome.error ?? providerError,
          teardown,
        }
        await persistLaunchManifest(launchManifest).catch(() => {})
        await appendWorkerActivityEvent(launchManifest, {
          type: "teardown_result",
          phase: terminalPhase,
          summary: teardownStatusLabel(teardown.attemptDelivery),
          metadata: { ...teardown },
        }).catch(() => {})
        if (terminalOutcome.status === "stopped") {
          await appendWorkerActivityEvent(launchManifest, {
            type: "stop",
            phase: "stopped",
            summary: "Worker stopped after session stop request",
          }).catch(() => {})
        }
      }

      const terminalEvent =
        terminalOutcome.status === "stopped"
          ? "stop_requested"
          : terminalOutcome.status === "completed"
            ? "hypothesis_completed"
            : "worker_failed"
      const terminalProgress =
        terminalOutcome.status === "stopped"
          ? `${hypothesis.name} stopped after session stop request`
          : terminalOutcome.status === "completed"
            ? `${hypothesis.name} completed`
            : (terminalOutcome.error ?? `${hypothesis.name} failed`).slice(
                0,
                1000
              )
      const terminalMetadata = {
        ...(launchManifest
          ? {
              workerLogPath: launchManifest.logPath,
              workerActivityLogPath: launchManifest.activityLogPath,
              workerPromptPath: launchManifest.promptPath,
              lastOutputAt: launchManifest.lastOutputAt,
              launcher: launchManifest.agentKind,
            }
          : {}),
        terminal: teardown,
        terminalOutcome: {
          reason: durableReason,
          providerExitCode,
          providerSignal,
          timedOut: providerTimedOut,
          reportedExperimentCount,
          teardownDelivery: durableAttemptDelivered
            ? "delivered"
            : teardown.attemptDelivery === "none"
              ? "none"
              : "failed",
          resultRefPush:
            teardown.resultRefPushStatus === "pushed"
              ? "pushed"
              : teardown.resultRefPushStatus === "failed"
                ? "failed"
                : "none",
          cleanup:
            teardown.worktreeCleanup === "removed" &&
            runtimeCleanup === "removed"
              ? "complete"
              : "failed",
          errorSummary: terminalOutcome.error
            ? compactProviderErrorSummary(terminalOutcome.error).slice(0, 2000)
            : null,
          completedAt: new Date().toISOString(),
        },
      }
      const terminalHeartbeat = {
        workerId,
        status: terminalOutcome.status,
        phase: terminalOutcome.status,
        event: terminalEvent,
        progressMessage: terminalProgress,
        gitLabel: terminalOutcome.resultCommitSha ?? null,
        metadata: terminalMetadata,
      } satisfies LifecycleHeartbeat
      await (
        lifecycleHeartbeats
          ? lifecycleHeartbeats.enqueue(terminalHeartbeat)
          : heartbeatWorker(
              workerId,
              {
                workerCredential,
                status: terminalOutcome.status,
                sessionId,
                hypothesisId: hypothesis.id,
                phase: terminalOutcome.status,
                event: terminalEvent,
                progressMessage: terminalProgress,
                gitLabel: terminalOutcome.resultCommitSha ?? null,
                metadata: terminalMetadata,
              },
              args
            )
      ).catch((error) => {
        console.warn(errorMessage(error))
      })
    }
  }

  return (
    outcome ?? {
      hypothesis,
      workerId,
      resultCommitSha,
      status: "failed",
      error: providerError ?? "Worker did not produce a terminal outcome",
      startupTimedOut: providerStartupTimedOut,
    }
  )
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
  const workerContext = await getWorkerRuntimeContextCached().catch(() => null)
  let sessionId = args.options.session ?? workerContext?.sessionId
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
    args.options.hypothesis ?? workerContext?.hypothesisId ?? undefined
  const brief = workerContext
    ? await getWorkerResearchBrief(args)
    : await getResearchSessionBrief(sessionId, args, { hypothesisId })

  if (args.options.json === "true") {
    console.log(JSON.stringify(brief, null, 2))
    return
  }
  console.log(renderSessionBrief(brief))
}

function supervisorTelemetryForStatus(
  supervisor: SupervisorRuntimeTelemetry | undefined
) {
  if (!supervisor) return null
  if (supervisor.status && supervisor.status !== "running") return supervisor
  return freshSupervisorTelemetry(supervisor)
}

export function uniqueWorkerWarnings(manifest: WorkerLaunchManifest) {
  const warnings = [
    ...new Set([
      ...(manifest.warnings ?? []),
      ...(manifest.teardown?.warnings ?? []),
    ]),
  ]
  const expectedHarnessStop =
    (manifest.status === "stopped" ||
      manifest.teardown?.reasonCode === "stopped" ||
      manifest.teardown?.phase === "stopped") &&
    (manifest.signal === "SIGTERM" ||
      manifest.signal === "SIGKILL" ||
      manifest.teardown?.providerSignal === "SIGTERM" ||
      manifest.teardown?.providerSignal === "SIGKILL")
  return expectedHarnessStop
    ? warnings.filter(
        (warning) => !warning.startsWith("provider stream/API error detected:")
      )
    : warnings
}

async function commandResearchStatusSummary({
  root,
  args,
}: {
  root: string
  args: Args
}) {
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const campaignName = args.options.campaign ?? state.activeCampaign
  if (!campaignName) {
    throw new Error("No active campaign. Pass --campaign <name>.")
  }
  const cachedCampaign =
    state.campaigns?.[campaignStateKey(projectPath, campaignName)] ?? null
  let campaignId = cachedCampaign?.campaignId ?? null
  let sessionId = cachedCampaign?.sessionId ?? null
  let fallbackCampaign: ApiCampaign | null = null
  if (!sessionId && campaignId) {
    sessionId =
      Object.entries(state.sessions ?? {}).find(
        ([, session]) =>
          session.campaignId === campaignId &&
          ["running", "stop_requested"].includes(session.status ?? "")
      )?.[0] ?? null
  }
  if (!campaignId || !sessionId) {
    const campaignInfo = await campaignForName(root, args)
    fallbackCampaign = campaignInfo.campaign
    campaignId = campaignInfo.campaign.id
    sessionId =
      sessionId ??
      campaignInfo.overview.sessions.find((session) =>
        ["running", "stop_requested"].includes(session.status)
      )?.id ??
      null
  }

  const runtime = sessionId ? state.sessions?.[sessionId] : null
  const [control, manifests] = sessionId
    ? await Promise.all([
        getResearchSessionControlState(sessionId, args).catch(() => null),
        readWorkerLaunchManifests(root, sessionId).catch(() => []),
      ])
    : [null, []]
  const supervisor = supervisorTelemetryForStatus(runtime?.supervisor)
  const failures = manifests
    .filter((manifest) => manifest.status === "failed")
    .slice(-10)
    .map((manifest) => ({
      workerId: manifest.workerId,
      workerName: manifest.workerName,
      reasonCode: manifest.teardown?.reasonCode ?? null,
      errorSummary: manifest.error
        ? compactProviderErrorSummary(manifest.error)
        : manifest.teardown?.providerError
          ? compactProviderErrorSummary(manifest.teardown.providerError)
          : null,
      logPath: manifest.logPath,
    }))
  const teardownFailureCount = manifests.filter(
    (manifest) =>
      manifest.teardown?.attemptDelivery === "failed" ||
      manifest.teardown?.worktreeCleanup === "failed" ||
      (!manifest.teardown && manifestIsTerminal(manifest))
  ).length
  const warningCount = manifests.reduce(
    (total, manifest) => total + uniqueWorkerWarnings(manifest).length,
    0
  )
  const activeProcesses = supervisor?.activeProcessCount ?? 0
  const summary = {
    campaign: {
      id: campaignId,
      name: fallbackCampaign?.name ?? campaignName,
      status: control?.campaignStatus ?? fallbackCampaign?.status ?? null,
    },
    session: sessionId
      ? {
          id: sessionId,
          status: control?.status ?? runtime?.status ?? null,
          runtimeState: control?.runtimeState ?? null,
          outcome: control?.outcome ?? null,
          cleanup: control?.cleanup ?? null,
          workerTarget: control?.launch.workerTarget ?? null,
          activeWorkers: control?.launch.activeWorkerCount ?? activeProcesses,
          openSlots: control?.launch.openWorkerSlotCount ?? null,
          activeProcessCount: activeProcesses,
          progress: control?.progress ?? null,
          supervisor: supervisor
            ? {
                pid: supervisor.pid ?? null,
                logPath: supervisor.logPath ?? null,
                updatedAt: supervisor.updatedAt ?? null,
              }
            : null,
        }
      : null,
    providerBackoff:
      supervisor?.providerBackoff ?? runtime?.providerBackoff ?? null,
    recentFailedLaunches:
      supervisor?.recentFailedLaunches ??
      runtime?.providerBackoff?.recentFailures ??
      [],
    noProgressBreaker: supervisor?.noProgressBreaker ?? null,
    failures,
    localTeardownFailures: { count: teardownFailureCount },
    workerWarnings: { count: warningCount },
  }

  if (args.options.json === "true") {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  console.log(`campaign: ${summary.campaign.name}`)
  if (!summary.session) {
    console.log("session: none")
    return
  }
  console.log(
    `session: ${summary.session.id} ${summary.session.status ?? ""}`.trim()
  )
  const progress = summary.session.progress
  if (progress) {
    console.log(
      `experiments: accepted=${progress.acceptedExperimentCount}${
        progress.experimentTarget === null
          ? ""
          : `/${progress.experimentTarget}`
      } remaining=${progress.remainingExperimentCount ?? "-"}`
    )
  }
  console.log(
    `workers: active=${summary.session.activeWorkers}/${summary.session.workerTarget ?? "?"} processes=${summary.session.activeProcessCount}`
  )
  if (summary.providerBackoff) {
    console.log(`provider backoff: ${JSON.stringify(summary.providerBackoff)}`)
  }
  if (summary.failures.length > 0) {
    console.log(`worker failures: ${summary.failures.length}`)
  }
  if (summary.localTeardownFailures.count > 0) {
    console.log(
      `local teardown failures: ${summary.localTeardownFailures.count}`
    )
  }
}

export async function commandResearchStatus(args: Args) {
  const root = await repoRoot(args.options.cwd)
  if (args.options.summary === "true") {
    await commandResearchStatusSummary({ root, args })
    return
  }
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
  const remoteSessionsById = new Map(
    freshOverview.sessions.map((session) => [session.id, session])
  )
  const locallyOwnedOpenSessions = Object.entries(state.sessions ?? {})
    .filter(
      ([, session]) =>
        session.campaignId === campaign.id &&
        (session.status === "running" ||
          session.status === "stop_requested" ||
          session.stopPendingRemote === true)
    )
    .map(([id, session]) => {
      const remote = remoteSessionsById.get(id)
      return {
        id,
        campaignName: session.campaignName,
        campaignId: session.campaignId,
        status: remote?.status ?? session.status,
        experimentTarget: remote?.experimentTarget ?? session.experimentTarget,
        acceptedExperimentCount: remote?.acceptedExperimentCount ?? null,
        remainingExperimentCount: remote?.remainingExperimentCount ?? null,
        deadlineAt: remote?.deadlineAt ?? session.deadlineAt,
        schedulerSiteId: remote?.schedulerSiteId ?? session.schedulerSiteId,
        providerBackoff: session.providerBackoff ?? null,
        supervisor: session.supervisor ?? null,
      }
    })
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
  // Supabase/API is authoritative for durable workers, including terminal
  // outcomes that can arrive after the local runtime snapshot was written.
  const overview = freshOverview
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
            durableTeardownResultCommit(manifest?.teardown) ??
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
            worker.gitLabel ??
            durableTeardownResultCommit(manifest?.teardown) ??
            null,
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
  const supervisorTelemetry = supervisorTelemetryForStatus(
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
  const localTeardownFailures = manifests
    .filter(
      (manifest) =>
        manifest.teardown?.attemptDelivery === "failed" ||
        manifest.teardown?.worktreeCleanup === "failed" ||
        (!manifest.teardown &&
          ["completed", "failed", "stopped"].includes(manifest.status))
    )
    .slice(0, 25)
    .map((manifest) => ({
      workerId: manifest.workerId,
      workerName: manifest.workerName,
      status: manifest.status,
      teardown: manifest.teardown,
      logPath: manifest.logPath,
      manifestPath: manifest.manifestPath,
    }))
  const workerWarnings = manifests
    .map((manifest) => ({ manifest, warnings: uniqueWorkerWarnings(manifest) }))
    .filter(({ warnings }) => warnings.length > 0)
    .map(({ manifest, warnings }) => ({
      workerId: manifest.workerId,
      workerName: manifest.workerName,
      warnings: warnings.slice(0, 10),
      warningCount: warnings.length,
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
          noProgressBreaker: supervisorTelemetry?.noProgressBreaker ?? null,
          failures: failureSummary,
          sites: live?.sites ?? [],
          cleanupSite: live?.sites?.[0] ?? null,
          localTeardownFailures: {
            count: localTeardownFailures.length,
            workers: localTeardownFailures,
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
  if (live?.sites?.[0]?.runtimeStatus) {
    console.log(`cleanup: ${live.sites[0].runtimeStatus}`)
  }
  if (localTeardownFailures.length > 0) {
    console.log(`local teardown failures: ${localTeardownFailures.length}`)
    for (const failure of localTeardownFailures.slice(0, 5)) {
      console.log(
        `  ${failure.workerName}: reason=${failure.teardown?.reasonCode ?? "missing_teardown"} delivery=${failure.teardown?.attemptDelivery ?? "unknown"} cleanup=${failure.teardown?.worktreeCleanup ?? "unknown"}${failure.teardown?.error ? ` error="${compactProviderErrorSummary(failure.teardown.error).slice(0, 160)}"` : ""}`
      )
    }
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
  if (supervisorTelemetry?.noProgressBreaker?.tripped) {
    console.log(
      `no-progress breaker: tripped ${supervisorTelemetry.noProgressBreaker.count}/${supervisorTelemetry.noProgressBreaker.threshold}`
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
    const warningCount = manifest ? uniqueWorkerWarnings(manifest).length : 0
    console.log(
      [
        `  ${worker.workerName}: ${worker.status}`,
        worker.liveness ? `live=${worker.liveness}` : null,
        worker.phase ? `phase=${worker.phase}` : null,
        `seen=${lastSeen}`,
        `lastOutput=${lastOutput}`,
        manifest?.timedOut ? "timeout=true" : null,
        manifest?.teardown ? `reason=${manifest.teardown.reasonCode}` : null,
        manifest?.teardown
          ? `delivery=${manifest.teardown.attemptDelivery}`
          : null,
        manifest?.teardown?.resultRefPushStatus === "failed"
          ? "refPush=failed"
          : null,
        manifest?.teardown
          ? `cleanup=${manifest.teardown.worktreeCleanup}`
          : null,
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
        "Review experiment history, shared knowledge, and the current best metric before choosing edits.",
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
  if (args.options.compact !== undefined) {
    throw new Error(
      "`--compact` was removed; session-state-brief now returns the single bounded worker context."
    )
  }
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

export async function commandKnowledgeAdd(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const workerContext = await getWorkerRuntimeContextCached()
  const campaign = workerContext
    ? { id: workerContext.campaignId, name: workerContext.campaignName }
    : (await campaignForName(root, args)).campaign
  const kind = (args.options.kind ?? "insight") as
    | "insight"
    | "dead_end"
    | "promising_direction"
    | "risk"
    | "transfer_note"
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
  const knowledgeBody = {
    sessionId: args.options.session ?? workerContext?.sessionId,
    hypothesisId: args.options.hypothesis ?? workerContext?.hypothesisId,
    authoredByWorkerId:
      args.options.worker ?? workerContext?.workerId ?? undefined,
    kind,
    title,
    body,
    confidence:
      args.options.confidence === undefined
        ? undefined
        : Number(args.options.confidence),
  }
  const item = workerContext
    ? await createWorkerKnowledge(knowledgeBody, args)
    : await createCampaignKnowledge(campaign.id, knowledgeBody, args)
  if (args.options.json === "true") {
    console.log(JSON.stringify(item, null, 2))
    return
  }
  console.log(`Added ${item.kind} knowledge for ${campaign.name}`)
}

export async function commandKnowledgeList(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const workerContext = await getWorkerRuntimeContextCached()
  const campaign = workerContext
    ? { id: workerContext.campaignId, name: workerContext.campaignName }
    : (await campaignForName(root, args)).campaign
  const limit = positiveIntegerOption(args, "limit", 50)
  if (args.options.offline === "true") {
    throw new Error(
      "`--offline` was removed. Knowledge is read directly from the Onyx API."
    )
  }
  const knowledge = (
    workerContext
      ? await listWorkerKnowledge(args)
      : await listCampaignKnowledge(campaign.id, args)
  ).slice(0, limit)

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

export function sessionCommitVisibilityGuidance(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const payload = error.payload
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return null
  }
  const envelope = payload as {
    error?: { details?: Record<string, unknown> }
  }
  const details = envelope.error?.details
  if (!details) return null
  const reason = details?.reason
  if (
    reason !== "base_commit_not_visible" &&
    reason !== "assignment_commit_not_visible"
  ) {
    return null
  }
  const commitSha =
    typeof details.commitSha === "string" ? details.commitSha : "the commit"
  const hypothesis =
    typeof details.hypothesisId === "string"
      ? ` for hypothesis ${details.hypothesisId}`
      : ""
  return `Research cannot start because ${commitSha}${hypothesis} is not visible to GitHub. Push that exact commit to the repository remote, then rerun \`onyx research run\`. No research session was created.`
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

export async function resolveHypothesisBaseOverrides({
  campaignId,
  hypotheses,
  args,
  listExperiments = listCampaignExperiments,
}: {
  campaignId: string
  hypotheses: ApiHypothesis[]
  args: Args
  listExperiments?: typeof listCampaignExperiments
}) {
  const parsed: Array<{
    hypothesis: ApiHypothesis
    rawRef: string
    experimentId?: string
  }> = []
  const experimentIds = new Set<string>()
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
      if (!experimentId) {
        throw new Error(
          `Invalid --hypothesis-base ${JSON.stringify(value)}; experiment id is required.`
        )
      }
      experimentIds.add(experimentId)
      parsed.push({ hypothesis, rawRef, experimentId })
    } else {
      parsed.push({ hypothesis, rawRef })
    }
  }

  const experimentsById = new Map<string, ApiCampaignExperiment>()
  if (experimentIds.size > 0) {
    let cursor: string | undefined
    do {
      const page = await listExperiments(campaignId, args, {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      for (const experiment of page.items) {
        if (experimentIds.has(experiment.id)) {
          experimentsById.set(experiment.id, experiment)
        }
      }
      cursor = page.page.nextCursor ?? undefined
    } while (experimentsById.size < experimentIds.size && cursor)
  }

  for (const entry of parsed) {
    if (!entry.experimentId) {
      overrides.set(entry.hypothesis.id, { ref: entry.rawRef })
      continue
    }
    const experiment = experimentsById.get(entry.experimentId)
    if (!experiment) {
      throw new Error(
        `Experiment ${entry.experimentId} was not found in this campaign.`
      )
    }
    overrides.set(entry.hypothesis.id, {
      ref: experiment.resultCommitSha,
      sourceExperimentId: experiment.id,
    })
  }
  return overrides
}

function defaultPresenceIntervalSeconds(workerTarget: number) {
  if (workerTarget >= 100) return 15
  if (workerTarget >= 50) return 10
  return 5
}

export type ProviderBackoffReason =
  | "rate_limit"
  | "overloaded"
  | "provider_degraded"

export function providerBackoffReasonForResult(
  result: Pick<HypothesisRunResult, "status" | "error" | "startupTimedOut"> & {
    terminalReason?: string
  }
): ProviderBackoffReason | null {
  if (result.status !== "failed") return null
  if (result.terminalReason === "provider_rate_limited") return "rate_limit"
  if (result.terminalReason === "provider_overloaded") return "overloaded"
  if (result.terminalReason === "provider_unavailable") {
    return "provider_degraded"
  }
  const failureClass = classifyProviderFailure(result.error ?? "")
  return failureClass === "rate_limit"
    ? "rate_limit"
    : failureClass === "overloaded"
      ? "overloaded"
      : failureClass === "unavailable"
        ? "provider_degraded"
        : null
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
  const maxMs = 2 * 60_000
  const exponent = Math.max(0, Math.min(5, attempt - 1))
  const floorMs = Math.min(maxMs, Math.max(1, baseMs) * 2 ** exponent)
  const jitterMaxMs = Math.min(maxMs - floorMs, floorMs * 0.25)
  return Math.round(floorMs + jitterMaxMs * random())
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

async function discardOrphanWorkerWorkspace({
  root,
  sessionId,
  manifest,
  reason,
}: {
  root: string
  sessionId: string
  manifest: WorkerLaunchManifest
  reason: string
}) {
  const phase = manifest.status === "stopped" ? "stopped" : "failed"
  let teardown = emptyWorkerTeardown({
    phase,
    reasonCode:
      phase === "stopped"
        ? "stopped"
        : manifest.status === "starting"
          ? "startup_failure"
          : "provider_failure",
    providerExitCode: manifest.exitCode,
    providerSignal: manifest.signal,
    timedOut: manifest.timedOut,
    startupTimedOut: manifest.startupTimedOut,
    providerError: manifest.error ?? reason,
  })
  if (await pathExists(manifest.cwd)) {
    const diagnostics = await workspaceDiagnostics({
      worktree: manifest.cwd,
      startingCommitSha: manifest.startingCommitSha,
    }).catch(() => null)
    if (diagnostics) teardown = { ...teardown, ...diagnostics }
  }
  const attempts = await listLocalAttempts(root, {
    sessionId,
    workerId: manifest.workerId,
    hypothesisId: manifest.hypothesisId,
  }).catch(() => [])
  if (attempts.length > 0) {
    teardown.warnings = [
      boundedText(
        `Orphan cleanup discarded ${attempts.length} terminal attempt manifest(s) without delivery.`,
        500
      ),
    ]
    if (attempts.length > 1) {
      teardown.attemptDelivery = "ambiguous_discarded"
      teardown.reasonCode = "worker_protocol_violation"
    }
    await Promise.all(
      attempts.map((attempt) =>
        clearLocalAttempt(root, { runRef: attempt.runRef }).catch(() => {})
      )
    )
  }
  try {
    await removeWorkerWorktree({
      root,
      sessionId,
      workerId: manifest.workerId,
    })
    teardown.worktreeCleanup = "removed"
  } catch (error) {
    teardown.worktreeCleanup = "failed"
    teardown.phase = "failed"
    teardown.reasonCode = "cleanup_failure"
    teardown.error = appendBoundedTeardownError(teardown.error, error)
  }
  await writeWorkerLaunchManifest({
    ...manifest,
    completedAt: manifest.completedAt ?? new Date().toISOString(),
    status: teardown.worktreeCleanup === "failed" ? "failed" : phase,
    error: boundedText(manifest.error ?? reason, 1000),
    teardown,
  }).catch(() => {})
  return teardown.worktreeCleanup === "removed"
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
    let identity = manifest.pid ? inspectProcessIdentity(manifest.pid) : null
    let matchingLiveProcess = Boolean(
      identity &&
      manifest.processStartedAt &&
      manifest.commandIdentity &&
      identity.startedAt === manifest.processStartedAt &&
      identity.command === manifest.commandIdentity
    )
    if (!matchingLiveProcess) {
      await discardOrphanWorkerWorkspace({
        root,
        sessionId,
        manifest,
        reason: "No matching provider process remained during orphan cleanup",
      })
    }
    if (
      manifestIsTerminal(manifest) ||
      manifest.supervisorRunId !== supervisorRunId ||
      !manifest.pid ||
      !manifest.processStartedAt ||
      !manifest.commandIdentity
    ) {
      continue
    }
    if (!matchingLiveProcess) {
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250)
      identity = inspectProcessIdentity(manifest.pid)
      matchingLiveProcess = Boolean(
        identity &&
        identity.startedAt === manifest.processStartedAt &&
        identity.command === manifest.commandIdentity
      )
      if (!matchingLiveProcess) break
    }
    if (!matchingLiveProcess) {
      await discardOrphanWorkerWorkspace({
        root,
        sessionId,
        manifest: {
          ...manifest,
          status: "stopped",
          completedAt: new Date().toISOString(),
          signal: "SIGTERM",
          error:
            "Identity-verified orphan process stopped after supervisor failure",
        },
        reason:
          "Identity-verified orphan process stopped after supervisor failure",
      })
    } else {
      console.warn(
        `Worker ${manifest.workerId} remained live after orphan stop grace; its worktree was retained.`
      )
    }
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
  return `onyx research status --campaign ${campaignName} --summary --json`
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
  supervisorRunId,
}: {
  root: string
  args: Args
  sessionId: string
  campaign: ApiCampaign
  launchRate: { batchSize: number | null; intervalSeconds: number | null }
  supervisorRunId: string
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

async function commandResearchRunImplementation(
  args: Args,
  markSessionCreated: () => void
) {
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

  const schedulerSiteId = await getResearchSiteId(root)
  const supervisorRunId =
    process.env.ONYX_SUPERVISOR_RUN_ID ?? `local-${randomUUID()}`
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
  const workerProtocolPreflight = internalSession
    ? { skipped: true, reason: "detached supervisor child" }
    : await preflightWorkerProtocol({ root })
  const providerInvocation = buildWorkerInvocation({
    agentKind,
    workerCommand: args.options["worker-command"],
    worktree: root,
    prompt: "Onyx provider preflight",
    workerModel,
    providerExecutable: args.options["provider-executable"],
  })
  const providerExecutable = args.options["worker-command"]
    ? undefined
    : (args.options["provider-executable"] ??
      (await resolveProviderExecutable(
        providerInvocation.command,
        process.env
      )))
  if (providerExecutable) {
    providerInvocation.command = providerExecutable
    resolvedWorkerArgs.options["provider-executable"] = providerExecutable
  }
  const providerPreflight = internalSession
    ? { skipped: true, version: null, marker: null }
    : await preflightProviderModel({
        invocation: providerInvocation,
        cwd: root,
        env: providerRuntimeEnvironment(process.env),
      })
  let result: {
    session: ApiSession
    hypotheses: ApiHypothesis[]
  }
  if (internalSession) {
    result = {
      session: internalSession.session,
      hypotheses: internalSession.hypotheses,
    }
  } else {
    try {
      result = await createCampaignSession(
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
          supervisorRunId,
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
            preflight: {
              workerProtocol: workerProtocolPreflight,
              provider: providerPreflight,
              providerExecutable: providerExecutable ?? null,
            },
          },
        },
        args
      )
    } catch (error) {
      const guidance = sessionCommitVisibilityGuidance(error)
      if (guidance) throw new Error(guidance)
      throw error
    }
  }
  markSessionCreated()
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
      supervisorRunId,
    })
    return
  }

  const workerCredentialsByWorkerId = new Map<string, string>()
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
      cleanupStatus: "failed",
      terminalReason: "failed",
      reason,
      metadata: {
        terminalReason: "failed",
        cleanupReasons: [reason],
      },
    }).catch(() => {})
    throw new Error(reason)
  }
  const sessionStateBriefRefresher = createSessionStateBriefRefresher({
    root,
    sessionId,
    args,
  })
  await sessionStateBriefRefresher.writePlaceholder().catch(() => {})
  await sessionStateBriefRefresher.refresh({ force: true }).catch(() => {})
  const lifecycleHeartbeats = createLifecycleHeartbeatPublisher({
    args,
    sessionId,
    siteId: schedulerSiteId,
    supervisorRunId,
  })
  const presenceSupervisor = createPresenceSupervisor({
    root,
    args,
    sessionId,
    supervisorRunId,
    intervalMs: presenceIntervalMs,
    maxConcurrency,
    workerCredentialsByWorkerId,
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
  let deterministicSiteFailure: ProviderLaunchFailure | null = null
  const noProgressThreshold = Math.max(3, Math.min(workerTarget, 20))
  // Monotonic cache of the authoritative server cursor, used only between
  // control polls. This is not a locally produced progress counter.
  let observedAcceptedExperimentCount = 0
  let noProgressWorkerExitCount = 0
  let recentNoProgressExits: NoProgressWorkerExit[] = []
  let noProgressBreakerTripped = false
  let terminalReason: SessionTerminalReason | null = null
  let lastStopCheck: ResearchStopCheck | null = null
  let drainingPresenceSent = false
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
  let controlSnapshotSequence = 0
  let briefRefreshControlSignature: string | null = null
  const sessionStopChecker = createResearchSessionStopChecker({
    root,
    sessionId,
    args,
    settleBeforeCheck: true,
    onRemoteControlState: async (control) => {
      controlSnapshotSequence += 1
      await writeSupervisorControlStateSnapshot({
        root,
        sessionId,
        snapshot: {
          schemaVersion: 1,
          sequence: controlSnapshotSequence,
          fetchedAt: new Date().toISOString(),
          control,
        },
      })
      await sessionStateBriefRefresher.patchControlState(control)
      const nextBriefRefreshControlSignature =
        sessionStateBriefControlSignature(control)
      const contextChanged =
        briefRefreshControlSignature !== null &&
        briefRefreshControlSignature !== nextBriefRefreshControlSignature
      briefRefreshControlSignature = nextBriefRefreshControlSignature
      if (contextChanged) {
        await sessionStateBriefRefresher.refresh({ force: true })
      }
    },
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
      noProgressBreaker?: NonNullable<
        NonNullable<CliState["sessions"]>[string]["supervisor"]
      >["noProgressBreaker"]
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
        noProgressBreaker:
          options.noProgressBreaker === undefined
            ? {
                tripped: noProgressBreakerTripped,
                threshold: noProgressThreshold,
                count: noProgressWorkerExitCount,
                recentFailures: recentNoProgressExits,
              }
            : options.noProgressBreaker,
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

  try {
    while (Date.now() < hardEndTimeMs) {
      const loopNow = Date.now()
      void sessionStateBriefRefresher.refresh().catch(() => {})
      await persistRuntimeTelemetry({ activeProcessCount: activeRuns.size })
      if (noProgressBreakerTripped && activeRuns.size === 0) break
      if (noProgressBreakerTripped) {
        await Promise.race([...activeRuns.values(), sleep(2000)])
        continue
      }
      if (deterministicSiteFailure && activeRuns.size === 0) break
      if (deterministicSiteFailure) {
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
        await presenceSupervisor
          .flush({ runtimeStatus: "draining" })
          .catch(() => {})
        drainingPresenceSent = true
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
      const observedAccepted =
        controlState?.progress.acceptedExperimentCount ??
        observedAcceptedExperimentCount
      if (observedAccepted > observedAcceptedExperimentCount) {
        observedAcceptedExperimentCount = observedAccepted
        noProgressWorkerExitCount = 0
        recentNoProgressExits = []
      }
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
              leaseCredential: createWorkerCredential(),
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

        const grants: ApiWorkerLease[] =
          leaseBatch?.grants.map((grant) => ({
            ...grant,
            ...leaseBatch.context,
          })) ?? []
        for (const grant of grants) {
          workerCredentialsByWorkerId.set(
            grant.worker.id,
            grant.workerCredential
          )
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
          if (existingLocal) {
            await cacheResearchSessionState({
              root,
              campaign,
              session: existingLocal.session,
              hypotheses: [...hypothesesById.values()],
              workers: [...workersById.values()],
            }).catch(() => {})
          }
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
          const acceptedAtLaunch = observedAcceptedExperimentCount
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
            preacquiredLease: grant,
            slotIndex,
            onRegistered: ({ workerId, workerCredential }) => {
              workerCredentialsByWorkerId.set(workerId, workerCredential)
            },
            lifecycleHeartbeats,
            providerExecutable,
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
              if (result.siteFatal && result.terminalReason) {
                deterministicSiteFailure = {
                  at: new Date().toISOString(),
                  reason: result.terminalReason,
                  workerId: result.workerId ?? null,
                  hypothesisId: result.hypothesis.id,
                  errorSummary: result.error
                    ? compactProviderErrorSummary(result.error)
                    : null,
                }
                terminalReason = "failed"
                await persistRuntimeTelemetry({
                  force: true,
                  activeProcessCount: activeRuns.size,
                  providerBackoff: null,
                })
                await stopCampaignSession(
                  sessionId,
                  {
                    campaignId: campaign.id,
                    endReason: "failed",
                    reason: `Deterministic worker failure: ${result.terminalReason}`,
                    metadata: {
                      reasonCode: "deterministic_worker_failure",
                      failure: deterministicSiteFailure,
                    },
                  },
                  args
                ).catch(() => null)
                return result
              }
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
                providerBackoffAttempt += 1
                const delayMs = providerBackoffDelayMs({
                  baseMs: providerBackoffMs,
                  attempt: providerBackoffAttempt,
                })
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
              if (!backoffReason && result.status !== "stopped") {
                const latestControl = await getResearchSessionControlState(
                  sessionId,
                  args
                ).catch(() => null)
                const latestAccepted =
                  latestControl?.progress.acceptedExperimentCount ??
                  observedAcceptedExperimentCount
                if (latestAccepted > observedAcceptedExperimentCount) {
                  observedAcceptedExperimentCount = latestAccepted
                  noProgressWorkerExitCount = 0
                  recentNoProgressExits = []
                }
                if (latestAccepted <= acceptedAtLaunch) {
                  noProgressWorkerExitCount += 1
                  recentNoProgressExits = [
                    ...recentNoProgressExits,
                    {
                      at: new Date().toISOString(),
                      workerId: result.workerId ?? null,
                      hypothesisId: result.hypothesis.id,
                      status: result.status,
                      errorSummary: result.error
                        ? compactProviderErrorSummary(result.error)
                        : null,
                    },
                  ].slice(-20)
                }
                if (
                  noProgressWorkerExitCount >= noProgressThreshold &&
                  !noProgressBreakerTripped
                ) {
                  noProgressBreakerTripped = true
                  terminalReason = "failed"
                  const breakerMetadata = {
                    reasonCode: "worker_no_progress_breaker",
                    threshold: noProgressThreshold,
                    count: noProgressWorkerExitCount,
                    recentFailures: recentNoProgressExits,
                  }
                  await persistRuntimeTelemetry({ force: true })
                  await stopCampaignSession(
                    sessionId,
                    {
                      campaignId: campaign.id,
                      endReason: "failed",
                      reason: `No accepted experiment progress across ${noProgressWorkerExitCount} worker exits`,
                      metadata: breakerMetadata,
                    },
                    args
                  ).catch(() => null)
                }
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
              workerCredentialsByWorkerId.delete(grant.worker.id)
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
          await Promise.race([
            ...activeRuns.values(),
            sleep(2000 + Math.floor(Math.random() * 500)),
          ])
        } else {
          await sleep(3000 + Math.floor(Math.random() * 750))
        }
      }
    }

    if (!drainingPresenceSent) {
      await presenceSupervisor
        .flush({ runtimeStatus: "draining" })
        .catch(() => {})
      drainingPresenceSent = true
    }
    if (activeRuns.size > 0) {
      console.log(`Waiting for ${activeRuns.size} active worker(s) to finish.`)
      await Promise.allSettled(activeRuns.values())
    }
  } finally {
    presenceSupervisor.request()
    await presenceSupervisor.stop({ runtimeStatus: "draining" })
  }

  const finalState = await readState(root)
  const explicitStop = sessionStopRequested({ state: finalState, sessionId })
  const postLoopLocal = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
  const finalDeterministicSiteFailure =
    deterministicSiteFailure as ProviderLaunchFailure | null
  terminalReason =
    (explicitStop ? "user_stopped" : terminalReason) ??
    (lastStopCheck ? terminalReasonForStopCheck(lastStopCheck) : null) ??
    postLoopLocal?.session.terminalReason ??
    (Number.isFinite(endTimeMs) && Date.now() >= endTimeMs
      ? "deadline_reached"
      : null) ??
    "all_hypotheses_closed"
  let finalStatus: ApiSession["status"] =
    finalDeterministicSiteFailure || noProgressBreakerTripped
      ? "failed"
      : explicitStop
        ? "stopped"
        : "completed"
  const initialTerminalMetadata = {
    terminalReason,
    deterministicSiteFailure: finalDeterministicSiteFailure,
    noProgressBreaker: {
      tripped: noProgressBreakerTripped,
      threshold: noProgressThreshold,
      count: noProgressWorkerExitCount,
      recentFailures: recentNoProgressExits,
    },
    cleanupReasons: [],
  }
  finalState.sessions = finalState.sessions ?? {}
  finalState.sessions[sessionId] = {
    ...(finalState.sessions[sessionId] ?? {}),
    campaignName: campaign.name,
    campaignId: campaign.id,
    status: finalStatus,
    cleanupStatus: "running",
    stopRequested: false,
    providerBackoff: null,
    terminalReason,
  }
  await writeState(root, finalState)
  await stopLocalSession({
    root,
    sessionId,
    status: finalStatus,
    cleanupStatus: "running",
    terminalReason,
    reason: explicitStop
      ? "stop requested"
      : finalDeterministicSiteFailure
        ? `deterministic worker failure: ${finalDeterministicSiteFailure.reason}`
        : "research run completed",
    metadata: initialTerminalMetadata,
  }).catch(() => {})
  await lifecycleHeartbeats.flush().catch((error) => {
    console.warn(errorMessage(error))
  })
  const cleanup = await computeSessionCleanupStatus({
    root,
    sessionId,
  })
  if (cleanup.reasons.length > 0) {
    console.warn(
      `cleanup ${cleanup.status}: ${cleanup.reasons.slice(0, 5).join("; ")}`
    )
  }
  if (cleanup.status === "failed") {
    finalStatus = "failed"
    terminalReason = "failed"
  }
  await writeRemoteSessionCleanup({
    sessionId,
    campaignId: campaign.id,
    status: finalStatus,
    cleanup,
    terminalReason,
    metadata: noProgressBreakerTripped
      ? {
          reasonCode: "worker_no_progress_breaker",
          threshold: noProgressThreshold,
          count: noProgressWorkerExitCount,
          recentFailures: recentNoProgressExits,
        }
      : undefined,
    args,
  })
  const finalSessionState = await readState(root)
  finalSessionState.sessions = finalSessionState.sessions ?? {}
  finalSessionState.sessions[sessionId] = {
    ...(finalSessionState.sessions[sessionId] ?? {}),
    campaignName: campaign.name,
    campaignId: campaign.id,
    status: finalStatus,
    cleanupStatus: cleanup.status,
    stopRequested: false,
    providerBackoff: null,
    terminalReason,
  }
  await writeState(root, finalSessionState)
  await stopLocalSession({
    root,
    sessionId,
    status: finalStatus,
    cleanupStatus: cleanup.status,
    terminalReason,
    reason:
      cleanup.reasons.length > 0
        ? cleanup.reasons.slice(0, 5).join("; ")
        : explicitStop
          ? "stop requested"
          : finalDeterministicSiteFailure
            ? `deterministic worker failure: ${finalDeterministicSiteFailure.reason}`
            : "research run completed",
    metadata: {
      terminalReason,
      deterministicSiteFailure: finalDeterministicSiteFailure,
      cleanupReasons: cleanup.reasons,
    },
  }).catch(() => {})
  const finalGitVerificationStartedAt = Date.now()
  const finalGitVerification = await verifyResearchCampaignGit(
    campaign.id,
    args,
    { gitVerifyLimit: 100 }
  ).catch(() => null)
  console.log(
    `Final Git verification: durationMs=${Date.now() - finalGitVerificationStartedAt} checked=${finalGitVerification?.checkedCount ?? 0} updated=${finalGitVerification?.updatedCount ?? 0} remaining=${finalGitVerification?.remainingCount ?? "unknown"}`
  )
  const reportedCleanupStatus = cleanup.status
  const completionLive = await getResearchSessionLive(sessionId, args).catch(
    () => null
  )
  const completionLocal = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
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
    presenceSupervisor.flush({
      terminal: true,
      runtimeStatus: cleanup.status === "complete" ? "complete" : "failed",
    }),
    sleep(5000),
  ]).catch(() => {})

  console.log(
    `Research run ${finalStatus}: launched=${launched} completed=${completed} failed=${failed} stopped=${stopped}; cleanup=${reportedCleanupStatus}.`
  )
  console.log(
    `Experiment counts: accepted=${acceptedExperiments}${completedExperimentTarget === null ? "" : `/${completedExperimentTarget}`}.`
  )
  const apiTimingSummary = renderApiTimingSummary(args)
  if (apiTimingSummary) console.error(apiTimingSummary)
}

export async function commandResearchRun(args: Args) {
  let sessionCreated = false
  try {
    return await commandResearchRunImplementation(args, () => {
      sessionCreated = true
    })
  } catch (error) {
    if (!sessionCreated) markResearchPreflightFailure(error)
    throw error
  }
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

  const requestedHypothesisId = args.options.hypothesis
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
  if (result.status === "failed") {
    throw new Error(
      `Worker failed for ${hypothesis.name}: ${result.error ?? "unknown error"}`
    )
  }
  console.log(
    `Worker ${result.status} ${hypothesis.name} at ${result.resultCommitSha ?? "no durable experiment commit"}.`
  )
}
