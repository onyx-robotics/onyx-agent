import { randomUUID } from "node:crypto"
import { closeSync, openSync } from "node:fs"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  researchHypothesisPlanSchema,
  type ResearchHypothesisPlan,
} from "../protocol"
import { optionValues, type Args } from "../lib/args"
import { commandExpLog, commandExpRun } from "./exp"
import {
  getCampaignOverview,
  getResearchSessionControlState,
  getResearchSessionLive,
  getResearchSessionState,
  listProjectCampaigns,
  reconcileCampaign,
  stopCampaignSession,
  syncResearchPresence,
  resolveProject,
  type ApiCampaign,
  type ApiHypothesis,
  type ApiResearchPresenceResponse,
  type ApiSession,
  type ApiSessionLive,
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
} from "../lib/outbox"
import { campaignStateKey, onyxPath, resolveProjectPath } from "../lib/project"
import {
  pathExists,
  runStreamingProcess,
  type ProcessResult,
  type StreamingProcessResult,
} from "../lib/process"
import {
  abandonBlockedWorkflowRunsForSession,
  assertLocalSessionSchedulerSite,
  cacheLocalCampaign,
  applyRemoteProjectionDeltas,
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
  localResearchBrief,
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
  activitySummaryForManifest,
  readWorkerLatestState,
  writeWorkerLatestState,
} from "../lib/worker-activity"
import {
  buildWorkerInvocation,
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
const DEFAULT_SYNC_QUEUE_CONCURRENCY = 4
const DEFAULT_SYNC_DRAIN_BATCHES_PER_INTERVAL = 4
const MAX_SYNC_QUEUE_DEPTH = 500
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
    // Offline/debug sessions can still use local ledger state.
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
  | "stop_requested"
  | "provider_capacity_exhausted"
  | "no_active_hypotheses"
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

type SyncQueueFlushJob = {
  kind: "flush"
  reason: string
  manifest?: WorkerLaunchManifest | null
}

type SyncQueuePushRefJob = {
  kind: "push-ref"
  reason: string
  cwd: string
  sourceRef: string
  targetRef: string
  manifest?: WorkerLaunchManifest | null
  resolve: (result: ProcessResult) => void
}

type SyncQueueJob = SyncQueueFlushJob | SyncQueuePushRefJob

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

function workerBudgetOptions({ maxMinutes }: { maxMinutes: number }) {
  return ` --max-minutes ${maxMinutes}`
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function validateWorkerModel(
  agentKind: BuiltInWorkerAgent,
  model: string | null
) {
  if (!model) return null
  if (agentKind === "opencode") {
    const slash = model.indexOf("/")
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error("--model for --agent opencode must use provider/model")
    }
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
}: {
  args: Args
  sessionMetadata?: Record<string, unknown> | null
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
    const requestedModel = normalizeWorkerModel(args.options.model)
    if (args.options.model !== undefined && requestedModel !== existingModel) {
      throw new Error(
        existingModel
          ? `Research session already uses --model ${existingModel}; create a new session to use ${requestedModel ?? "(default)"}.`
          : `Research session has no worker model; create a new session to use ${requestedModel ?? "(default)"}.`
      )
    }
    return {
      agentKind,
      workerModel: validateWorkerModel(agentKind, existingModel),
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
  const workerModel = validateWorkerModel(
    agentKind,
    normalizeWorkerModel(args.options.model) ??
      normalizeWorkerModel(process.env.ONYX_WORKER_MODEL) ??
      normalizeWorkerModel(profile?.worker?.models?.[agentKind]) ??
      null
  )
  return { agentKind, workerModel }
}

function workerOptions({ agentKind, workerModel }: WorkerSettings) {
  return ` --agent ${agentKind}${workerModel ? ` --model ${workerModel}` : ""}`
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
}: {
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
}) {
  const activeHypotheses = hypotheses.filter(
    (hypothesis) => hypothesis.status === "active"
  )
  if (activeHypotheses.length === 0) return null

  const activeWorkers = workers.filter(workerIsActive)
  const completedWorkers = workers.filter(workerIsCompleted)
  const activeCountFor = (hypothesisId: string) =>
    activeWorkers.filter((worker) => worker.hypothesisId === hypothesisId)
      .length
  const neverWorked = activeHypotheses.find((hypothesis) => {
    const relatedActive = activeWorkers.some(
      (worker) => worker.hypothesisId === hypothesis.id
    )
    const relatedCompleted = completedWorkers.some(
      (worker) => worker.hypothesisId === hypothesis.id
    )
    return !hypothesis.lastWorkedAt && !relatedActive && !relatedCompleted
  })
  if (neverWorked) return neverWorked

  return activeHypotheses.slice().sort((left, right) => {
    const leftActive = activeCountFor(left.id)
    const rightActive = activeCountFor(right.id)
    if (leftActive !== rightActive) return leftActive - rightActive
    const leftWorked = left.lastWorkedAt ? Date.parse(left.lastWorkedAt) : 0
    const rightWorked = right.lastWorkedAt ? Date.parse(right.lastWorkedAt) : 0
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
  const maxConcurrency = positiveIntegerOption(
    args,
    "sync-concurrency",
    DEFAULT_SYNC_QUEUE_CONCURRENCY
  )
  const maxBatchesPerFlush = positiveIntegerOption(
    args,
    "sync-drain-batches",
    DEFAULT_SYNC_DRAIN_BATCHES_PER_INTERVAL
  )
  const queue: SyncQueueJob[] = []
  const idleWaiters = new Set<() => void>()
  let active = 0
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null
  let lastPendingSyncCount = 0
  let lastOldestPendingAgeMs: number | null = null
  let lastSyncDurationMs: number | null = null
  let lastSyncError: string | null = null
  let lastSyncOffline = false
  let flushActive = false

  const depth = () => queue.length + active
  const syncTelemetry = () => ({
    pendingSyncCount: lastPendingSyncCount,
    oldestPendingAgeMs: lastOldestPendingAgeMs,
    lastDurationMs: lastSyncDurationMs,
    lastError: lastSyncError,
    offline: lastSyncOffline,
    queueDepth: depth(),
  })
  const notifyIdle = () => {
    if (depth() > 0) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }
  const emitJobEvent = async (
    job: SyncQueueJob,
    type: "push_result" | "sync_result",
    summary: string,
    metadata: Record<string, unknown>
  ) => {
    if (!job.manifest) return
    await appendWorkerActivityEvent(job.manifest, {
      type,
      phase: "syncing",
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
  const runFlushJob = async (job: SyncQueueFlushJob) => {
    flushActive = true
    await flushOutbox(root, args, {
      quiet: true,
      maxBatches: maxBatchesPerFlush,
    })
      .then(async (result) => {
        lastPendingSyncCount = result.pending
        lastOldestPendingAgeMs = result.oldestPendingAgeMs
        lastSyncDurationMs = result.lastDurationMs
        lastSyncError = result.lastError
        lastSyncOffline = result.offline
        await emitJobEvent(job, "push_result", "Experiment refs pushed", {
          flushed: result.flushed,
          pending: result.pending,
          offline: result.offline,
          conflicts: result.conflicts,
          skippedDeleted: result.skippedDeleted,
          batches: result.batches,
        })
        await emitJobEvent(job, "sync_result", "SQLite sync flushed", {
          flushed: result.flushed,
          pending: result.pending,
          offline: result.offline,
          conflicts: result.conflicts,
          skippedDeleted: result.skippedDeleted,
          batches: result.batches,
          lastDurationMs: result.lastDurationMs,
          oldestPendingAgeMs: result.oldestPendingAgeMs,
          lastError: result.lastError,
        })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        const lockContention =
          /Timed out waiting for local Onyx research-sync lock/i.test(message)
        if (!lockContention) lastSyncError = message
        void emitJobEvent(job, "sync_result", "SQLite sync failed", {
          error: message,
          lockContention,
        })
        if (!lockContention) console.warn(`Background sync skipped: ${message}`)
      })
      .finally(() => {
        flushActive = false
      })
  }
  const runPushRefJob = async (job: SyncQueuePushRefJob) => {
    try {
      const result = await gitResult(
        ["push", "origin", `${job.sourceRef}:${job.targetRef}`],
        job.cwd
      )
      job.resolve(result)
    } catch (error) {
      job.resolve(failedProcessResult(errorMessage(error)))
    }
  }
  const runJob = async (job: SyncQueueJob) => {
    await (
      job.kind === "push-ref" ? runPushRefJob(job) : runFlushJob(job)
    ).finally(() => {
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
  const enqueue = (job: SyncQueueJob, options: { force?: boolean } = {}) => {
    if (stopped && !options.force) return null
    if (
      job.kind === "flush" &&
      (flushActive || queue.some((item) => item.kind === "flush"))
    ) {
      return depth()
    }
    if (depth() >= MAX_SYNC_QUEUE_DEPTH) return null
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

  timer = setInterval(() => {
    if (!stopped && depth() === 0)
      enqueue({ kind: "flush", reason: "interval" })
  }, intervalMs)

  return {
    request(job: Partial<SyncQueueJob> = {}) {
      return (
        enqueue({
          kind: "flush",
          reason: job.reason ?? "requested",
          manifest: job.manifest,
        }) ?? depth()
      )
    },
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
          kind: "push-ref",
          reason,
          cwd,
          sourceRef,
          targetRef,
          manifest,
          resolve,
        })
        if (accepted === null) {
          resolve(failedProcessResult("sync queue rejected push job"))
        }
      })
    },
    depth,
    telemetry: syncTelemetry,
    waitForIdle,
    async drain(timeoutMs: number) {
      stopped = true
      if (timer) clearInterval(timer)
      if (args.options.offline === "true") {
        await waitForIdle(timeoutMs)
        const pending = await pendingResearchSyncCount(root)
        lastPendingSyncCount = pending
        lastSyncOffline = true
        return pending
      }
      const deadline = Date.now() + timeoutMs
      do {
        if (depth() === 0)
          enqueue({ kind: "flush", reason: "final-drain" }, { force: true })
        await waitForIdle(Math.max(1, deadline - Date.now()))
        const pending = await pendingResearchSyncCount(root)
        lastPendingSyncCount = pending
        if (pending === 0) return 0
        await sleep(Math.min(1000, Math.max(0, deadline - Date.now())))
      } while (Date.now() < deadline)
      const pending = await pendingResearchSyncCount(root)
      lastPendingSyncCount = pending
      return pending
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
  intervalMs,
  syncQueueDepth,
  syncTelemetry,
}: {
  root: string
  args: Args
  sessionId: string
  intervalMs: number
  syncQueueDepth?: () => number
  syncTelemetry?: () => {
    pendingSyncCount: number
    oldestPendingAgeMs: number | null
    lastDurationMs: number | null
    lastError: string | null
    offline: boolean
    queueDepth: number
  }
}) {
  const lastSent = new Map<string, string>()
  const supervisorRunId = randomUUID()
  let sequence = 0
  let lastFullSnapshotAt = 0
  let running: Promise<void> | null = null
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const snapshot = async (forceFull = false) => {
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
    const sync = syncTelemetry?.()
    const pendingSyncCount = await pendingResearchSyncCount(root).catch(
      () => sync?.pendingSyncCount ?? 0
    )
    const activeWorkerCount = state.workers.filter(
      (worker) =>
        worker.sessionId === sessionId &&
        ["registered", "running"].includes(worker.status)
    ).length
    const unmeasuredSalvageCount = manifests.filter(
      (manifest) =>
        manifest.finalization?.salvaged &&
        manifest.finalization.finalizationStatus.startsWith(
          "salvaged_unmeasured"
        )
    ).length
    const workerSnapshots = state.workers
      .filter((worker) => worker.sessionId === sessionId)
      .map((worker) => {
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
        const snapshot = {
          id: worker.id,
          status: latest?.status ?? worker.status,
          phase: latest?.phase ?? worker.phase,
          progressMessage: latest?.progressMessage ?? worker.progressMessage,
          gitLabel: worker.gitLabel,
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
      const response = await syncResearchPresence(
        {
          siteId,
          supervisorRunId,
          sequence,
          sessionId,
          site: {
            pendingSyncCount,
            pushQueueDepth: sync?.queueDepth ?? syncQueueDepth?.() ?? 0,
            activeWorkerCount,
            oldestPendingAgeMs: sync?.oldestPendingAgeMs ?? null,
            lastSyncDurationMs: sync?.lastDurationMs ?? null,
            lastSyncError: sync?.lastError ?? null,
            uploadedWorkerCount: selectedWorkers.length,
            unchangedWorkerCount,
            droppedOrDeferredWorkerCount,
            unmeasuredSalvageCount,
            providerBackoff:
              cliState?.sessions?.[sessionId]?.providerBackoff ?? null,
            ignoredPresence:
              cliState?.sessions?.[sessionId]?.ignoredPresence ?? {},
            lastUploadAt: observedAt,
            metadata: {
              splitIndex: index + 1,
              splitCount,
              syncOffline: sync?.offline ?? false,
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
        `Presence sync ignored ${aggregateResponse.ignoredCount} worker update(s): ${reasonSummary}.`
      )
      if (responses.some(hasPresenceMismatch)) {
        console.warn(
          "Presence sync saw project_mismatch or session_mismatch; check worker/session wiring."
        )
      }
    }
  }

  const run = (forceFull = false) => {
    if (running) return running
    running = snapshot(forceFull)
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
    async flush() {
      await run(true).catch(() => {})
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      await run(true).catch(() => {})
    },
  }
}

export type StartupSyncSupervisor = {
  request(job?: { reason?: string }): number | null
  waitForIdle(timeoutMs: number): Promise<number>
}

export async function waitForStartupSessionSync({
  args,
  sessionId,
  syncSupervisor,
  timeoutMs = 30_000,
}: {
  args: Args
  sessionId: string
  syncSupervisor: StartupSyncSupervisor
  timeoutMs?: number
}) {
  if (args.options.offline === "true") return
  const deadline = Date.now() + timeoutMs
  syncSupervisor.request({ reason: "startup" })
  const pending = await syncSupervisor.waitForIdle(timeoutMs)
  let lastError: unknown = null
  if (pending > 0) {
    lastError = new Error(
      `startup sync queue still has ${pending} pending job(s)`
    )
  }
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
    `Startup session sync was not confirmed before launch (${errorMessage(lastError)}).`
  )
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
  let batches = 0
  let lastDurationMs: number | null = null
  let lastError: string | null = null
  let lockContentionLogged = false
  do {
    try {
      const result = await flushOutbox(root, args, {
        quiet: true,
        maxBatches: 1,
      })
      accepted += result.flushed
      offline = offline || result.offline
      batches += result.batches
      lastDurationMs = result.lastDurationMs
      lastError = result.lastError
      if (result.batches > 0) {
        console.log(
          `final sync batch ${batches}: accepted=${accepted} pending=${result.pending}${result.offline ? " offline=true" : ""}`
        )
      }
      if (result.pending === 0 || result.offline) break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const lockContention =
        /Timed out waiting for local Onyx research-sync lock/i.test(message)
      lastError = message
      if (!lockContention) throw error
      const pending = await pendingResearchSyncCount(root).catch(() => 0)
      if (!lockContentionLogged) {
        lockContentionLogged = true
        console.warn(
          `Final sync is waiting for another local Onyx sync drain to finish (${pending} pending event(s)).`
        )
      }
      if (pending === 0) break
    }
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
    batches,
    lastDurationMs,
    lastError,
    firstFailed: firstConflict ?? firstPendingError ?? null,
  }
}

function printFinalSyncReport(
  report: Awaited<ReturnType<typeof drainFinalSync>>
) {
  console.log(
    `final sync: accepted=${report.accepted} pending=${report.pending} conflicts=${report.conflicts} batches=${report.batches}${
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

type SessionFinalizationComputation = {
  status: SessionFinalizationStatus
  reasons: string[]
  live: ApiSessionLive | null
  pendingSyncCount: number
  conflictCount: number
}

async function computeSessionFinalizationStatus({
  root,
  sessionId,
  pendingSyncCount,
  requireOnline,
}: {
  root: string
  sessionId: string
  pendingSyncCount: number
  requireOnline: boolean
}): Promise<SessionFinalizationComputation> {
  const failedReasons: string[] = []
  const incompleteReasons: string[] = []
  const [conflictCount, manifests] = await Promise.all([
    researchSyncConflictCount(root).catch(() => 0),
    readWorkerLaunchManifests(root, sessionId).catch(() => []),
  ])

  if (pendingSyncCount > 0) {
    const message = `${pendingSyncCount} pending sync event(s)`
    if (requireOnline) failedReasons.push(message)
    else incompleteReasons.push(message)
  }
  if (conflictCount > 0) {
    incompleteReasons.push(`${conflictCount} sync conflict(s)`)
  }
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
        finalization.finalizationStatus === "none"
      const hasUnresolvedSalvage =
        finalization.finalizationStatus.startsWith("salvaged_unmeasured") ||
        (!cleanFinalizationStatus && finalization.unloggedCommitCount > 0)
      if (hasUnresolvedSalvage) {
        incompleteReasons.push(
          `worker ${manifest.workerId} has unlogged or salvaged work`
        )
      }
      if (finalization.workerBranchPushStatus === "failed") {
        incompleteReasons.push(`worker ${manifest.workerId} branch push failed`)
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
    pendingSyncCount,
    conflictCount,
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
  const dir = join(await onyxStateDir(root), "worktrees", sessionId, workerId)
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
  sessionId,
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
  sessionId: string
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
      manifest.salvaged = false
      manifest.unloggedCommitCount = 0
    } else if (analysis.kind === "salvage_only") {
      manifest.finalizationStatus = "salvaged_unmeasured"
      manifest.salvaged = true
      manifest.error = analysis.reason
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
              "defer-sync": "true",
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
            if (record && "discarded" in record && record.discarded) {
              manifest.finalizationStatus = "discarded_after_completion"
              manifest.salvaged = false
              manifest.error = `experiment log discarded: ${record.discardReason}`
              if (activityManifest) {
                await appendWorkerActivityEvent(activityManifest, {
                  type: "finalization",
                  phase: "discarded",
                  summary: "Experiment log discarded",
                  metadata: {
                    runRef: record.runRef,
                    discardReason: record.discardReason,
                  },
                })
              }
              return
            }
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

    if (manifest.finalizationStatus === "discarded_after_completion") {
      return manifest
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
      manifest.error =
        workerBranchPush.stderr.trim() ||
        workerBranchPush.stdout.trim() ||
        "worker branch push failed"
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
  if (result.timedOut) return `${label} timed out`
  if (result.code === 0) return null
  const summary = compactProviderErrorSummary(
    result.stderr.trim() || result.stdout.trim() || "no output"
  )
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
    return "stop_requested"
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
  const reasons: string[] = []
  const reasonCodes = new Set<ResearchStopReasonCode>()
  const addStopReason = (code: ResearchStopReasonCode, reason: string) =>
    addResearchStopReason(reasonCodes, reasons, code, reason)

  const state = await readState(root).catch(() => null)
  const localSession = state?.sessions?.[sessionId]
  if (localSession?.stopRequested) {
    addStopReason("stop_requested", "stop requested")
  }
  const localSessionState = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
  if (localSessionState && localSessionState.session.status !== "running") {
    if (
      localSessionState.session.terminalReason === "experiment_target_reached"
    ) {
      addStopReason("experiment_target_reached", "experiment target reached")
    } else if (localSessionState.session.terminalReason === "deadline_reached") {
      addStopReason("deadline_reached", "deadline reached")
    }
    addStopReason(
      "session_terminal",
      `local session ${localSessionState.session.status}`
    )
  }
  const localDeadline = localSessionState?.session.deadlineAt
    ? Date.parse(localSessionState.session.deadlineAt)
    : Number.NaN
  if (Number.isFinite(localDeadline) && nowMs >= localDeadline) {
    addStopReason("deadline_reached", "deadline reached")
  }
  const workerResearchDeadline = process.env.ONYX_RESEARCH_DEADLINE_AT
    ? Date.parse(process.env.ONYX_RESEARCH_DEADLINE_AT)
    : Number.NaN
  if (
    Number.isFinite(workerResearchDeadline) &&
    nowMs >= workerResearchDeadline
  ) {
    addStopReason("deadline_reached", "worker shutdown cushion reached")
  }

  return {
    shouldStop: reasons.length > 0,
    sessionId,
    reasonCodes: [...reasonCodes],
    reasons,
  }
}

export function createResearchSessionStopChecker({
  root,
  sessionId,
  args,
}: {
  root: string
  sessionId: string
  args: Args
}) {
  void args
  return {
    check({ nowMs = Date.now() }: { nowMs?: number } = {}) {
      return collectResearchStopReasons({
        root,
        sessionId,
        nowMs,
      })
    },
  }
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
  workerId,
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
  workerId: string
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
      void recordLocalWorkerHeartbeat({
        root,
        workerId,
        status: "running",
        sessionId,
        hypothesisId,
        phase,
        event: "heartbeat_sampled",
        progressMessage: message,
        metadata: snapshotMetadata,
      }).catch(() => {})
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

function finalizationLoggedExperiment(status: WorkerFinalizationStatus) {
  return status === "measured_and_logged"
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
  startupTimedOut?: boolean
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
  workerModel,
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
  workerModel: string | null
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
    const worker = await registerLocalWorker({
      root,
      campaignId: campaign.id,
      sessionId,
      hypothesisId: hypothesis.id,
      workerName: `${hypothesis.name}-${effectiveAgentKind}`,
      agentKind: effectiveAgentKind,
      runtime: "local",
      metadata: workerModelMetadata(workerModel),
    })
    workerId = worker.id
    onRegistered?.({ workerId: worker.id, hypothesisId: hypothesis.id })
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "running",
      sessionId,
      hypothesisId: hypothesis.id,
      phase: "starting",
      event: "hypothesis_started",
      progressMessage: `Preparing ${hypothesis.name} worker preflight`,
      metadata: workerModelMetadata(workerModel),
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
        schemaVersion: 1,
        campaignId: campaign.id,
        campaignName: campaign.name,
        sessionId,
        hypothesisId: hypothesis.id,
        hypothesisName: hypothesis.name,
        workerId: worker.id,
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
      ONYX_DEFER_EXP_LOG_SYNC: "1",
      ONYX_RESEARCH_DB: await researchDbPath(root),
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
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "running",
      sessionId,
      hypothesisId: hypothesis.id,
      phase: "orienting",
      event: "context_ready",
      progressMessage: `Worker context files are ready for ${hypothesis.name}`,
      metadata: workerModelMetadata(workerModel),
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
      nonnegativeNumberOption(args, "heartbeat-sample-interval", 60) * 1000
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
              phase: "orienting",
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
    await appendWorkerActivityEvent(launchManifest, {
      type: "phase_change",
      phase: "running",
      summary: "Provider process started",
    })
    const stopChecker = createResearchSessionStopChecker({
      root,
      sessionId,
      args,
    })
    const workerResult = await withWorkerHeartbeat({
      root,
      workerId: worker.id,
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
      sessionId,
      workerId: worker.id,
      workerBranch,
      activityManifest: launchManifest,
      args,
      workerFailed: Boolean(workerFailure) || stoppedByHarness,
      pushWorkerBranch: syncSupervisor.pushRef,
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
    if (finalizationLoggedExperiment(finalization.finalizationStatus)) {
      syncSupervisor.request({
        reason: "worker-finalization",
        manifest: launchManifest,
      })
    }
    if (finalization.rootDriftStatus === "dirty") {
      throw new Error(
        finalization.error ??
          "Main checkout changed during worker run; see worker manifest."
      )
    }

    if (stoppedByHarness) {
      if (launchManifest) {
        await appendWorkerActivityEvent(launchManifest, {
          type: "stop",
          phase: "stopped",
          summary: "Worker stopped after session stop request",
        })
      }
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
  if (args.options["max-experiments"] !== undefined) {
    throw new Error("--max-experiments was removed. Use --experiments.")
  }
  if (args.options["max-worker-iterations"] !== undefined) {
    throw new Error(
      "--max-worker-iterations is no longer a research session option."
    )
  }
  const experimentTarget = optionalPositiveIntegerOption(args, "experiments")
  const maxMinutes =
    args.options["max-minutes"] === undefined
      ? null
      : positiveNumberOption(args, "max-minutes", 120)
  if (experimentTarget === null && maxMinutes === null) {
    throw new Error("Pass --experiments <n> or --max-minutes <n>.")
  }
  const hypotheses = await hypothesisPlansOption(args)
  const workerTarget =
    workerTargetOption === undefined && hypotheses
      ? hypotheses.length
      : positiveIntegerOption(args, "workers", Number(workerTargetOption ?? 1))
  const workerSettings = await resolveWorkerSettings({ args })
  const deadlineAt =
    maxMinutes === null
      ? null
      : new Date(Date.now() + maxMinutes * 60_000).toISOString()
  const schedulerSiteId = await getResearchSiteId(root)
  const result = await createLocalSession({
    root,
    campaignId: campaign.id,
    name: args.options.name ?? `research-${new Date().toISOString()}`,
    workerTarget,
    hypotheses,
    experimentTarget,
    deadlineAt,
    schedulerSiteId,
    metadata: {
      startedBy: "onyx-research",
      experimentTarget,
      maxMinutes,
      agentKind: workerSettings.agentKind,
      ...workerModelMetadata(workerSettings.workerModel),
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
    deadlineAt,
    experimentTarget,
    acceptedExperimentCount: 0,
    remainingExperimentCount: experimentTarget,
    schedulerSiteId,
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

  console.log(`Research session: ${result.session.id}`)
  console.log(`Campaign: ${campaign.name}`)
  console.log(`Workers: 0/${workerTarget}`)
  console.log(`Hypotheses: ${result.hypotheses.length}`)
  console.log(`Experiment target: ${experimentTarget ?? "deadline only"}`)
  console.log(`Deadline: ${deadlineAt ?? "none"}`)
  const agentOption = workerOptions(workerSettings)
  const budgetOptions =
    maxMinutes === null ? "" : workerBudgetOptions({ maxMinutes })
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
      : validateWorkerModel(
          agentKind,
          metadataString(sessionMetadata, "workerModel")
        )
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
    console.log("Start or choose a research session before launching a worker.")
  }
}

export async function commandResearchBrief(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const campaignName =
    args.options.campaign ??
    state.activeCampaign ??
    (await getActiveLocalCampaignName(root))
  if (!campaignName) {
    throw new Error(
      "Pass --campaign <name>, run `onyx campaign use --name <name>`, or sync/start a local campaign first."
    )
  }

  const campaign = await localCampaignByName({
    root,
    projectPath,
    name: campaignName,
  })
  if (!campaign) {
    throw new Error(
      `Local campaign ${campaignName} was not found. Run \`onyx sync\` or start/select a campaign first.`
    )
  }

  const sessionId =
    args.options.session ??
    process.env.ONYX_SESSION_ID ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: campaign.name,
    })
  const hypothesisId =
    args.options.hypothesis ?? process.env.ONYX_HYPOTHESIS_ID ?? undefined
  const brief = await localResearchBrief({
    root,
    campaignId: campaign.id,
    sessionId,
    hypothesisId,
  })

  if (args.options.json === "true") {
    console.log(JSON.stringify(brief, null, 2))
    return
  }
  console.log(brief.markdown)
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
  const terminalWorkers = workers.filter((worker) =>
    ["completed", "failed", "stopped"].includes(worker.status)
  ).length
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
  const live = activeSessionId
    ? await getResearchSessionLive(activeSessionId, args).catch(() => null)
    : null
  const liveWorkerById = new Map(
    (live?.workers ?? []).map((worker) => [worker.id, worker])
  )
  const workersForStatus = workers.map((worker) => {
    const liveWorker = liveWorkerById.get(worker.id)
    return liveWorker
      ? {
          ...worker,
          liveness: liveWorker.liveness,
          phase: liveWorker.phase ?? worker.phase,
          progressMessage: liveWorker.progressMessage ?? worker.progressMessage,
          gitLabel: liveWorker.gitLabel ?? worker.gitLabel,
          currentExperimentId:
            liveWorker.currentExperimentId ?? worker.currentExperimentId,
          lastSeenAt: liveWorker.receivedAt ?? worker.lastSeenAt,
        }
      : worker
  })
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
  const sessionMetadata = sessionState?.session.metadata ?? {}
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
  const localUnloggedAttempts = manifests
    .filter(
      (manifest) =>
        manifest.finalization?.finalizationStatus.startsWith(
          "salvaged_unmeasured"
        ) ||
        (manifest.finalization?.unloggedCommitCount ?? 0) > 0 ||
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
                terminalWorkers,
                openSlots,
                stopping,
                launchRate,
                activeProcessCount,
                supervisor: supervisorTelemetry
                  ? {
                      pid: supervisorTelemetry.pid ?? null,
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
          pendingSync,
          bestExperiment,
          providerBackoff,
          recentFailedLaunches,
          failures: failureSummary,
          sync: {
            pendingSync,
            conflicts,
            oldestPendingAgeMs: live?.sync?.oldestPendingAgeMs ?? null,
            lastDurationMs: live?.sync?.lastDurationMs ?? null,
            lastError: live?.sync?.lastError ?? null,
            sites: live?.sites ?? [],
          },
          finalization: live?.finalization ?? null,
          localUnloggedAttempts: {
            count: localUnloggedAttempts.length,
            workers: localUnloggedAttempts,
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
  if (activeSessionId) {
    console.log(`session: ${activeSessionId} ${sessionStatus ?? ""}`.trim())
  }
  console.log(
    `sync: ${pendingSync} SQLite event(s) pending${
      conflicts ? `, ${conflicts} conflict(s)` : ""
    }`
  )
  if (live?.sync) {
    console.log(
      `sync telemetry: oldestPending=${live.sync.oldestPendingAgeMs ?? "-"}ms lastDuration=${live.sync.lastDurationMs ?? "-"}ms lastError=${live.sync.lastError ?? "-"}`
    )
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
    const progress = live?.progress ?? (sessionState?.session ?? null)
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

  const result = await collectResearchStopReasons({
    root,
    sessionId,
  })
  if (args.options.json === "true") {
    console.log(
      JSON.stringify(
        {
          shouldStop: result.shouldStop,
          sessionId,
          reasonCodes: result.reasonCodes,
          reasons: result.reasons,
        },
        null,
        2
      )
    )
  } else {
    console.log(
      result.shouldStop
        ? `stop: ${result.reasons.join(", ")}`
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
      terminalReason: "stop_requested",
      reason: args.options.reason ?? "stop requested",
    }).catch(() => {})
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
  const state = await readState(root)
  const projectPath = await resolveProjectPath(root, args)
  const sessionId =
    args.options.session ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: campaign.name,
    })

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
      providerBackoff: null,
    }
    await writeState(root, state)
    await abandonBlockedWorkflowRunsForSession({
      root,
      sessionId,
      reason:
        "Campaign finalized; blocked worker workflow is no longer active.",
    }).catch(() => [])
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
      if (["registered", "running"].includes(worker.status)) {
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
    if (args.options.offline !== "true") {
      await stopCampaignSession(
        sessionId,
        {
          campaignId: campaign.id,
          status: "completed",
          reason: "finalized",
        },
        args
      ).catch((error) => {
        if (args.options["require-online"] === "true") throw error
      })
    }
  }

  if (args.options.offline !== "true") {
    try {
      const report = await drainFinalSync({
        root,
        args,
        timeoutMs: positiveNumberOption(args, "final-sync-timeout", 120) * 1000,
      })
      printFinalSyncReport(report)
      if (
        args.options["require-online"] === "true" &&
        (report.offline || report.pending > 0 || report.conflicts > 0)
      ) {
        throw new Error(
          "Final sync did not acknowledge every pending record before timeout."
        )
      }
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
        batches: 0,
        lastDurationMs: null,
        lastError: null,
        firstFailed:
          conflictEvents[0] ??
          pendingEvents.find((event) => event.lastError) ??
          null,
      })
      if (args.options["require-online"] === "true") throw error
    }
  }

  const overview =
    args.options.offline === "true"
      ? campaignInfo.overview
      : await reconcileCampaignIntoLocalState({
          root,
          campaignId: campaign.id,
          projectPath: campaignInfo.projectPath,
          args,
        })
          .then(() => getCampaignOverview(campaign.id, args))
          .catch((error) => {
            if (args.options["require-online"] === "true") throw error
            return campaignInfo.overview
          })

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
  const finishLive = sessionId
    ? await getResearchSessionLive(sessionId, args).catch(() => null)
    : null
  const finishLocal = sessionId
    ? await getLocalSessionState(root, sessionId).catch(() => null)
    : null
  const finishManifests = sessionId
    ? await readWorkerLaunchManifests(root, sessionId).catch(() => [])
    : []
  const finishUnmeasuredSalvage =
    finishLive?.finalization?.unmeasuredSalvageCount ??
    finishManifests.filter(
      (manifest) =>
        manifest.finalization?.salvaged &&
        manifest.finalization.finalizationStatus.startsWith(
          "salvaged_unmeasured"
        )
    ).length
  const finishAccepted =
    finishLive?.session.acceptedExperimentCount ??
    finishLocal?.session.acceptedExperimentCount ??
    overview.campaign.experimentCount ??
    0
  const finishTarget =
    finishLive?.session.experimentTarget ??
    finishLocal?.session.experimentTarget ??
    null

  const body = [
    `Finalized campaign ${campaign.name}.`,
    `Best metric: ${overview.campaign.bestMetricValue ?? "n/a"}`,
    `Best commit: ${overview.campaign.bestCommitSha ?? "n/a"}`,
    `Experiment counts: accepted=${finishAccepted}${finishTarget === null ? "" : `/${finishTarget}`} unmeasuredSalvage=${finishUnmeasuredSalvage}`,
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
  }).catch((error) => {
    if (args.options["require-online"] === "true") throw error
  })
  if (args.options.offline !== "true") {
    const report = await drainFinalSync({
      root,
      args,
      timeoutMs: positiveNumberOption(args, "final-sync-timeout", 120) * 1000,
    })
    printFinalSyncReport(report)
    if (
      args.options["require-online"] === "true" &&
      (report.offline || report.pending > 0 || report.conflicts > 0)
    ) {
      throw new Error(
        "Final summary sync did not acknowledge every pending record before timeout."
      )
    }
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
  if (
    args.options.offline !== "true" &&
    (args.options["require-online"] === "true" || args.options.sync === "true")
  ) {
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
  if (
    args.options.offline !== "true" &&
    (args.options["require-online"] === "true" || args.options.sync === "true")
  ) {
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
  await assertLocalSessionSchedulerSite({
    root,
    sessionId,
    schedulerSiteId: sessionState.session.schedulerSiteId,
  })
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
    session: sessionId,
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
      env: { ...process.env, ONYX_LAUNCHER_BYPASS: "1" },
    })
    pid = child.pid ?? null
    child.unref()
  } finally {
    closeSync(outputFd)
  }

  await persistSupervisorTelemetry({
    root,
    sessionId,
    campaignName: campaign.name,
    campaignId: campaign.id,
    telemetry: {
      pid,
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

  if (args.options["worker-command"] && args.options.model !== undefined) {
    throw new Error("Pass either --worker-command or --model, not both.")
  }
  if (args.options["max-worker-iterations"] !== undefined) {
    throw new Error("--max-worker-iterations is no longer a worker option.")
  }
  const sessionMetadata = sessionState?.session.metadata ?? {}
  const workerSettings = args.options["worker-command"]
    ? ({ agentKind: "codex", workerModel: null } satisfies WorkerSettings)
    : await resolveWorkerSettings({
        args,
        sessionMetadata: sessionState ? sessionMetadata : null,
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
    optionalPositiveIntegerOption(args, "experiments") ??
    sessionState?.session.experimentTarget ??
    (typeof sessionMetadata.experimentTarget === "number"
      ? sessionMetadata.experimentTarget
      : null)
  const maxMinutes =
    args.options["max-minutes"] === undefined
      ? null
      : positiveNumberOption(args, "max-minutes", 120)
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
  const now = Date.now()
  const existingDeadlineAt =
    sessionState?.session.deadlineAt ??
    (requestedSessionId
      ? state.sessions?.[requestedSessionId]?.deadlineAt
      : null) ??
    null
  const deadlineAt =
    maxMinutes === null
      ? existingDeadlineAt
      : new Date(now + maxMinutes * 60_000).toISOString()
  if (!requestedSessionId && experimentTarget === null && deadlineAt === null) {
    throw new Error("Pass --experiments <n> or --max-minutes <n>.")
  }
  const endTimeMs = deadlineAt ? Date.parse(deadlineAt) : Number.POSITIVE_INFINITY
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
  const syncIntervalMs = positiveNumberOption(args, "sync-interval", 5) * 1000
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
  const finalSyncTimeoutMs =
    positiveNumberOption(args, "final-sync-timeout", 120) * 1000

  let sessionId = requestedSessionId
  let schedulerSiteId = sessionState?.session.schedulerSiteId ?? null
  if (!sessionId) {
    schedulerSiteId = await getResearchSiteId(root)
    const result = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: args.options.name ?? `research-${new Date().toISOString()}`,
      workerTarget,
      hypotheses,
      experimentTarget,
      deadlineAt,
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
        syncIntervalSeconds: syncIntervalMs / 1000,
      },
    })
    sessionId = result.session.id
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
    deadlineAt,
    experimentTarget,
    acceptedExperimentCount:
      sessionState?.session.acceptedExperimentCount ?? 0,
    remainingExperimentCount:
      experimentTarget === null
        ? null
        : Math.max(
            0,
            experimentTarget -
              (sessionState?.session.acceptedExperimentCount ?? 0)
          ),
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

  const syncSupervisor = createSyncSupervisor({
    root,
    args,
    intervalMs: syncIntervalMs,
  })
  try {
    await waitForStartupSessionSync({
      args,
      sessionId,
      syncSupervisor,
    })
  } catch (error) {
    const reason = `startup session sync failed: ${errorMessage(error)}`
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
    await syncSupervisor
      .drain(Math.min(finalSyncTimeoutMs, 30_000))
      .catch(() => {
        syncSupervisor.stop()
      })
    throw new Error(reason)
  }
  const presenceSupervisor = createPresenceSupervisor({
    root,
    args,
    sessionId,
    intervalMs: presenceIntervalMs,
    syncQueueDepth: syncSupervisor.depth,
    syncTelemetry: syncSupervisor.telemetry,
  })
  presenceSupervisor.request()

  const activeRuns = new Map<string, Promise<HypothesisRunResult>>()
  let launched = 0
  let completed = 0
  let failed = 0
  let stopped = 0
  let waitingLogged = false
  let lastLaunchBatchAt = 0
  let providerBackoffUntil = 0
  let providerBackoffReason: string | null = null
  let providerBackoffAttempt = 0
  let providerBackoffLogged = false
  let recentProviderFailures: ProviderLaunchFailure[] = []
  let terminalReason: SessionTerminalReason | null = null
  let providerTerminalFailure: ProviderLaunchFailure | null = null
  let lastStopCheck: ResearchStopCheck | null = null
  const supervisorPid = process.pid
  const supervisorLogPath = args.options["supervisor-log-path"] ?? null
  let lastTelemetryAt = 0
  let stopLogged = false
  const sessionStopChecker = createResearchSessionStopChecker({
    root,
    sessionId,
    args,
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
  console.log(`Sync: every ${syncIntervalMs / 1000}s`)

  let supervisorLoopCompleted = false
  try {
    while (Date.now() < hardEndTimeMs) {
      const loopNow = Date.now()
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

      const latest = await getLocalSessionState(root, sessionId).catch(() =>
        getResearchSessionState(sessionId, args)
      )
      if (latest.session.status !== "running") break
      const activeWorkers = activeSessionWorkers({
        workers: latest.workers,
        sessionId,
      }).length
      const occupiedWorkerSlots = Math.max(activeWorkers, activeRuns.size)
      const openSlots = Math.max(
        0,
        workerTarget - occupiedWorkerSlots
      )
      const concurrencySlots = Math.max(0, maxConcurrency - activeRuns.size)
      const providerBackoffActive = Date.now() < providerBackoffUntil
      const rampWaiting =
        lastLaunchBatchAt > 0 &&
        Date.now() - lastLaunchBatchAt < launchIntervalMs
      const launchSlots =
        providerBackoffActive || rampWaiting
          ? 0
          : Math.min(openSlots, concurrencySlots, launchBatchSize)
      let launchedThisTick = 0

      if (providerBackoffActive && !providerBackoffLogged) {
        providerBackoffLogged = true
        console.warn(
          `Provider backoff active (${providerBackoffReason ?? "startup failure"}); pausing launches for ${Math.ceil(
            (providerBackoffUntil - Date.now()) / 1000
          )}s.`
        )
      }
      for (let index = 0; index < launchSlots; index += 1) {
        const launchStopCheck = await sessionStopChecker
          .check()
          .catch(() => null)
        if (launchStopCheck?.shouldStop) break
        const refreshed = await getLocalSessionState(root, sessionId).catch(
          () => getResearchSessionState(sessionId, args)
        )
        const activeCount = Math.max(
          activeSessionWorkers({
            workers: refreshed.workers,
            sessionId,
          }).length,
          activeRuns.size
        )
        if (
          activeCount >= workerTarget ||
          activeRuns.size >= maxConcurrency ||
          refreshed.session.status !== "running"
        ) {
          break
        }
        const hypothesis = chooseSupervisorHypothesis({
          hypotheses: refreshed.hypotheses,
          workers: refreshed.workers.filter(
            (worker) => worker.sessionId === sessionId
          ),
        })
        if (!hypothesis) {
          if (activeRuns.size === 0) terminalReason = "no_active_hypotheses"
          break
        }

        waitingLogged = false
        launched += 1
        launchedThisTick += 1
        const runKey = `${Date.now()}:${launched}:${hypothesis.id}`
        const run = runHypothesisOnce({
          root,
          projectPath: effectiveProjectPath,
          campaign,
          setup,
          sessionId,
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
          syncSupervisor,
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
            activeRuns.delete(runKey)
            void persistRuntimeTelemetry({
              force: true,
              activeProcessCount: activeRuns.size,
            })
            syncSupervisor.request({ reason: "worker-finished" })
            presenceSupervisor.request()
          })
        activeRuns.set(runKey, run)
        await persistRuntimeTelemetry({
          force: true,
          activeProcessCount: activeRuns.size,
        })
        presenceSupervisor.request()
      }
      if (launchedThisTick > 0) lastLaunchBatchAt = Date.now()

      if (launchedThisTick === 0) {
        const hasActiveHypotheses = latest.hypotheses.some(
          (hypothesis) => hypothesis.status === "active"
        )
        if (activeRuns.size === 0 && openSlots > 0 && !hasActiveHypotheses) {
          terminalReason = "no_active_hypotheses"
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
    if (!supervisorLoopCompleted) syncSupervisor.stop()
  }

  const finalState = await readState(root)
  const explicitStop = sessionStopRequested({ state: finalState, sessionId })
  const postLoopLocal = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
  terminalReason =
    (explicitStop ? "stop_requested" : terminalReason) ??
    (lastStopCheck ? terminalReasonForStopCheck(lastStopCheck) : null) ??
    postLoopLocal?.session.terminalReason ??
    (Number.isFinite(endTimeMs) && Date.now() >= endTimeMs
      ? "deadline_reached"
      : null) ??
    "no_active_hypotheses"
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
  await syncSupervisor.drain(finalSyncTimeoutMs)
  const preFinalizationSync = await drainFinalSync({
    root,
    args,
    timeoutMs: finalSyncTimeoutMs,
  })
  printFinalSyncReport(preFinalizationSync)
  const finalization = await computeSessionFinalizationStatus({
    root,
    sessionId,
    pendingSyncCount: preFinalizationSync.pending,
    requireOnline: args.options["require-online"] === "true",
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
  const finalSync = await drainFinalSync({
    root,
    args,
    timeoutMs: finalSyncTimeoutMs,
  })
  printFinalSyncReport(finalSync)
  let reportedFinalizationStatus = finalization.status
  const finalSyncHasDebt =
    finalSync.pending > 0 || finalSync.conflicts > 0 || finalSync.offline
  if (
    finalSyncHasDebt &&
    (reportedFinalizationStatus === "complete" ||
      args.options["require-online"] === "true")
  ) {
    reportedFinalizationStatus =
      args.options["require-online"] === "true" ? "failed" : "incomplete"
    const adjustedState = await readState(root)
    adjustedState.sessions = adjustedState.sessions ?? {}
    adjustedState.sessions[sessionId] = {
      ...(adjustedState.sessions[sessionId] ?? {}),
      finalizationStatus: reportedFinalizationStatus,
    }
    await writeState(root, adjustedState)
    if (reportedFinalizationStatus === "failed") {
      finalStatus = "failed"
      terminalReason = "failed"
    }
    await stopLocalSession({
      root,
      sessionId,
      status: finalStatus,
      finalizationStatus: reportedFinalizationStatus,
      terminalReason,
      reason:
        args.options["require-online"] === "true"
          ? "final session sync failed with --require-online"
          : "final session sync remains pending",
      metadata: {
        terminalReason,
        providerFailure: providerTerminalFailure,
        finalizationReasons: [
          ...finalization.reasons,
          args.options["require-online"] === "true"
            ? "final session sync failed with --require-online"
            : "final session sync remains pending",
        ],
      },
    }).catch(() => {})
  }
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
  await presenceSupervisor.flush()

  console.log(
    `Research run ${finalStatus}: launched=${launched} completed=${completed} failed=${failed} stopped=${stopped}; finalization=${reportedFinalizationStatus}.`
  )
  console.log(
    `Experiment counts: accepted=${acceptedExperiments}${completedExperimentTarget === null ? "" : `/${completedExperimentTarget}`} unmeasuredSalvage=${unmeasuredSalvageCount} pendingSync=${finalSync.pending}.`
  )
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
    agentKind: workerSettings.agentKind,
    workerModel: workerSettings.workerModel,
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
