import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  researchHypothesisPlanSchema,
  type ResearchHypothesisPlan,
} from "../protocol"
import { optionValues, type Args } from "../lib/args"
import { commandExpLog, commandExpRun } from "./exp"
import {
  createCampaignHypothesis,
  createCampaignSession,
  getCampaignBrief,
  getCampaignOverview,
  getResearchSessionState,
  heartbeatWorker,
  createCampaignKnowledge,
  listCampaignKnowledge,
  listProjectCampaigns,
  registerCampaignWorker,
  reconcileCampaign,
  stopCampaignSession,
  resolveProject,
  upsertCampaignSummary,
  type ApiCampaign,
  type ApiHypothesis,
} from "../lib/api"
import {
  readSetupFile,
  readValidationFile,
  requiredSetupModules,
  setupPath,
  validationPath,
  type ResearchSetupFile,
} from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, git, gitResult, repoRoot } from "../lib/git"
import { readHistory } from "../lib/history"
import { onyxStateDir, readOutbox, readState, writeState } from "../lib/outbox"
import { campaignStateKey, onyxPath, resolveProjectPath } from "../lib/project"
import {
  pathExists,
  runStreamingProcess,
  type ProcessResult,
  type StreamingProcessResult,
} from "../lib/process"
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
  type WorkerInvocation,
  type WorkerLaunchManifest,
  type WorkerOnyxShim,
} from "../lib/worker-launcher"
import { renderHypothesisWorkerPrompt } from "../lib/worker-prompt"

const MAX_WORKER_SHUTDOWN_CUSHION_MS = 90_000
const MIN_WORKER_SHUTDOWN_CUSHION_MS = 15_000
const MAX_WORKER_HARD_STOP_GRACE_MS = 30_000

function positiveIntegerOption(args: Args, name: string, fallback: number) {
  const raw = args.options[name]
  if (raw === undefined) return fallback
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
  const path = args.options["hypotheses"]
  if (!path) return undefined
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!Array.isArray(parsed)) {
    throw new Error("--hypotheses must point to a JSON array")
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

async function hypothesisPlanOption(
  args: Args
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
  return researchHypothesisPlanSchema.parse({
    focus,
    statement: hypothesis,
    startingPoints: optionValues(args, "starting-point"),
    avoidList: optionValues(args, "avoid"),
    successSignals: optionValues(args, "success"),
    giveUpSignals: optionValues(args, "give-up"),
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
        const { records } = await readOutbox(root)
        if (records.length === 0) return 0
        await sleep(Math.min(1000, Math.max(0, deadline - Date.now())))
      } while (Date.now() < deadline)
      const { records } = await readOutbox(root)
      return records.length
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}

async function campaignForName(root: string, args: Args) {
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

  return { projectPath, campaign: overview.campaign, overview }
}

async function assertLocalSetupReady(root: string, projectPath: string) {
  const setup = await readSetupFile(root, projectPath)
  const cheapFailures = await recheckCheapRequiredSetupModules({
    root,
    projectPath,
    setup,
  })
  if (cheapFailures.length > 0) {
    throw new Error(
      `Required setup module(s) failed local preflight: ${cheapFailures.join("; ")}. Run \`onyx setup validate --required\`.`
    )
  }

  const validation = await readValidationFile(root, projectPath)
  if (!validation) {
    throw new Error(
      "Missing onyx/validation.json. Run `onyx setup validate` before starting research."
    )
  }
  const byModule = new Map(
    validation.modules.map((module) => [module.moduleId, module])
  )
  const failing = requiredSetupModules(setup).filter(
    (moduleId) => byModule.get(moduleId)?.status !== "passed"
  )
  if (failing.length > 0) {
    throw new Error(
      `Required setup module(s) are not passing: ${failing.join(", ")}. Run \`onyx setup validate --required\`.`
    )
  }
  return { setup, validation }
}

async function recheckCheapRequiredSetupModules({
  root,
  projectPath,
  setup,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
}) {
  const required = new Set(requiredSetupModules(setup))
  const failures: string[] = []

  if (required.has("project_scope") && setup.projectPath !== projectPath) {
    failures.push(
      `project_scope expected projectPath "${projectPath}" but setup has "${setup.projectPath}"`
    )
  }

  if (required.has("evaluation")) {
    if (setup.metric.name.trim().length === 0) {
      failures.push("evaluation is missing a metric")
    }
    if (setup.commands.evaluate.command.trim().length === 0) {
      failures.push("evaluation is missing a command")
    }
  }

  if (required.has("agent")) {
    const instructionsPath = onyxPath(root, projectPath, "onyx.md")
    if (!(await pathExists(instructionsPath))) {
      failures.push("agent is missing onyx/onyx.md")
    } else {
      const instructions = await readFile(instructionsPath, "utf8")
      if (instructions.trim().length < 20) {
        failures.push("agent has too little guidance in onyx/onyx.md")
      }
    }
  }

  return failures
}

async function writeBrief({
  root,
  campaignId,
  sessionId,
  hypothesis,
  args,
}: {
  root: string
  campaignId: string
  sessionId: string
  hypothesis: ApiHypothesis
  args: Args
}) {
  const brief = await getCampaignBrief(campaignId, args)
  const dir = join(await onyxStateDir(root), "briefs", sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${hypothesis.name}.md`)
  await writeFile(path, `${brief.markdown}\n`, "utf8")
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
  const state = await getResearchSessionState(sessionId, args)
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  return path
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
  const branch = workerBranchName({ sessionId, hypothesis, workerId })
  const dir = join(
    await onyxStateDir(root),
    "worktrees",
    `${sessionId}-${hypothesis.name}-${workerId.slice(0, 8)}`
  )
  if (!(await pathExists(dir))) {
    await mkdir(join(await onyxStateDir(root), "worktrees"), {
      recursive: true,
    })
    await git(
      ["worktree", "add", "-B", branch, dir, hypothesis.baseCommitSha],
      root
    )
  }
  return { dir, branch }
}

function workerBranchName({
  sessionId,
  hypothesis,
  workerId,
}: {
  sessionId: string
  hypothesis: ApiHypothesis
  workerId: string
}) {
  return [
    "onyx",
    safeBranchSegment(sessionId).slice(0, 12),
    safeBranchSegment(hypothesis.name),
    safeBranchSegment(workerId).slice(0, 12),
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

async function hasLocalExperimentFor({
  root,
  campaignName,
  hypothesisId,
  resultCommitSha,
}: {
  root: string
  campaignName: string
  hypothesisId: string
  resultCommitSha: string
}) {
  const [outbox, history] = await Promise.all([
    readOutbox(root).catch(() => ({ records: [], corrupt: 0 })),
    readHistory(root).catch(() => ({ records: [], corrupt: 0 })),
  ])
  return (
    outbox.records.some(
      (record) =>
        record.type === "campaign_experiment_logged" &&
        record.campaignName === campaignName &&
        record.hypothesisId === hypothesisId &&
        record.resultCommitSha === resultCommitSha
    ) ||
    history.records.some(
      (record) =>
        record.campaignName === campaignName &&
        record.hypothesisId === hypothesisId &&
        record.resultCommitSha === resultCommitSha
    )
  )
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

async function finalizeHypothesisAttempt({
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
    commitSha: null,
    experimentLogged: false,
    workerBranchPushStatus: "not_attempted",
    error: null,
  }

  try {
    const headBefore = await currentCommit(worktree)
    const dirty = (await git(["status", "--porcelain"], worktree)).trim()
    const hasResult =
      (Boolean(dirty) && dirty.length > 0) ||
      headBefore !== hypothesis.baseCommitSha
    if (!hasResult) return manifest

    manifest.attempted = true
    const commit = await commitIfNeeded(worktree, hypothesis)
    manifest.commitSha = commit.commitSha

    if (
      !(await hasLocalExperimentFor({
        root,
        campaignName: campaign.name,
        hypothesisId: hypothesis.id,
        resultCommitSha: commit.commitSha,
      }))
    ) {
      let measurementError: string | null = null
      await withoutProcessExitCode(() =>
        commandExpRun({
          positional: ["exp", "run"],
          options: {
            ...args.options,
            cwd: worktree,
            campaign: campaign.name,
            base: hypothesis.baseCommitSha,
            timeout: "120",
            "checks-timeout": "120",
          },
        })
      ).catch((error) => {
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
            base: hypothesis.baseCommitSha,
            hypothesis: hypothesis.id,
            session: sessionId,
            worker: workerId,
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
            }),
          },
        })
      )
        .then(() => {
          manifest.experimentLogged = true
        })
        .catch((error) => {
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

    return manifest
  } catch (error) {
    manifest.error = errorMessage(error)
    return manifest
  }
}

async function writeWorkerPrompt({
  root,
  projectPath,
  campaign,
  setup,
  sessionId,
  hypothesis,
  workerBranch,
  briefPath,
  sessionStatePath,
  maxIterations,
  endTimeMs,
}: {
  root: string
  projectPath: string
  campaign: ApiCampaign
  setup: ResearchSetupFile
  sessionId: string
  hypothesis: ApiHypothesis
  workerBranch: string
  briefPath: string
  sessionStatePath: string | null
  maxIterations: number
  endTimeMs: number
}) {
  const dir = join(await onyxStateDir(root), "worker-prompts", sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${hypothesis.name}.md`)
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
    researchDeadlineIso: new Date(researchDeadlineMs).toISOString(),
    setupFilePath: setupPath(root, projectPath),
    shutdownCushionSeconds: Math.ceil(shutdownCushionMs / 1000),
    shutdownDeadlineIso: new Date(shutdownDeadlineMs).toISOString(),
    validationFilePath: validationPath(root, projectPath),
    researchSpecPath: projectPath
      ? `${projectPath}/onyx/onyx.md`
      : "onyx/onyx.md",
    sessionId,
    sessionStatePath,
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

async function withWorkerHeartbeat<T>({
  workerId,
  sessionId,
  hypothesisId,
  args,
  phase,
  progressMessage,
  metadata,
  run,
}: {
  workerId: string
  sessionId: string
  hypothesisId: string
  args: Args
  phase: string
  progressMessage: string | (() => string)
  metadata?: () => Record<string, unknown>
  run: () => Promise<T>
}): Promise<T> {
  const timer = setInterval(() => {
    void heartbeatWorker(
      workerId,
      {
        status: "running",
        sessionId,
        hypothesisId,
        phase,
        event: "heartbeat",
        progressMessage:
          typeof progressMessage === "function"
            ? progressMessage()
            : progressMessage,
        metadata: metadata?.(),
      },
      args
    ).catch(() => {})
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
  return `${hypothesisName} worker running; ${output}; log ${logPath}`
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
    workerPromptPath: manifest.promptPath,
    lastOutputAt: manifest.lastOutputAt,
    version: manifest.version,
    onyxShimPath: manifest.onyxShimPath,
    addedWritableRoots: manifest.addedWritableRoots,
    preflight: manifest.preflight,
  }
}

type HypothesisRunResult = {
  hypothesis: ApiHypothesis
  workerId?: string
  resultCommitSha?: string
  status: "completed" | "failed"
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
  syncSupervisor,
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
  syncSupervisor: ReturnType<typeof createSyncSupervisor>
  args: Args
}): Promise<HypothesisRunResult> {
  let workerId: string | undefined
  let resultCommitSha: string | undefined
  let launchManifest: WorkerLaunchManifest | null = null
  let workerShim: WorkerOnyxShim | null = null

  try {
    const worker = await registerCampaignWorker(
      campaign.id,
      {
        sessionId,
        hypothesisId: hypothesis.id,
        workerName: `${hypothesis.name}-${agentKind}`,
        agentKind,
        runtime: "local",
      },
      args
    )
    workerId = worker.id
    await heartbeatWorker(
      worker.id,
      {
        status: "running",
        sessionId,
        hypothesisId: hypothesis.id,
        phase: "research",
        event: "hypothesis_started",
        progressMessage: `Running ${hypothesis.name}`,
      },
      args
    )

    const { dir: worktree, branch: workerBranch } = await ensureWorktree({
      root,
      hypothesis,
      sessionId,
      workerId: worker.id,
    })
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
        args,
      }),
      writeSessionState({ root, sessionId, hypothesis, args }).catch(
        () => null
      ),
    ])
    const prompt = await writeWorkerPrompt({
      root,
      projectPath,
      campaign,
      setup,
      sessionId,
      hypothesis,
      workerBranch,
      briefPath,
      sessionStatePath,
      maxIterations,
      endTimeMs,
    })
    workerShim = await writeWorkerOnyxShim({ root, sessionId })
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
      ONYX_BRIEF_FILE: briefPath,
      ONYX_WORKER_PROMPT_FILE: prompt.path,
      ONYX_SETUP_FILE: setupPath(root, projectPath),
      ONYX_VALIDATION_FILE: validationPath(root, projectPath),
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
      manifestPath: launchPaths.manifestPath,
      sessionId,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
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
    await writeWorkerLaunchManifest(launchManifest)
    const workerResult = await withWorkerHeartbeat({
      workerId: worker.id,
      sessionId,
      hypothesisId: hypothesis.id,
      args,
      phase: "research",
      progressMessage: () =>
        workerProgress({
          hypothesisName: hypothesis.name,
          logPath: launchManifest?.logPath ?? launchPaths.logPath,
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
          logHeader: [
            `# agent: ${invocation.agentKind}`,
            `# prompt: ${prompt.path}`,
            `# worker: ${worker.id}`,
            `# hypothesis: ${hypothesis.id}`,
          ].join("\n"),
          stdin: invocation.stdin,
          env: workerRunEnv,
          onOutput: ({ at }) => {
            if (!launchManifest) return
            launchManifest = {
              ...launchManifest,
              status: "running",
              lastOutputAt: at,
            }
            void writeWorkerLaunchManifest(launchManifest).catch(() => {})
          },
        }),
    })
    if (launchManifest) {
      launchManifest = {
        ...launchManifest,
        completedAt: new Date().toISOString(),
        status: workerResult.code === 0 ? "completed" : "failed",
        exitCode: workerResult.code,
        signal: workerResult.signal,
        timedOut: workerResult.timedOut,
        startupTimedOut: workerResult.startupTimedOut,
        lastOutputAt: workerResult.lastOutputAt,
      }
      await writeWorkerLaunchManifest(launchManifest)
    }
    const workerFailure = processFailure(
      workerResult,
      `Worker process for ${hypothesis.name}`
    )
    const finalization = await finalizeHypothesisAttempt({
      root,
      worktree,
      campaign,
      hypothesis,
      sessionId,
      workerId: worker.id,
      workerBranch,
      args,
      workerFailed: Boolean(workerFailure),
    })
    if (finalization.commitSha) resultCommitSha = finalization.commitSha
    if (launchManifest) {
      launchManifest = {
        ...launchManifest,
        finalization,
      }
      await writeWorkerLaunchManifest(launchManifest)
    }
    if (finalization.experimentLogged) syncSupervisor.request()

    if (workerFailure) {
      throw new Error(
        `${workerFailure}. ${
          finalization.attempted
            ? `Best-effort finalization ${finalization.experimentLogged ? "logged an experiment" : "ran"} for ${finalization.commitSha ?? "unknown commit"}. `
            : ""
        }See worker log: ${launchManifest?.logPath ?? launchPaths.logPath}`
      )
    }

    await heartbeatWorker(
      worker.id,
      {
        status: "stopped",
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
        title: `${hypothesis.name} completed`,
        body: [
          `Worker process exited successfully.`,
          `Latest commit: ${resultCommitSha ?? "n/a"}`,
          `Finalization: ${
            finalization.attempted
              ? finalization.experimentLogged
                ? "experiment logged"
                : "attempted"
              : "no result changes"
          }`,
          finalization.workerBranchPushStatus === "failed"
            ? `Worker branch push failed: ${finalization.error ?? "unknown error"}`
            : "",
          `Worker log: ${launchManifest?.logPath ?? "n/a"}`,
          workerResult.stdout.trim()
            ? `\nWorker output:\n${workerResult.stdout.trim().slice(-4000)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      args
    )
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
      await writeWorkerLaunchManifest(launchManifest).catch(() => {})
    }
    if (workerId) {
      await heartbeatWorker(
        workerId,
        {
          status: "stopped",
          sessionId,
          hypothesisId: hypothesis.id,
          phase: "failed",
          event: "worker_failed",
          progressMessage: message.slice(0, 1000),
          gitLabel: resultCommitSha ?? null,
          metadata: launchManifest
            ? {
                workerLogPath: launchManifest.logPath,
                workerPromptPath: launchManifest.promptPath,
                lastOutputAt: launchManifest.lastOutputAt,
                launcher: launchManifest.agentKind,
              }
            : undefined,
        },
        args
      ).catch(() => {})
    }
    await upsertCampaignSummary(
      campaign.id,
      {
        sessionId,
        hypothesisId: hypothesis.id,
        authoredByWorkerId: workerId,
        summaryKind: "hypothesis_summary",
        title: `${hypothesis.name} failed`,
        body: launchManifest
          ? `${message}\n\nWorker log: ${launchManifest.logPath}`
          : message,
      },
      args
    ).catch(() => {})
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
  const { setup } = await assertLocalSetupReady(root, projectPath)
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
  const result = await createCampaignSession(
    campaign.id,
    {
      name: args.options.name ?? `research-${new Date().toISOString()}`,
      workerTarget,
      hypotheses,
      metadata: {
        startedBy: "onyx-research",
        maxIterations,
        maxMinutes,
        agentKind: launchAgent ?? "codex",
      },
    },
    args
  )
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

  await Promise.all(
    result.hypotheses.map(async (hypothesis) => {
      const [briefPath, sessionStatePath] = await Promise.all([
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
      await writeWorkerPrompt({
        root,
        projectPath,
        campaign,
        setup,
        sessionId: result.session.id,
        hypothesis,
        workerBranch: "assigned when worker starts",
        briefPath,
        sessionStatePath,
        maxIterations,
        endTimeMs,
      })
    })
  )

  console.log(`Research session: ${result.session.id}`)
  console.log(`Campaign: ${campaign.name}`)
  console.log(`Workers: 0/${workerTarget}`)
  console.log(`Hypotheses: ${result.hypotheses.length}`)
  const agentOption = launchAgent ? ` --agent ${launchAgent}` : ""
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
        `- worker ${index + 1}: ${hypothesis.name}: ${hypothesis.plan.focus}\n  onyx worker run --session ${result.session.id} --hypothesis ${hypothesis.id}${agentOption}`
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

  const plan = await hypothesisPlanOption(args)
  const before = sessionId
    ? await getResearchSessionState(sessionId, args)
    : null
  const campaign =
    before?.campaign ?? (await campaignForName(root, args)).campaign
  const { setup } = await assertLocalSetupReady(root, projectPath)
  const sessionMetadata = before?.session.metadata ?? {}
  const agentKind =
    args.options.agent ??
    (typeof sessionMetadata.agentKind === "string"
      ? sessionMetadata.agentKind
      : "codex")
  if (agentKind !== "codex" && agentKind !== "claude") {
    throw new Error("--agent must be codex or claude")
  }
  const result = await createCampaignHypothesis(
    campaign.id,
    {
      plan,
      name: args.options.name,
      description: args.options.description,
      baseCommitSha: args.options.base,
      metadata: {
        createdBy: "onyx-research",
        ...(sessionId ? { createdBySessionId: sessionId } : {}),
      },
    },
    args
  )

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
  const key = campaignStateKey(projectPath, campaign.name)
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    ...(sessionId ? { sessionId } : {}),
  }
  await writeState(root, state)

  const hypothesis = result.hypothesis
  if (sessionId) {
    const [briefPath, sessionStatePath] = await Promise.all([
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
    await writeWorkerPrompt({
      root,
      projectPath,
      campaign,
      setup,
      sessionId,
      hypothesis,
      workerBranch: "assigned when worker starts",
      briefPath,
      sessionStatePath,
      maxIterations,
      endTimeMs,
    })
  }

  console.log(`Research hypothesis: ${hypothesis.id}`)
  if (sessionId) console.log(`Session: ${sessionId}`)
  console.log(`Hypothesis: ${hypothesis.name}: ${hypothesis.plan.focus}`)
  if (sessionId) {
    console.log(
      `onyx worker run --session ${sessionId} --hypothesis ${hypothesis.id} --agent ${agentKind}`
    )
  } else {
    console.log("Start or choose a research session before launching a worker.")
  }
}

export async function commandResearchStatus(args: Args) {
  const root = await repoRoot()
  const { campaign } = await campaignForName(root, args)
  await reconcileCampaign(campaign.id, args).catch(() => {})
  const overview = await getCampaignOverview(campaign.id, args)
  const state = await readState(root)
  const projectPath = await resolveProjectPath(root, args)
  console.log(`campaign: ${campaign.name}`)
  console.log(`setup: local onyx/setup.json`)
  const activeSessionId =
    state.campaigns?.[campaignStateKey(projectPath, campaign.name)]?.sessionId
  if (activeSessionId) {
    console.log(
      `session: ${activeSessionId} ${state.sessions?.[activeSessionId]?.status ?? ""}`.trim()
    )
  }
  const scopeAll = args.options["all-sessions"] === "true"
  const hypotheses = overview.hypotheses
  const workers =
    activeSessionId && !scopeAll
      ? overview.workers.filter(
          (worker) => worker.sessionId === activeSessionId
        )
      : overview.workers
  const manifests = activeSessionId
    ? await readWorkerLaunchManifests(root, activeSessionId)
    : []
  const manifestByWorker = new Map(
    manifests.map((manifest) => [manifest.workerId, manifest])
  )

  if (activeSessionId) {
    const sessionState = await getResearchSessionState(
      activeSessionId,
      args
    ).catch(() => null)
    const activeWorkers = workers.filter((worker) =>
      ["idle", "running", "stale"].includes(worker.status)
    ).length
    const target = sessionState?.session.workerTarget ?? "?"
    console.log(`worker slots: ${activeWorkers}/${target}`)
  }
  console.log(
    `hypotheses: ${hypotheses.length}${scopeAll ? " (all sessions)" : ""}`
  )
  for (const hypothesis of hypotheses) {
    const relatedWorkers = workers.filter(
      (worker) => worker.hypothesisId === hypothesis.id
    )
    const activeWorkerCount = relatedWorkers.filter((worker) =>
      ["idle", "running", "stale"].includes(worker.status)
    ).length
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
  const metricName = setup?.metric.name ?? "target_metric"
  const direction =
    setup?.metric.direction === "maximize"
      ? "increase"
      : setup?.metric.direction === "minimize"
        ? "decrease"
        : "improve"
  const scope = setup?.editableScope.length
    ? setup.editableScope
    : [setup?.projectPath || projectPath || "."]
  const protectedPaths = setup?.protectedPaths.length
    ? setup.protectedPaths
    : [
        "onyx/setup.json",
        "onyx/validation.json",
        "onyx/onyx.md",
        "onyx/eval.sh",
        "onyx/checks.sh",
        "onyx/tools/*",
      ]
  const constraints = setup?.constraints.length
    ? setup.constraints
    : ["Preserve the declared eval path and protected setup files."]
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
      successSignals: [
        `METRIC ${metricName} moves in the desired direction.`,
        "Required setup validation and runtime checks remain passing.",
      ],
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
      giveUpSignals: [
        "The hypothesis requires edits outside the declared scope.",
        "Repeated measured attempts fail to move the primary metric.",
      ],
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
    process.exitCode = 1
    return
  }

  const localSession = state.sessions?.[sessionId]
  const iteration =
    args.options.iteration === undefined ? null : Number(args.options.iteration)
  const reasons: string[] = []
  if (localSession?.stopRequested) reasons.push("stop requested")
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
  process.exitCode = shouldStop ? 0 : 1
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
    await reconcileCampaign(campaignId, args).catch(() => {})
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
  const { campaign } = await campaignForName(root, args)
  await reconcileCampaign(campaign.id, args).catch(() => {})
  await flushOutbox(root, args, { quiet: true }).catch(() => {})
  const overview = await getCampaignOverview(campaign.id, args)

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
  await upsertCampaignSummary(
    campaign.id,
    {
      sessionId,
      summaryKind: "campaign_brief",
      title: `${campaign.name} final results`,
      body,
    },
    args
  ).catch(() => {})
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
  console.log(body)
}

export async function commandSummaryUpsert(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const kind = args.options.kind ?? "hypothesis_summary"
  if (
    kind !== "campaign_brief" &&
    kind !== "session_brief" &&
    kind !== "hypothesis_summary" &&
    kind !== "transfer_brief" &&
    kind !== "setup_notes"
  ) {
    throw new Error(
      "--kind must be campaign_brief, session_brief, hypothesis_summary, transfer_brief, or setup_notes"
    )
  }
  const title = args.options.title ?? `${kind} ${new Date().toISOString()}`
  const body = args.options.body
  if (!body) throw new Error("Pass --body <text>.")
  await upsertCampaignSummary(
    campaign.id,
    {
      sessionId: args.options.session ?? process.env.ONYX_SESSION_ID,
      hypothesisId: args.options.hypothesis ?? process.env.ONYX_HYPOTHESIS_ID,
      authoredByWorkerId:
        args.options.worker ?? process.env.ONYX_WORKER_ID ?? undefined,
      summaryKind: kind,
      title,
      body,
    },
    args
  )
  console.log(`Updated ${kind} for ${campaign.name}`)
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

  await createCampaignKnowledge(
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
  console.log(`Added ${kind} knowledge for ${campaign.name}`)
}

export async function commandKnowledgeList(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const limit = positiveIntegerOption(args, "limit", 50)
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

  const sessionState = await getResearchSessionState(sessionId, args)
  if (sessionState.session.status !== "running") {
    throw new Error(
      `Research session ${sessionId} is ${sessionState.session.status}; cannot start a new worker.`
    )
  }
  const campaign = sessionState.campaign
  const { setup } = await assertLocalSetupReady(root, projectPath)

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
    syncSupervisor,
    args,
  })
  const pending = await syncSupervisor.drain(finalSyncTimeoutMs)
  if (result.status === "failed") {
    throw new Error(
      `Worker failed for ${hypothesis.name}: ${result.error ?? "unknown error"}`
    )
  }
  console.log(
    `Worker completed ${hypothesis.name} at ${result.resultCommitSha ?? "unknown"}; ${pending} sync record(s) pending.`
  )
}
