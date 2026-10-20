import { assertWslResearchEnvironment } from "../lib/git"
import {
  deliveryDestination,
  initialReportBody,
  preserveResultRef,
  withAttemptDeliveryOwner,
  pushAttemptRef,
  acknowledgeReport,
} from "../lib/report-delivery"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type {
  LocalResearchCampaignExperimentLoggedRecord,
  LocalResearchHistoryRecord,
} from "../protocol"

import {
  getCampaignOverview,
  listCampaignExperiments,
  listProjectCampaigns,
  reportCampaignExperiment,
  reportWorkerExperiment,
  listWorkerExperiments,
  resolveProject,
  type ApiCampaign,
} from "../lib/api"
import { descriptionOption, optionalFlag, type Args } from "../lib/args"
import {
  normalizeSetupFile,
  readSetupFile,
  setupHash,
  type ResearchSetupFile,
  type ResearchSetupWorkflowStep,
} from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, git, gitResult, repoRoot } from "../lib/git"
import { apiExperimentToHistory } from "../lib/history"
import { parseWorkflowMetricLines, summarizeOutput } from "../lib/metrics"
import { collectLocalResearchStopReasons } from "../lib/research-stop"
import {
  clientRunRef,
  type CachedAttemptRecord,
  type CachedAttemptSelector,
} from "../lib/local-attempt-cache"
import {
  onyxStateDir,
  readState,
  withOnyxLock,
  writeState,
} from "../lib/runtime-state"
import { campaignStateKey, resolveProjectPath } from "../lib/project"
import { getWorkerRuntimeContextCached } from "../lib/worker-context"
import { recordWorkerReportedExperiment } from "../lib/worker-reports"
import {
  abandonBlockedWorkflowRunsForSession,
  isHardwareQueueRun,
  listWorkflowSteps,
  listLocalAttempts,
  listWorkflowRuns,
  readWorkflowRun,
  upsertWorkflowRun,
  upsertWorkflowStep,
  writeLocalAttempt,
  type LocalHardwareJob,
  type LocalWorkflowRun,
  type LocalWorkflowRunStatus,
  type LocalWorkflowSimResult,
  type LocalWorkflowStep,
} from "../lib/research-runtime"
import { readSimConfigFromCommit, type SimConfig } from "../lib/sim-config"
import { renderExperimentTable } from "../lib/tui"
import {
  acquireNamedResources,
  runToolCommand,
  ToolProtectionUncertainError,
  type ToolRunResult,
} from "../lib/tools"
import {
  resolveCampaignNameFromContext,
  resolveWorkerWorkflowContext,
  type WorkerWorkflowContext,
} from "../lib/workflow-context"

type ExperimentStatus = LocalResearchCampaignExperimentLoggedRecord["status"]
type ChecksRecord = NonNullable<
  LocalResearchCampaignExperimentLoggedRecord["checks"]
>
const ACTIVE_WORKFLOW_STATUSES: LocalWorkflowRunStatus[] = ["running", "paused"]

function numberOption(args: Args, name: string, fallback: number) {
  const value = args.options[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive number`)
  }
  return parsed
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function validateStatus(value: string): ExperimentStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "checks_failed" ||
    value === "setup_violation"
  ) {
    return value
  }

  throw new Error(
    "--status must be queued, running, succeeded, failed, checks_failed, or setup_violation"
  )
}

function parseAgentNotes(value?: string): Record<string, unknown> {
  if (!value) return {}

  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through to plain-text notes
  }

  return { note: value }
}

function safeRefSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._/-]+/g, "-")
}

function lastRunSelectorForContext({
  campaignName,
  projectPath,
  runRef,
  sessionId,
  workerId,
  hypothesisId,
}: {
  campaignName: string
  projectPath: string
  runRef?: string
  sessionId?: string
  workerId?: string
  hypothesisId?: string
}): CachedAttemptSelector {
  const selector: CachedAttemptSelector = { campaignName, projectPath }
  if (runRef) {
    selector.runRef = runRef
    return selector
  }
  if (sessionId) selector.sessionId = sessionId
  if (workerId) selector.workerId = workerId
  if (hypothesisId) selector.hypothesisId = hypothesisId
  if (!sessionId && !workerId && !hypothesisId) selector.unscopedOnly = true
  return selector
}

function pathMatchesScope(path: string, scope: string) {
  const normalized = scope.replace(/^\/+|\/+$/g, "")
  if (!normalized) return true
  return path === normalized || path.startsWith(`${normalized}/`)
}

function stripProjectScope(path: string, projectPath: string) {
  if (!projectPath) return path
  if (path === projectPath) return ""
  if (path.startsWith(`${projectPath}/`)) {
    return path.slice(projectPath.length + 1)
  }
  return path
}

async function changedProjectPaths({
  root,
  projectPath,
  baseCommitSha,
  resultCommitSha,
}: {
  root: string
  projectPath: string
  baseCommitSha: string
  resultCommitSha: string
}) {
  const output = await git(
    ["diff", "--name-only", `${baseCommitSha}..${resultCommitSha}`],
    root
  )
  return Array.from(
    new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((path) => stripProjectScope(path, projectPath))
    )
  ).sort()
}

function setupCompliance({
  setup,
  changedPaths,
  sim = null,
}: {
  setup: ResearchSetupFile
  changedPaths: string[]
  /** Simulator sources are protected like the setup surface. */
  sim?: SimConfig | null
}): LocalResearchCampaignExperimentLoggedRecord["setupCompliance"] {
  const defaultProtected = [
    "onyx/onyx.md",
    "onyx/setup.json",
    "onyx/validation.json",
    "onyx/sandbox.json",
    "onyx/sim.json",
    "onyx/tools",
  ]
  const protectedPaths = [
    ...defaultProtected,
    ...setup.scope.protected,
    ...(sim?.paths ?? []),
  ]
  const protectedPathsChanged = changedPaths.filter((path) =>
    protectedPaths.some((scope) => pathMatchesScope(path, scope))
  )
  const outOfScopePathsChanged =
    setup.scope.editable.length === 0
      ? []
      : changedPaths.filter(
          (path) =>
            !setup.scope.editable.some((scope) => pathMatchesScope(path, scope))
        )
  const setupPathsChanged = changedPaths.filter((path) =>
    defaultProtected.some((scope) => pathMatchesScope(path, scope))
  )
  const violated =
    protectedPathsChanged.length > 0 || outOfScopePathsChanged.length > 0

  return {
    status: violated ? "setup_violation" : "passed",
    protectedPathsChanged,
    outOfScopePathsChanged,
    setupPathsChanged,
    notes: violated
      ? "Local diff changed protected or out-of-scope paths under the local setup policy."
      : null,
  }
}

async function resolveCampaignName(root: string, args: Args) {
  return resolveCampaignNameFromContext(root, args)
}

async function ensureCampaignMetadata({
  root,
  args,
  projectPath,
  campaignName,
}: {
  root: string
  args: Args
  projectPath: string
  campaignName: string
}) {
  const workerContext = await getWorkerRuntimeContextCached()
  if (workerContext) {
    // Supervised workers are pinned to one campaign and one assignment base;
    // shared convenience state and team-key campaign lookups stay untouched.
    if (campaignName !== workerContext.campaignName) {
      throw new Error(
        `Worker ${workerContext.workerId} is scoped to campaign ${workerContext.campaignName}, not ${campaignName}.`
      )
    }
    return {
      campaignId: workerContext.campaignId,
      hypothesisId: workerContext.hypothesisId as string | undefined,
      metricName: workerContext.campaign.metricName,
      baseCommitSha: workerContext.assignment.startingCommitSha,
    }
  }

  const state = await readState(root)
  const key = campaignStateKey(projectPath, campaignName)
  const cached = state.campaigns?.[key]
  if (cached?.campaignId && cached.metricName && cached.baseCommitSha) {
    return {
      campaignId: cached.campaignId,
      hypothesisId: cached.hypothesisId,
      metricName: cached.metricName,
      baseCommitSha: cached.baseCommitSha,
    }
  }

  const project = await resolveProject(root, args)
  const campaigns = await listProjectCampaigns(project.id, args)
  const campaign = campaigns.find(
    (candidate) => candidate.name === campaignName
  )
  if (!campaign) {
    throw new Error(
      `Campaign ${campaignName} was not found in the Onyx API. Run \`onyx campaign setup --name ${campaignName}\` after creating onyx/setup.json.`
    )
  }

  state.projectId = project.id
  state.projectPath = projectPath
  state.activeCampaign = campaignName
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    projectPath,
    baseCommitSha: campaign.createdFromCommitSha ?? (await currentCommit(root)),
    description: campaign.description,
    metricName: campaign.metricName,
    metricUnit: campaign.metricUnit,
    metricDirection: campaign.metricDirection,
    promotionRefName: campaign.promotionRefName,
  }
  await writeState(root, state)

  return {
    campaignId: campaign.id,
    hypothesisId: state.campaigns[key]?.hypothesisId,
    metricName: campaign.metricName,
    baseCommitSha: campaign.createdFromCommitSha ?? (await currentCommit(root)),
  }
}

function workflowMode(args: Args) {
  if (optionalFlag(args, "auto") && optionalFlag(args, "next")) {
    throw new Error("Use only one of --auto or --next")
  }
  return optionalFlag(args, "next") ? "next" : "auto"
}

async function readSetupFileFromCommit({
  root,
  projectPath,
  commitSha,
}: {
  root: string
  projectPath: string
  commitSha: string
}) {
  const path = [projectPath, "onyx", "setup.json"].filter(Boolean).join("/")
  const text = await git(["show", `${commitSha}:${path}`], root)
  return normalizeSetupFile(JSON.parse(text))
}

async function gitStatus(root: string) {
  return (await git(["status", "--porcelain"], root)).trim()
}

function workflowRunLine(run: LocalWorkflowRun) {
  return `- ${run.id}: ${run.status}, runRef ${run.runRef}, worker ${run.workerId ?? "none"}, hypothesis ${run.hypothesisId ?? "none"}`
}

function localAttemptLine(record: CachedAttemptRecord) {
  return `- ${record.runRef}: ${record.status}, worker ${record.workerId ?? "none"}, hypothesis ${record.hypothesisId ?? "none"}, result ${record.resultCommitSha}`
}

function candidateLines<T>(items: T[], format: (item: T) => string) {
  return items.length > 0 ? `\n${items.map(format).join("\n")}` : ""
}

function workerWorkflowSelector({
  campaignName,
  projectPath,
  context,
  statuses,
}: {
  campaignName: string
  projectPath: string
  context: WorkerWorkflowContext
  statuses: LocalWorkflowRunStatus[]
}) {
  if (!context.workerId) {
    throw new Error(
      "Cannot infer a workflow run without worker context. Pass --resume <workflowRunId>."
    )
  }
  return {
    campaignName,
    projectPath,
    sessionId: context.sessionId,
    workerId: context.workerId,
    hypothesisId: context.hypothesisId,
    statuses,
  }
}

async function resolveAutoResumeWorkflowRun({
  root,
  args,
  projectPath,
}: {
  root: string
  args: Args
  projectPath: string
}) {
  const context = await resolveWorkerWorkflowContext(args)
  const campaignName = await resolveCampaignName(root, args)
  const candidates = (
    await listWorkflowRuns(
      root,
      workerWorkflowSelector({
        campaignName,
        projectPath,
        context,
        statuses: ACTIVE_WORKFLOW_STATUSES,
      })
    )
  ).filter((candidate) => !isHardwareQueueRun(candidate))
  if (candidates.length !== 1) {
    throw new Error(
      [
        `Cannot infer workflow to resume for worker ${context.workerId}: found ${candidates.length} active workflow runs.`,
        "Pass --resume <workflowRunId> to choose explicitly.",
        candidateLines(candidates, workflowRunLine),
      ]
        .filter(Boolean)
        .join("\n")
    )
  }
  return candidates[0]!
}

export async function resolveFreshBaseCommitSha({
  root,
  args,
  campaign,
  context,
}: {
  root: string
  args: Args
  campaign: Awaited<ReturnType<typeof ensureCampaignMetadata>>
  context: WorkerWorkflowContext
}) {
  const workerContext = await getWorkerRuntimeContextCached()
  if (workerContext) {
    let base = args.options.base
    if (!base) {
      const dirty = await gitStatus(root)
      if (dirty) {
        throw new Error(
          "Worker-context `onyx exp run` requires a clean git tree before opening a measured workflow."
        )
      }
      base = await currentCommit(root)
    }
    await assertWorkerBaseLineage({
      root,
      startingCommitSha: workerContext.assignment.startingCommitSha,
      base,
    })
    return base
  }
  if (args.options.base) return args.options.base
  if (context.workerId) {
    const dirty = await gitStatus(root)
    if (dirty) {
      throw new Error(
        "Worker-context `onyx exp run` requires a clean git tree before opening a measured workflow."
      )
    }
    return currentCommit(root)
  }
  return process.env.ONYX_BASE_COMMIT ?? campaign.baseCommitSha
}

/** Worker attempts must build on the assignment starting commit (equal counts
 * as descent, so iterative commit -> run loops keep working). */
async function assertWorkerBaseLineage({
  root,
  startingCommitSha,
  base,
}: {
  root: string
  startingCommitSha: string
  base: string
}) {
  const result = await gitResult(
    ["merge-base", "--is-ancestor", startingCommitSha, base],
    root
  )
  if (result.code !== 0) {
    throw new Error(
      `Worker base commit ${base} must descend from the assignment starting commit ${startingCommitSha}. Reset the worktree onto the assignment base before running experiments.`
    )
  }
}

async function assertWorkerCanStartFreshWorkflow({
  root,
  campaignName,
  projectPath,
  context,
}: {
  root: string
  campaignName: string
  projectPath: string
  context: WorkerWorkflowContext
}) {
  if (!context.workerId) return
  if (context.sessionId) {
    const stopCheck = await collectLocalResearchStopReasons({
      root,
      sessionId: context.sessionId,
      researchDeadlineAt: context.researchDeadlineAt ?? null,
    })
    if (stopCheck.shouldStop) {
      throw new Error(
        [
          `Session stop condition reached; worker ${context.workerId} will not start a new workflow.`,
          `Reasons: ${stopCheck.reasons.join(", ") || stopCheck.reasonCodes.join(", ")}`,
          "Exit cleanly after logging any terminal attempt already in progress.",
        ].join("\n")
      )
    }
  }
  // Runs handed to the hardware queue belong to the supervisor now; the
  // worker may start its next idea while they wait.
  const active = (
    await listWorkflowRuns(root, {
      campaignName,
      projectPath,
      sessionId: context.sessionId,
      workerId: context.workerId,
      statuses: ACTIVE_WORKFLOW_STATUSES,
    })
  ).filter((run) => !isHardwareQueueRun(run))
  if (active.length > 0) {
    throw new Error(
      [
        `Worker ${context.workerId} already has an active workflow run; resume it before starting another.`,
        candidateLines(active, workflowRunLine),
      ].join("\n")
    )
  }

  const attempts = (
    await listLocalAttempts(root, {
      campaignName,
      projectPath,
      sessionId: context.sessionId,
      workerId: context.workerId,
    })
  ).filter((attempt) => !attempt.hardwareJob)
  if (attempts.length > 0) {
    throw new Error(
      [
        `Worker ${context.workerId} has ${attempts.length} unlogged measured attempt(s); run \`onyx exp log\` before starting another workflow.`,
        candidateLines(attempts, localAttemptLine),
      ].join("\n")
    )
  }
}

async function resolveLocalAttemptForLog({
  root,
  campaignName,
  projectPath,
  runRef,
  context,
}: {
  root: string
  campaignName: string
  projectPath: string
  runRef?: string
  context: WorkerWorkflowContext
}) {
  if (runRef) {
    return (
      await listLocalAttempts(root, {
        runRef,
      })
    )[0]
  }

  if (context.workerId) {
    // Hardware-queue attempts are reported by the supervisor.
    const candidates = (
      await listLocalAttempts(root, {
        campaignName,
        projectPath,
        sessionId: context.sessionId,
        workerId: context.workerId,
        hypothesisId: context.hypothesisId,
      })
    ).filter((attempt) => !attempt.hardwareJob)
    if (candidates.length !== 1) {
      throw new Error(
        [
          `Cannot infer measured run for worker ${context.workerId}: found ${candidates.length} unlogged local attempts.`,
          "Pass --run-ref <ref> to choose explicitly.",
          candidateLines(candidates, localAttemptLine),
        ]
          .filter(Boolean)
          .join("\n")
      )
    }
    return candidates[0]
  }

  const candidates = await listLocalAttempts(
    root,
    lastRunSelectorForContext({
      campaignName,
      projectPath,
      sessionId: context.sessionId,
      hypothesisId: context.hypothesisId,
    })
  )
  if (candidates.length !== 1) {
    throw new Error(
      [
        `Cannot infer measured run: found ${candidates.length} unlogged local attempts.`,
        "Pass --run-ref <ref> to choose explicitly.",
        candidateLines(candidates, localAttemptLine),
      ]
        .filter(Boolean)
        .join("\n")
    )
  }
  return candidates[0]
}

async function commitCountBetween({
  root,
  baseCommitSha,
  headCommitSha,
}: {
  root: string
  baseCommitSha: string
  headCommitSha: string
}) {
  return Number(
    await git(
      ["rev-list", "--count", `${baseCommitSha}..${headCommitSha}`],
      root
    )
  )
}

function stepRecord({
  run,
  step,
  index,
  status,
  attempt = 0,
  result = null,
  metrics = {},
  logPath = null,
  outputSummary = null,
  startedAt = null,
}: {
  run: LocalWorkflowRun
  step: ResearchSetupWorkflowStep
  index: number
  status: LocalWorkflowStep["status"]
  attempt?: number
  result?: ToolRunResult | null
  metrics?: Record<string, number>
  logPath?: string | null
  outputSummary?: string | null
  startedAt?: string | null
}): LocalWorkflowStep {
  const now = new Date().toISOString()
  return {
    runId: run.id,
    stepId: step.id,
    stepIndex: index,
    kind: step.agent ? "agent" : "run",
    toolId: step.run ?? null,
    status,
    attempt,
    exitCode: result?.code ?? null,
    timedOut: result?.timedOut ?? false,
    outputSummary:
      outputSummary ??
      result?.outputSummary ??
      (result ? summarizeOutput(result.stdout, result.stderr) : null),
    metrics,
    logPath,
    startedAt: startedAt ?? (status === "running" ? now : null),
    completedAt:
      status === "passed" || status === "failed" || status === "skipped"
        ? now
        : null,
    updatedAt: now,
  }
}

async function writeWorkflowStepLog({
  root,
  run,
  step,
  result,
}: {
  root: string
  run: LocalWorkflowRun
  step: ResearchSetupWorkflowStep
  result: ToolRunResult
}) {
  const dir = join(await onyxStateDir(root), "workflow-runs", run.id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${encodeURIComponent(step.id)}.log`)
  await writeFile(
    path,
    [
      `# workflow run: ${run.id}`,
      `# step: ${step.id}`,
      `# tool: ${step.run ?? ""}`,
      `# exitCode: ${result.code ?? "null"}`,
      `# timedOut: ${result.timedOut}`,
      "",
      "## stdout",
      result.stdout,
      "",
      "## stderr",
      result.stderr,
      "",
    ].join("\n"),
    "utf8"
  )
  return path
}

function checksRecordForSteps(
  setup: ResearchSetupFile,
  steps: LocalWorkflowStep[]
): ChecksRecord | null {
  const guardrailIds = new Set(
    setup.workflow
      .filter((step) => step.guardrail && !step.optional)
      .map((step) => step.id)
  )
  const guardrailSteps = steps.filter((step) => guardrailIds.has(step.stepId))
  if (guardrailSteps.length === 0) return null
  const failed = guardrailSteps.find((step) => step.status === "failed")
  if (failed) {
    return {
      status: failed.timedOut ? "timed_out" : "failed",
      durationMs: null,
      outputSummary: failed.outputSummary,
    }
  }
  return {
    status: "passed",
    durationMs: null,
    outputSummary: guardrailSteps
      .map((step) => step.outputSummary)
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000),
  }
}

async function setWorkflowBlocked({
  root,
  run,
  reason,
  currentStepIndex = run.currentStepIndex,
}: {
  root: string
  run: LocalWorkflowRun
  reason: string
  currentStepIndex?: number
}) {
  const next = {
    ...run,
    status: "blocked" as const,
    currentStepIndex,
    blockReason: reason,
  }
  await upsertWorkflowRun({ root, run: next })
  console.error(reason)
  process.exitCode = 1
  return next
}

async function writeTerminalAttempt({
  root,
  run,
  setup,
  status,
  outputSummary,
  checks,
  sim = null,
}: {
  root: string
  run: LocalWorkflowRun
  setup: ResearchSetupFile
  status: ExperimentStatus
  outputSummary: string | null
  checks: ChecksRecord | null
  sim?: SimConfig | null
}) {
  const resultCommitSha = run.resultCommitSha
  if (!resultCommitSha) {
    throw new Error(
      "Workflow cannot finish before a result commit is selected."
    )
  }
  const completed = new Date()
  const compliance = setupCompliance({
    setup,
    sim,
    changedPaths: await changedProjectPaths({
      root,
      projectPath: run.projectPath,
      baseCommitSha: run.baseCommitSha,
      resultCommitSha,
    }),
  })
  const finalStatus =
    compliance.status === "setup_violation" ? "setup_violation" : status
  const record: CachedAttemptRecord = {
    schemaVersion: 1,
    createdAt: completed.toISOString(),
    runRef: run.runRef,
    campaignName: run.campaignName,
    projectPath: run.projectPath,
    baseCommitSha: run.baseCommitSha,
    resultCommitSha,
    resultRef: run.resultRef,
    status: finalStatus,
    setupCompliance: compliance,
    primaryMetricName: setup.metric.name,
    primaryMetricValue: run.metrics[setup.metric.name] ?? null,
    metrics: run.metrics,
    agentNotes: {},
    checks,
    durationMs: completed.getTime() - new Date(run.startedAt).getTime(),
    startedAt: run.startedAt,
    completedAt: completed.toISOString(),
    outputSummary,
    sessionId: run.sessionId,
    workerId: run.workerId,
    hypothesisId: run.hypothesisId,
    ...(run.hardware ? { hardwareJob: true } : {}),
  }
  const workerContext = await getWorkerRuntimeContextCached()
  const destination =
    run.deliveryDestination ?? workerContext?.deliveryDestination
  if (destination && (run.assignmentId ?? workerContext?.assignmentId)) {
    record.delivery = {
      version: 1,
      destination,
      body: initialReportBody(
        record,
        run.assignmentId ?? workerContext?.assignmentId
      ),
      sealed: false,
      attempts: 0,
      nextAttemptAt: Date.now() + 30_000,
      state: "pending",
    }
  }
  await writeLocalAttempt({ root, record })
  await preserveResultRef(root, resultCommitSha, run.resultRef)
  const workflowStatus = finalStatus as LocalWorkflowRun["status"]
  const terminalRun = {
    ...run,
    status: workflowStatus,
    completedAt: completed.toISOString(),
    blockReason: null,
  }
  await upsertWorkflowRun({ root, run: terminalRun })
  await emitEvent(root, {
    type: "run_finished",
    campaignName: run.campaignName,
    campaignId: run.campaignId ?? undefined,
    runRef: run.runRef,
    commitSha: resultCommitSha,
    resultRef: run.resultRef,
    message: finalStatus,
  })
  console.log(
    `Workflow complete: ${finalStatus} (${setup.metric.name}=${record.primaryMetricValue ?? "null"})`
  )
  if (!run.hardware)
    console.log(
      `Run \`onyx exp log --campaign ${run.campaignName} --description <text>\` to record this result.`
    )
  if (finalStatus !== "succeeded") process.exitCode = 1
  return {
    workflowRunId: run.id,
    runRef: run.runRef,
    status: finalStatus,
    metrics: run.metrics,
    checks,
    compliance,
  }
}

async function createWorkflowRun({
  root,
  args,
  campaignName,
  campaign,
  projectPath,
  setup,
  baseCommitSha,
}: {
  root: string
  args: Args
  campaignName: string
  campaign: Awaited<ReturnType<typeof ensureCampaignMetadata>>
  projectPath: string
  setup: ResearchSetupFile
  baseCommitSha: string
}) {
  const started = new Date().toISOString()
  const runRef = clientRunRef(campaignName)
  const workflowContext = await resolveWorkerWorkflowContext(args)
  const sessionId = workflowContext.sessionId
  const workerId = workflowContext.workerId
  const hypothesisId = workflowContext.hypothesisId ?? campaign.hypothesisId
  await assertWorkerCanStartFreshWorkflow({
    root,
    campaignName,
    projectPath,
    context: { ...workflowContext, hypothesisId },
  })
  if (sessionId && (workerId || hypothesisId)) {
    const blockedWorkflowHypothesisId = workerId ? null : hypothesisId
    await abandonBlockedWorkflowRunsForSession({
      root,
      sessionId,
      workerId,
      hypothesisId: blockedWorkflowHypothesisId,
      reason: "A new workflow run superseded this blocked workflow attempt.",
    }).catch(() => [])
  }
  const runtimeContext = await getWorkerRuntimeContextCached()
  const run: LocalWorkflowRun = {
    deliveryDestination:
      runtimeContext?.deliveryDestination ??
      (await deliveryDestination(
        campaign.campaignId,
        (await resolveProject(root, args)).id,
        args
      )),
    assignmentId: runtimeContext?.assignmentId ?? args.options.assignment,
    id: randomUUID(),
    campaignId: campaign.campaignId,
    campaignName,
    projectPath,
    runRef,
    baseCommitSha,
    resultCommitSha: null,
    resultRef: `refs/onyx/experiments/${campaign.campaignId}/${safeRefSegment(runRef)}`,
    setupHash: setupHash(setup),
    status: "running",
    currentStepIndex: 0,
    metrics: {},
    blockReason: null,
    createdAt: started,
    startedAt: started,
    completedAt: null,
    updatedAt: started,
    sessionId,
    workerId,
    hypothesisId,
  }
  await upsertWorkflowRun({ root, run })
  for (const [index, step] of setup.workflow.entries()) {
    await upsertWorkflowStep({
      root,
      step: stepRecord({ run, step, index, status: "pending" }),
    })
  }
  await emitEvent(root, {
    type: "exp_run_started",
    campaignName,
    campaignId: campaign.campaignId,
    runRef,
    commitSha: await currentCommit(root),
    resultRef: run.resultRef,
  })
  return run
}

/**
 * One lease over every shared resource the rest of the workflow uses. It is
 * taken before the first step that needs hardware and held until the
 * experiment ends, so no other experiment can touch the hardware between
 * this experiment's reset, measurement, and guardrail steps.
 */
type WorkflowLease = {
  release: (() => Promise<void>) | null
  resources: string[]
  /** A tool could not be proven stopped: keep the lease for idle reset. */
  uncertain: boolean
}

type WorkflowExecutionOptions = {
  /** Simulation gate in front of the command steps (from onyx/sim.json). */
  sim?: SimConfig | null
  /** Sim-passed runs queue for the supervisor's hardware queue instead of
   * running their command steps in this process. */
  queueMode?: boolean
  /** This process is the supervisor's hardware job for a queued run. */
  hardwareJob?: boolean
  /** Tool sandbox policy for this job (the hardware job's own policy). */
  sandboxPolicyPath?: string | null
  /** Extra environment for workflow tools. */
  toolEnv?: NodeJS.ProcessEnv
  /** Report fields to attach when the run queues for hardware. */
  report?: Pick<LocalHardwareJob, "name" | "description" | "agentNotes">
  lease?: WorkflowLease
}

async function executeWorkflow(input: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
  run: LocalWorkflowRun
  args: Args
  mode: "auto" | "next"
  options?: WorkflowExecutionOptions
}) {
  const lease: WorkflowLease = input.options?.lease ?? {
    release: null,
    resources: [],
    uncertain: false,
  }
  try {
    return await executeWorkflowSteps({
      ...input,
      options: { ...input.options, lease },
    })
  } catch (error) {
    if (error instanceof ToolProtectionUncertainError) lease.uncertain = true
    throw error
  } finally {
    if (!input.options?.lease && lease.release && !lease.uncertain) {
      await lease.release()
    }
  }
}

async function holdWorkflowLease({
  root,
  setup,
  stepIndex,
  lease,
}: {
  root: string
  setup: ResearchSetupFile
  stepIndex: number
  lease: WorkflowLease
}) {
  const step = setup.workflow[stepIndex]
  const needed = step?.run ? (setup.tools[step.run]?.resources ?? []) : []
  if (needed.every((resource) => lease.resources.includes(resource))) return
  const remainingTools = setup.workflow
    .slice(stepIndex)
    .flatMap((item) => (item.run && setup.tools[item.run] ? [item.run] : []))
    .map((id) => setup.tools[id]!)
    .filter((tool) => tool.resources.length > 0)
  const wanted = [
    ...new Set(remainingTools.flatMap((tool) => tool.resources)),
  ].filter((resource) => !lease.resources.includes(resource))
  const timeoutMs =
    Math.max(...remainingTools.map((tool) => tool.leaseTimeoutSeconds)) * 1000
  const release = await acquireNamedResources({
    root,
    resources: setup.resources,
    resourceNames: wanted,
    timeoutMs,
  })
  const previous = lease.release
  lease.release = previous
    ? async () => {
        await release()
        await previous()
      }
    : release
  lease.resources = [...lease.resources, ...wanted].sort()
}

async function writeSimLog({
  root,
  run,
  result,
}: {
  root: string
  run: LocalWorkflowRun
  result: ToolRunResult
}) {
  const dir = join(await onyxStateDir(root), "workflow-runs", run.id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "sim.log")
  await writeFile(
    path,
    [
      `# workflow run: ${run.id}`,
      `# sim tool: ${result.commandName}`,
      `# exitCode: ${result.code ?? "null"}`,
      `# timedOut: ${result.timedOut}`,
      "",
      "## stdout",
      result.stdout,
      "",
      "## stderr",
      result.stderr,
      "",
    ].join("\n"),
    "utf8"
  )
  return path
}

/** Runs the simulator on the result commit. Results stay local. */
async function runSimGate({
  root,
  projectPath,
  setup,
  sim,
  run,
  head,
  sandboxPolicyPath,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
  sim: SimConfig
  run: LocalWorkflowRun
  head: string
  sandboxPolicyPath?: string | null
}): Promise<LocalWorkflowSimResult> {
  const checkedAt = new Date().toISOString()
  let result: ToolRunResult
  try {
    result = await runToolCommand({
      root,
      projectPath,
      name: sim.tool,
      sandboxPolicyPath,
    })
  } catch (error) {
    return {
      commitSha: head,
      status: "failed",
      exitCode: null,
      timedOut: false,
      metrics: {},
      outputSummary: `Simulator ${sim.tool} could not run: ${errorMessage(error)}`,
      logPath: null,
      checkedAt,
    }
  }
  const logPath = await writeSimLog({ root, run, result })
  const parsed = parseWorkflowMetricLines(result.stdout, setup.metric.name)
  const passed = !result.timedOut && result.code === 0
  return {
    commitSha: head,
    status: passed ? "passed" : "failed",
    exitCode: result.code,
    timedOut: result.timedOut,
    metrics: parsed.metrics,
    outputSummary:
      [
        result.timedOut ? "Simulator timed out." : "",
        result.outputSummary ?? summarizeOutput(result.stdout, result.stderr),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000) || null,
    logPath,
    checkedAt,
  }
}

function simMetricsLine(sim: LocalWorkflowSimResult) {
  const entries = Object.entries(sim.metrics)
  return entries.length > 0
    ? `Sim metrics: ${entries.map(([name, value]) => `${name}=${value}`).join(", ")}`
    : null
}

/** This worker's runs that are waiting for or running on hardware. */
async function workerHardwareRuns(
  root: string,
  run: Pick<LocalWorkflowRun, "sessionId" | "workerId">
) {
  if (!run.sessionId || !run.workerId) return []
  return (
    await listWorkflowRuns(root, {
      sessionId: run.sessionId,
      workerId: run.workerId,
      statuses: ["queued", "running"],
    })
  ).filter(isHardwareQueueRun)
}

/** Every run waiting for hardware in a session, oldest first. */
export async function listHardwareQueue(root: string, sessionId: string) {
  return (
    await listWorkflowRuns(root, { sessionId, statuses: ["queued"] })
  )
    .filter((run) => run.hardware && !run.hardware.startedAt)
    .sort(
      (left, right) =>
        left.hardware!.queuedAt.localeCompare(right.hardware!.queuedAt) ||
        left.id.localeCompare(right.id)
    )
}

/**
 * Puts a sim-passed run in line for hardware, unless this worker already has
 * its limit of experiments waiting. The result commit gets its immutable ref
 * now, so the worker can move on to its next idea right away.
 */
async function enqueueForHardware({
  root,
  run,
  sim,
  report,
}: {
  root: string
  run: LocalWorkflowRun
  sim: SimConfig
  report?: WorkflowExecutionOptions["report"]
}) {
  return withOnyxLock(root, "hardware-queue", async () => {
    const mine = (await workerHardwareRuns(root, run)).filter(
      (item) => item.id !== run.id
    )
    if (mine.length >= sim.maxQueuedPerWorker) {
      return { queued: false as const, waiting: mine.length }
    }
    await preserveResultRef(root, run.resultCommitSha!, run.resultRef)
    const queued: LocalWorkflowRun = {
      ...run,
      status: "queued",
      blockReason: null,
      hardware: {
        queuedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        name: report?.name ?? null,
        description: report?.description ?? null,
        agentNotes: report?.agentNotes ?? {},
        delivery: null,
        deliveryError: null,
        cancelReason: null,
      },
    }
    await upsertWorkflowRun({ root, run: queued })
    const line = run.sessionId ? await listHardwareQueue(root, run.sessionId) : []
    const position = line.findIndex((item) => item.id === run.id) + 1
    return {
      queued: true as const,
      run: queued,
      position,
      depth: line.length,
    }
  })
}

async function executeWorkflowSteps({
  root,
  projectPath,
  setup,
  run,
  args,
  mode,
  options,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
  run: LocalWorkflowRun
  args: Args
  mode: "auto" | "next"
  options: WorkflowExecutionOptions & { lease: WorkflowLease }
}): Promise<unknown> {
  let currentRun = run
  let advanced = false
  const firstCommandStepIndex = setup.workflow.findIndex((step) =>
    Boolean(step.run)
  )

  while (currentRun.currentStepIndex < setup.workflow.length) {
    const index = currentRun.currentStepIndex
    const step = setup.workflow[index]!
    const head = await currentCommit(root)
    const dirty = await gitStatus(root)
    const commitCount = await commitCountBetween({
      root,
      baseCommitSha: currentRun.baseCommitSha,
      headCommitSha: head,
    })

    if (step.agent) {
      if (dirty) {
        return setWorkflowBlocked({
          root,
          run: currentRun,
          reason:
            "Workflow agent step cannot complete while the git tree is dirty.",
        })
      }
      if (commitCount === 0) {
        const paused = {
          ...currentRun,
          status: "paused" as const,
          blockReason:
            "Paused at agent step. Make exactly one commit, then resume.",
        }
        await upsertWorkflowRun({ root, run: paused })
        await upsertWorkflowStep({
          root,
          step: stepRecord({ run: paused, step, index, status: "paused" }),
        })
        console.log(
          "Paused at agent step. Make exactly one commit, then resume."
        )
        return paused
      }
      if (commitCount !== 1) {
        return setWorkflowBlocked({
          root,
          run: currentRun,
          reason:
            "Workflow attempts must contain exactly one result commit over the base commit.",
        })
      }
      currentRun = {
        ...currentRun,
        status: "running",
        resultCommitSha: head,
        currentStepIndex: index + 1,
        blockReason: null,
      }
      await upsertWorkflowStep({
        root,
        step: stepRecord({ run: currentRun, step, index, status: "passed" }),
      })
      await upsertWorkflowRun({ root, run: currentRun })
      advanced = true
      if (mode === "next") return currentRun
      continue
    }

    if (dirty) {
      return setWorkflowBlocked({
        root,
        run: currentRun,
        reason: "Workflow command steps require a clean git tree.",
      })
    }
    if (commitCount !== 1) {
      return setWorkflowBlocked({
        root,
        run: currentRun,
        reason:
          "Workflow command steps require exactly one result commit over the base commit.",
      })
    }
    if (currentRun.resultCommitSha && currentRun.resultCommitSha !== head) {
      currentRun = {
        ...currentRun,
        resultCommitSha: head,
        currentStepIndex: index,
        metrics: {},
        blockReason: null,
      }
      await upsertWorkflowRun({ root, run: currentRun })
      for (const [resetIndex, resetStep] of setup.workflow.entries()) {
        if (resetIndex >= index && resetStep.run) {
          await upsertWorkflowStep({
            root,
            step: stepRecord({
              run: currentRun,
              step: resetStep,
              index: resetIndex,
              status: "pending",
            }),
          })
        }
      }
    } else if (!currentRun.resultCommitSha) {
      currentRun = { ...currentRun, resultCommitSha: head }
      await upsertWorkflowRun({ root, run: currentRun })
    }

    const compliance = setupCompliance({
      setup,
      sim: options.sim,
      changedPaths: await changedProjectPaths({
        root,
        projectPath,
        baseCommitSha: currentRun.baseCommitSha,
        resultCommitSha: head,
      }),
    })
    if (compliance.status === "setup_violation") {
      const terminalRun = {
        ...currentRun,
        status: "setup_violation" as const,
        blockReason: compliance.notes,
      }
      await upsertWorkflowRun({ root, run: terminalRun })
      return writeTerminalAttempt({
        root,
        run: terminalRun,
        setup,
        status: "setup_violation",
        outputSummary: compliance.notes,
        checks: null,
        sim: options.sim,
      })
    }

    if (options.sim && !options.hardwareJob) {
      if (
        currentRun.sim?.commitSha !== head ||
        currentRun.sim.status !== "passed"
      ) {
        const simResult = await runSimGate({
          root,
          projectPath,
          setup,
          sim: options.sim,
          run: currentRun,
          head,
          sandboxPolicyPath: options.sandboxPolicyPath,
        })
        currentRun = { ...currentRun, sim: simResult }
        await upsertWorkflowRun({ root, run: currentRun })
        await emitEvent(root, {
          type: "checks_finished",
          campaignName: currentRun.campaignName,
          campaignId: currentRun.campaignId ?? undefined,
          runRef: currentRun.runRef,
          commitSha: head,
          resultRef: currentRun.resultRef,
          message: `sim ${simResult.status}`,
        })
      }
      const simResult = currentRun.sim!
      if (simResult.status === "failed") {
        const agentIndex = setup.workflow.findIndex((item) => item.agent)
        const reason = [
          "Simulation failed; this commit cannot go to hardware. Simulation results are not campaign experiments.",
          simResult.outputSummary ? `Sim output:\n${simResult.outputSummary}` : null,
          simMetricsLine(simResult),
          simResult.logPath ? `Sim log: ${simResult.logPath}` : null,
          "Fix the change and `git commit --amend` (keep exactly one commit), or reset to the base and try another idea, then resume.",
        ]
          .filter(Boolean)
          .join("\n")
        const paused = {
          ...currentRun,
          status: "paused" as const,
          currentStepIndex: Math.max(0, agentIndex),
          blockReason: reason,
        }
        await upsertWorkflowRun({ root, run: paused })
        const agentStep = setup.workflow[Math.max(0, agentIndex)]
        if (agentStep) {
          await upsertWorkflowStep({
            root,
            step: stepRecord({
              run: paused,
              step: agentStep,
              index: Math.max(0, agentIndex),
              status: "paused",
            }),
          })
        }
        console.log(reason)
        process.exitCode = 1
        return paused
      }
      if (options.queueMode) {
        const queued = await enqueueForHardware({
          root,
          run: currentRun,
          sim: options.sim,
          report: options.report,
        })
        if (!queued.queued) {
          const reason = [
            `Simulation passed, but you already have ${queued.waiting} experiment(s) waiting for hardware (limit ${options.sim.maxQueuedPerWorker}).`,
            simMetricsLine(simResult),
            "Keep developing in simulation (`onyx-worker sim run` works on uncommitted changes), check `onyx-worker exp queue`, and resume this run once your earlier hardware result arrives.",
          ]
            .filter(Boolean)
            .join("\n")
          const paused = {
            ...currentRun,
            status: "paused" as const,
            blockReason: reason,
          }
          await upsertWorkflowRun({ root, run: paused })
          console.log(reason)
          return paused
        }
        console.log(
          [
            `Simulation passed. Queued for hardware: position ${queued.position} of ${queued.depth}.`,
            simMetricsLine(simResult),
            "The supervisor runs the hardware workflow and reports the result; do not run `exp log` for it.",
            "Start your next idea now with `onyx-worker exp run --auto` and develop it in simulation. Check `onyx-worker exp queue` for hardware results.",
          ]
            .filter(Boolean)
            .join("\n")
        )
        return {
          workflowRunId: queued.run.id,
          runRef: queued.run.runRef,
          status: "queued",
          queuePosition: queued.position,
          queueDepth: queued.depth,
          sim: simResult,
        }
      }
    }

    if ((setup.tools[step.run!]?.resources.length ?? 0) > 0) {
      await holdWorkflowLease({
        root,
        setup,
        stepIndex: index,
        lease: options.lease,
      })
    }

    const existingSteps = await listWorkflowSteps(root, currentRun.id)
    const existingStep = existingSteps.find((item) => item.stepId === step.id)
    const startedStep = stepRecord({
      run: currentRun,
      step,
      index,
      status: "running",
      attempt: (existingStep?.attempt ?? 0) + 1,
    })
    await upsertWorkflowStep({ root, step: startedStep })
    const timeoutSeconds = step.metric
      ? args.options.timeout
        ? numberOption(args, "timeout", 600)
        : undefined
      : step.guardrail && args.options["checks-timeout"]
        ? numberOption(args, "checks-timeout", 300)
        : undefined
    const result = await runToolCommand({
      root,
      projectPath,
      name: step.run!,
      timeoutSeconds,
      resourcesHeld: (setup.tools[step.run!]?.resources ?? []).every(
        (resource) => options.lease.resources.includes(resource)
      ),
      sandboxPolicyPath: options.sandboxPolicyPath,
      env: options.toolEnv,
    })
    const logPath = await writeWorkflowStepLog({
      root,
      run: currentRun,
      step,
      result,
    })
    const failed = result.timedOut || result.code !== 0
    let stepMetrics: Record<string, number> = {}
    let metricError: string | null = null
    if (step.metric) {
      const parsed = parseWorkflowMetricLines(result.stdout, setup.metric.name)
      stepMetrics = parsed.metrics
      metricError = parsed.error
    }
    const outputSummaryParts = [
      result.timedOut ? `Tool timed out.` : "",
      metricError ?? "",
      result.outputSummary ?? summarizeOutput(result.stdout, result.stderr),
    ].filter(Boolean)
    const outputSummary = outputSummaryParts.join("\n").slice(0, 4000) || null

    if (failed || metricError) {
      await upsertWorkflowStep({
        root,
        step: stepRecord({
          run: currentRun,
          step,
          index,
          status: "failed",
          attempt: startedStep.attempt,
          result,
          metrics: stepMetrics,
          logPath,
          outputSummary,
          startedAt: startedStep.startedAt,
        }),
      })
      if (step.optional) {
        currentRun = {
          ...currentRun,
          currentStepIndex: index + 1,
          blockReason: null,
        }
        await upsertWorkflowRun({ root, run: currentRun })
        advanced = true
        if (mode === "next") return currentRun
        continue
      }
      const terminalStatus: ExperimentStatus =
        step.guardrail && !step.metric ? "checks_failed" : "failed"
      const failedRun = {
        ...currentRun,
        status: terminalStatus,
        blockReason: outputSummary,
      }
      await upsertWorkflowRun({ root, run: failedRun })
      const steps = await listWorkflowSteps(root, failedRun.id)
      const checks: ChecksRecord | null =
        terminalStatus === "checks_failed"
          ? {
              status: result.timedOut ? "timed_out" : "failed",
              durationMs: null,
              outputSummary,
            }
          : checksRecordForSteps(setup, steps)
      return writeTerminalAttempt({
        root,
        run: failedRun,
        setup,
        status: terminalStatus,
        outputSummary,
        checks,
        sim: options.sim,
      })
    }

    currentRun = {
      ...currentRun,
      currentStepIndex: index + 1,
      metrics: { ...currentRun.metrics, ...stepMetrics },
      blockReason: null,
    }
    await upsertWorkflowStep({
      root,
      step: stepRecord({
        run: currentRun,
        step,
        index,
        status: "passed",
        attempt: startedStep.attempt,
        result,
        metrics: stepMetrics,
        logPath,
        outputSummary,
        startedAt: startedStep.startedAt,
      }),
    })
    await upsertWorkflowRun({ root, run: currentRun })
    if (step.metric) {
      await emitEvent(root, {
        type: "eval_finished",
        campaignName: currentRun.campaignName,
        campaignId: currentRun.campaignId ?? undefined,
        runRef: currentRun.runRef,
        commitSha: head,
        resultRef: currentRun.resultRef,
        message: `${setup.metric.name}=${stepMetrics[setup.metric.name]}`,
      })
    }
    if (step.guardrail) {
      await emitEvent(root, {
        type: "checks_finished",
        campaignName: currentRun.campaignName,
        campaignId: currentRun.campaignId ?? undefined,
        runRef: currentRun.runRef,
        commitSha: head,
        resultRef: currentRun.resultRef,
        message: "passed",
      })
    }
    advanced = true
    if (mode === "next") return currentRun
  }

  if (currentRun.currentStepIndex >= setup.workflow.length) {
    const head = await currentCommit(root)
    const dirty = await gitStatus(root)
    const commitCount = await commitCountBetween({
      root,
      baseCommitSha: currentRun.baseCommitSha,
      headCommitSha: head,
    })
    if (dirty) {
      return setWorkflowBlocked({
        root,
        run: currentRun,
        reason: "Workflow cannot finish while the git tree is dirty.",
      })
    }
    if (commitCount !== 1) {
      return setWorkflowBlocked({
        root,
        run: currentRun,
        reason:
          "Workflow cannot finish unless HEAD is exactly one result commit over the base commit.",
      })
    }
    if (currentRun.resultCommitSha && currentRun.resultCommitSha !== head) {
      const rerunFrom =
        firstCommandStepIndex >= 0
          ? firstCommandStepIndex
          : setup.workflow.length
      currentRun = {
        ...currentRun,
        status: "running",
        resultCommitSha: head,
        currentStepIndex: rerunFrom,
        metrics: {},
        blockReason: null,
      }
      await upsertWorkflowRun({ root, run: currentRun })
      for (const [resetIndex, resetStep] of setup.workflow.entries()) {
        if (resetIndex >= rerunFrom && resetStep.run) {
          await upsertWorkflowStep({
            root,
            step: stepRecord({
              run: currentRun,
              step: resetStep,
              index: resetIndex,
              status: "pending",
            }),
          })
        }
      }
      if (mode === "next") return currentRun
      return executeWorkflowSteps({
        root,
        projectPath,
        setup,
        run: currentRun,
        args,
        mode,
        options,
      })
    }
  }

  if (!advanced && currentRun.status !== "running") return currentRun
  const steps = await listWorkflowSteps(root, currentRun.id)
  return writeTerminalAttempt({
    root,
    run: { ...currentRun, status: "succeeded", blockReason: null },
    setup,
    status: "succeeded",
    outputSummary: "Workflow completed successfully.",
    checks: checksRecordForSteps(setup, steps),
    sim: options.sim,
  })
}

export async function commandExpRun(args: Args) {
  if (optionalFlag(args, "no-log")) {
    throw new Error(
      "`onyx exp run --no-log` was removed. Use `onyx tools run <tool-name>` for transient diagnostics."
    )
  }
  const root = await repoRoot(args.options.cwd)
  await assertWslResearchEnvironment(root)
  const projectPath = await resolveProjectPath(root, args)
  const mode = workflowMode(args)

  let run: LocalWorkflowRun
  let setup: ResearchSetupFile
  if (args.options.resume) {
    const existing =
      args.options.resume === "true"
        ? await resolveAutoResumeWorkflowRun({ root, args, projectPath })
        : await readWorkflowRun(root, args.options.resume)
    if (!existing) {
      throw new Error(`Workflow run ${args.options.resume} was not found.`)
    }
    if (existing.projectPath !== projectPath) {
      throw new Error(
        `Workflow run projectPath "${existing.projectPath}" does not match active project path "${projectPath}".`
      )
    }
    run = existing
    setup = await readSetupFileFromCommit({
      root,
      projectPath,
      commitSha: run.baseCommitSha,
    })
    await ensureCampaignMetadata({
      root,
      args,
      projectPath,
      campaignName: run.campaignName,
    })
  } else {
    const campaignName = await resolveCampaignName(root, args)
    const campaign = await ensureCampaignMetadata({
      root,
      args,
      projectPath,
      campaignName,
    })
    const context = await resolveWorkerWorkflowContext(args)
    await assertWorkerCanStartFreshWorkflow({
      root,
      campaignName,
      projectPath,
      context,
    })
    const baseCommitSha = await resolveFreshBaseCommitSha({
      root,
      args,
      campaign,
      context,
    })
    try {
      setup = await readSetupFileFromCommit({
        root,
        projectPath,
        commitSha: baseCommitSha,
      })
    } catch (error) {
      throw new Error(
        [
          `Experiment base ${baseCommitSha} does not contain a valid Onyx setup file for projectPath "${projectPath}".`,
          "Commit the setup surface, then create a new campaign or update/recreate the campaign base before running experiments.",
          error instanceof Error ? `Original error: ${error.message}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      )
    }
    if (setup.projectPath !== projectPath) {
      throw new Error(
        `onyx/setup.json projectPath is "${setup.projectPath}", but the active project path is "${projectPath}".`
      )
    }
    run = await createWorkflowRun({
      root,
      args: { ...args, options: { ...args.options, base: baseCommitSha } },
      campaignName,
      campaign,
      projectPath,
      setup,
      baseCommitSha,
    })
  }

  if (isHardwareQueueRun(run)) {
    throw new Error(
      `Workflow run ${run.id} is ${run.status === "queued" ? "waiting for" : "running on"} hardware; the supervisor finishes it. Check \`exp queue\` for its result.`
    )
  }
  const sim = await readSimConfigFromCommit({
    root,
    projectPath,
    commitSha: run.baseCommitSha,
  })
  // With a simulator, a supervised worker hands sim-passed runs to the
  // supervisor's hardware queue. Outside a supervisor the hardware steps
  // run right here, after the sim gate.
  const queueMode = Boolean(sim && (await getWorkerRuntimeContextCached()))

  console.log(`Workflow run: ${run.id}`)
  console.log(`Run ref: ${run.runRef}`)
  return executeWorkflow({
    root,
    projectPath,
    setup,
    run,
    args,
    mode,
    options: {
      sim,
      queueMode,
      report: {
        name: args.options.name ?? null,
        description: descriptionOption(args),
        agentNotes: parseAgentNotes(args.options["agent-notes"]),
      },
    },
  })
}

/**
 * Runs the measured workflow for a queued run inside `root`, a disposable
 * worktree the supervisor checked out at the run's result commit. Writes
 * the terminal attempt; the caller delivers it.
 */
export async function runHardwareJob({
  root,
  projectPath,
  runId,
  sandboxPolicyPath = null,
  toolEnv,
}: {
  root: string
  projectPath: string
  runId: string
  sandboxPolicyPath?: string | null
  toolEnv?: NodeJS.ProcessEnv
}) {
  const run = await readWorkflowRun(root, runId)
  if (!run?.hardware?.startedAt || run.status !== "running") {
    throw new Error(`Workflow run ${runId} is not a started hardware job.`)
  }
  const head = await currentCommit(root)
  if (head !== run.resultCommitSha) {
    throw new Error(
      `Hardware worktree is at ${head}, not the queued result commit ${run.resultCommitSha}.`
    )
  }
  const setup = await readSetupFileFromCommit({
    root,
    projectPath,
    commitSha: run.baseCommitSha,
  })
  const sim = await readSimConfigFromCommit({
    root,
    projectPath,
    commitSha: run.baseCommitSha,
  })
  return executeWorkflow({
    root,
    projectPath,
    setup,
    run,
    args: { positional: [], options: {} },
    mode: "auto",
    // The gate already passed; sim is passed only to protect its sources.
    options: { sim, hardwareJob: true, sandboxPolicyPath, toolEnv },
  })
}

export type FrozenExperimentDeliveryContext = {
  root: string
  projectPath: string
  campaign: ApiCampaign
  setup: ResearchSetupFile
  runRef: string
  sessionId: string
  assignmentId: string
  hypothesisId: string
  workerId: string
  workerCredential: string
  /** Report fields a worker attached when it queued a hardware run. */
  name?: string | null
  description?: string | null
  agentNotes?: Record<string, unknown>
}

export class ExperimentDeliveryError extends Error {
  readonly resultRefPushStatus: "pushed" | "failed"
  readonly resultRefPushError: string | null

  constructor({
    message,
    resultRefPushStatus,
    resultRefPushError,
  }: {
    message: string
    resultRefPushStatus: "pushed" | "failed"
    resultRefPushError: string | null
  }) {
    super(message)
    this.name = "ExperimentDeliveryError"
    this.resultRefPushStatus = resultRefPushStatus
    this.resultRefPushError = resultRefPushError
  }
}

async function logExperimentOwned(
  args: Args,
  frozen?: FrozenExperimentDeliveryContext,
  ownedRunRef?: string
): Promise<
  Awaited<ReturnType<typeof reportCampaignExperiment>>["experiment"] & {
    deliveryOutcome: "recorded" | "duplicate"
    deliveryResultRefPushStatus: "pushed" | "failed"
    deliveryResultRefPushError: string | null
  }
> {
  const root = frozen?.root ?? (await repoRoot(args.options.cwd))
  const projectPath =
    frozen?.projectPath ?? (await resolveProjectPath(root, args))
  const campaignName =
    frozen?.campaign.name ?? (await resolveCampaignName(root, args))
  const campaign = frozen
    ? {
        campaignId: frozen.campaign.id,
        hypothesisId: frozen.hypothesisId,
        metricName: frozen.campaign.metricName,
        baseCommitSha: frozen.campaign.baseCommitSha,
      }
    : await ensureCampaignMetadata({
        root,
        args,
        projectPath,
        campaignName,
      })
  const setup = frozen?.setup ?? (await readSetupFile(root, projectPath))
  const workerRuntimeContext = frozen
    ? null
    : await getWorkerRuntimeContextCached()
  if (setup.projectPath !== projectPath) {
    throw new Error(
      `onyx/setup.json projectPath is "${setup.projectPath}", but the active project path is "${projectPath}".`
    )
  }
  const context: WorkerWorkflowContext = frozen
    ? {
        sessionId: frozen.sessionId,
        workerId: frozen.workerId,
        hypothesisId: frozen.hypothesisId,
      }
    : await resolveWorkerWorkflowContext(args)
  const explicitRunRef = frozen?.runRef ?? args.options["run-ref"]
  const allowUnmeasuredFailure =
    !explicitRunRef &&
    optionalFlag(args, "allow-unmeasured") &&
    args.options.status === "failed"
  const lastRun = allowUnmeasuredFailure
    ? null
    : await resolveLocalAttemptForLog({
        root,
        campaignName,
        projectPath,
        runRef: explicitRunRef,
        context,
      })
  if (lastRun && !ownedRunRef) {
    return withAttemptDeliveryOwner(root, lastRun.runRef, () =>
      logExperimentOwned(
        { ...args, options: { ...args.options, "run-ref": lastRun.runRef } },
        frozen,
        lastRun.runRef
      )
    )
  }
  const usableAttempt =
    lastRun?.campaignName === campaignName &&
    lastRun.projectPath === projectPath
      ? lastRun
      : null
  if (
    args.options.offline === "true" ||
    args.options["defer-sync"] === "true" ||
    process.env.ONYX_DEFER_EXP_LOG_SYNC === "1"
  ) {
    throw new Error(
      "`--offline`, `--defer-sync`, and ONYX_DEFER_EXP_LOG_SYNC were removed. `onyx exp log` pushes the result ref and reports directly to the Onyx API."
    )
  }
  if (explicitRunRef && !usableAttempt) {
    throw new Error(
      `No measured run found for --run-ref ${explicitRunRef}. Rerun the workflow to create a terminal measured attempt.`
    )
  }
  const resultCommitSha =
    (frozen ? undefined : args.options.commit) ??
    usableAttempt?.resultCommitSha ??
    (await currentCommit(root))
  const baseCommitSha =
    (frozen ? undefined : args.options.base) ??
    usableAttempt?.baseCommitSha ??
    campaign.baseCommitSha
  const metricName =
    (frozen ? undefined : args.options["metric-name"]) ??
    usableAttempt?.primaryMetricName ??
    campaign.metricName
  const metricValue =
    frozen || args.options.metric === undefined
      ? (usableAttempt?.primaryMetricValue ?? null)
      : Number(args.options.metric)
  if (metricValue !== null && !Number.isFinite(metricValue)) {
    throw new Error("--metric must be a finite number")
  }
  const status = validateStatus(
    (frozen ? undefined : args.options.status) ??
      usableAttempt?.status ??
      "succeeded"
  )
  if (
    !usableAttempt &&
    status !== "failed" &&
    !optionalFlag(args, "allow-unmeasured")
  ) {
    throw new Error(
      "Measured attempts must be created by `onyx exp run` before `onyx exp log`. Use --status failed --allow-unmeasured only for an explicitly requested failed attempt. Rerun the workflow to create a terminal measured attempt."
    )
  }
  if (status === "succeeded" && metricValue === null) {
    throw new Error(
      `Cannot record ${status} without a metric for "${metricName}".`
    )
  }
  const checks = usableAttempt?.checks ?? null
  if (checks && checks.status !== "passed" && status === "succeeded") {
    throw new Error(
      `Cannot record ${status}: checks ${checks.status}. Use --status checks_failed.`
    )
  }
  const completedAt = new Date().toISOString()
  const metrics =
    frozen || args.options.metric === undefined
      ? (usableAttempt?.metrics ?? {})
      : metricValue === null
        ? {}
        : { ...(usableAttempt?.metrics ?? {}), [metricName]: metricValue }
  const runRef =
    usableAttempt?.runRef ?? ownedRunRef ?? clientRunRef(campaignName)
  if (!ownedRunRef) {
    return withAttemptDeliveryOwner(root, runRef, () =>
      logExperimentOwned(args, frozen, runRef)
    )
  }
  const resultRef =
    (frozen ? undefined : args.options["result-ref"]) ??
    usableAttempt?.resultRef ??
    `refs/onyx/experiments/${campaign.campaignId}/${safeRefSegment(runRef)}`
  const hypothesisId =
    frozen?.hypothesisId ??
    args.options.hypothesis ??
    usableAttempt?.hypothesisId ??
    workerRuntimeContext?.hypothesisId ??
    campaign.hypothesisId
  const sessionId =
    frozen?.sessionId ??
    args.options.session ??
    usableAttempt?.sessionId ??
    workerRuntimeContext?.sessionId
  const workerId =
    frozen?.workerId ??
    args.options.worker ??
    usableAttempt?.workerId ??
    workerRuntimeContext?.workerId
  const assignmentId =
    frozen?.assignmentId ??
    args.options.assignment ??
    usableAttempt?.delivery?.body.assignmentId ??
    workerRuntimeContext?.assignmentId
  if (!sessionId || !hypothesisId || !assignmentId) {
    throw new Error(
      "Experiment reports require a session, hypothesis, and session assignment. Run inside a supervised worker or pass --session, --hypothesis, and --assignment."
    )
  }
  const loggedCompliance =
    usableAttempt?.setupCompliance ??
    setupCompliance({
      setup,
      changedPaths: await changedProjectPaths({
        root,
        projectPath,
        baseCommitSha,
        resultCommitSha,
      }),
    })
  const loggedStatus: ExperimentStatus =
    loggedCompliance.status === "setup_violation" ? "setup_violation" : status

  const record: LocalResearchCampaignExperimentLoggedRecord = {
    schemaVersion: 1,
    type: "campaign_experiment_logged",
    createdAt: completedAt,
    runRef,
    campaignName,
    name:
      (frozen ? frozen.name : args.options.name) ??
      `experiment-${resultCommitSha.slice(0, 7)}`,
    description: frozen
      ? (frozen.description ?? null)
      : descriptionOption(args),
    projectPath,
    baseCommitSha,
    resultCommitSha,
    resultRef,
    status: loggedStatus,
    setupCompliance: loggedCompliance,
    primaryMetricName: metricName,
    primaryMetricValue: metricValue,
    metrics,
    agentNotes: frozen
      ? frozen.agentNotes && Object.keys(frozen.agentNotes).length > 0
        ? frozen.agentNotes
        : (usableAttempt?.agentNotes ?? {})
      : parseAgentNotes(args.options["agent-notes"]),
    checks,
    durationMs: usableAttempt?.durationMs ?? null,
    startedAt: usableAttempt?.startedAt ?? null,
    completedAt: usableAttempt?.completedAt ?? completedAt,
    outputSummary: usableAttempt?.outputSummary ?? null,
    sessionId,
    workerId,
    hypothesisId,
  }
  let resultRefPushStatus: "pushed" | "failed" = "pushed"
  let resultRefPushedAt: string | undefined
  let resultRefPushError: string | undefined
  await preserveResultRef(root, resultCommitSha, resultRef)
  if (!usableAttempt?.delivery?.sealed) {
    const pushed = await pushAttemptRef(root, {
      runRef,
      resultCommitSha,
      resultRef,
    })
    resultRefPushStatus = pushed.resultRefPushStatus
    resultRefPushedAt = pushed.resultRefPushedAt
    resultRefPushError = pushed.resultRefPushError
    if (resultRefPushError)
      console.warn(
        `Warning: failed to push experiment ref ${resultRef}; retained for recovery. ${resultRefPushError}`
      )
  }
  if (usableAttempt?.delivery?.sealed) {
    resultRefPushStatus =
      usableAttempt.delivery.body.resultRefPushStatus === "pushed"
        ? "pushed"
        : "failed"
    resultRefPushedAt = usableAttempt.delivery.body.resultRefPushedAt
    resultRefPushError = usableAttempt.delivery.body.resultRefPushError
  }
  const preparedReportBody = {
    sessionId,
    assignmentId,
    hypothesisId,
    workerId,
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    runRef,
    baseCommitSha,
    resultCommitSha,
    resultRef,
    resultRefPushStatus,
    ...(resultRefPushedAt ? { resultRefPushedAt } : {}),
    ...(resultRefPushError ? { resultRefPushError } : {}),
    status: loggedStatus,
    setupCompliance: loggedCompliance,
    primaryMetricName: metricName,
    ...(metricValue === null ? {} : { primaryMetricValue: metricValue }),
    secondaryMetrics: metrics,
    artifactRefs: {},
    agentNotes: record.agentNotes,
    ...(checks
      ? {
          checks: {
            status: checks.status,
            durationMs: checks.durationMs ?? null,
            outputSummary: checks.outputSummary ?? null,
          },
        }
      : {}),
    ...(record.durationMs === null ? {} : { durationMs: record.durationMs }),
    ...(record.outputSummary ? { outputSummary: record.outputSummary } : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    completedAt: record.completedAt ?? completedAt,
    provenance: [],
  }
  const reportBody = usableAttempt?.delivery?.sealed
    ? usableAttempt.delivery.body
    : preparedReportBody
  const pendingAttempt = usableAttempt ?? {
    ...record,
    schemaVersion: 1 as const,
  }
  if (!pendingAttempt.delivery) {
    pendingAttempt.delivery = {
      version: 1,
      destination: await deliveryDestination(
        campaign.campaignId,
        (await resolveProject(root, args)).id,
        args
      ),
      body: reportBody,
      sealed: true,
      attempts: 0,
      nextAttemptAt: 0,
      state: "pending",
    }
  }
  pendingAttempt.delivery.body = reportBody
  pendingAttempt.delivery.sealed = true
  await writeLocalAttempt({ root, record: pendingAttempt })
  const scopedWorkerCredential =
    frozen?.workerCredential ?? workerRuntimeContext?.workerCredential
  const report = await (
    scopedWorkerCredential
      ? reportWorkerExperiment(reportBody, args, scopedWorkerCredential)
      : reportCampaignExperiment(campaign.campaignId, reportBody, args)
  ).catch((error) => {
    throw new ExperimentDeliveryError({
      message: `API reporting failed after local measurement${resultRefPushStatus === "pushed" ? " and ref push" : ""}. ${errorMessage(error)}`,
      resultRefPushStatus,
      resultRefPushError: resultRefPushError ?? null,
    })
  })
  if (
    !["recorded", "duplicate"].includes(report.outcome) ||
    report.experiment.runRef !== runRef
  ) {
    throw new Error(
      "Report acknowledgement did not match the pending attempt; retaining it for recovery"
    )
  }
  const workerContextPath = process.env.ONYX_WORKER_CONTEXT?.trim()
  if (workerRuntimeContext && workerContextPath) {
    await recordWorkerReportedExperiment({
      contextPath: workerContextPath,
      workerId: workerRuntimeContext.workerId,
      sessionId: workerRuntimeContext.sessionId,
      hypothesisId: workerRuntimeContext.hypothesisId,
      runRef,
    }).catch(() => {})
  }
  await acknowledgeReport(root, pendingAttempt)
  await emitEvent(root, {
    type: "exp_logged",
    campaignName,
    campaignId: campaign.campaignId,
    runRef,
    commitSha: resultCommitSha,
    resultRef,
    message: `${record.name} (${loggedStatus})`,
  })
  const gitNote =
    report.experiment.gitStatus === "local_reported" ? " [local-reported]" : ""
  const pushNote =
    resultRefPushStatus === "failed" ? " (experiment ref push failed)" : ""
  const dispositionNote =
    report.experiment.disposition === "discarded"
      ? ` [discarded${report.experiment.dispositionReason ? `: ${report.experiment.dispositionReason}` : ""}]`
      : ""
  console.log(
    `${report.outcome}: ${record.name} (${report.experiment.status}) for campaign ${campaignName}${
      report.experiment.acceptedIndex
        ? ` as #${report.experiment.acceptedIndex}`
        : ""
    }${gitNote}${pushNote}${dispositionNote}`
  )
  return {
    ...report.experiment,
    deliveryOutcome: report.outcome,
    deliveryResultRefPushStatus: resultRefPushStatus,
    deliveryResultRefPushError: resultRefPushError ?? null,
  }
}

async function logExperiment(
  args: Args,
  frozen?: FrozenExperimentDeliveryContext
) {
  return logExperimentOwned(args, frozen)
}

/**
 * Delivers one already-terminal measured attempt using the immutable worker
 * context captured by the supervisor. This intentionally bypasses mutable
 * profile/campaign discovery while sharing the exact push/report primitive
 * used by the public `exp log` command.
 */
export async function deliverTerminalExperimentAttempt({
  args,
  context,
}: {
  args: Args
  context: FrozenExperimentDeliveryContext
}) {
  return logExperiment(args, context)
}

export async function commandExpLog(args: Args) {
  return logExperiment(args)
}

export async function commandExpList(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const limit = numberOption(args, "limit", 50)
  if (args.options.offline === "true") {
    throw new Error(
      "`--offline` was removed. Experiments are listed from the Onyx API."
    )
  }
  const workerContext = await getWorkerRuntimeContextCached()
  const campaignName = workerContext
    ? (args.options.campaign ?? workerContext.campaignName)
    : (args.options.campaign ?? (await readState(root)).activeCampaign)
  const resolvedCampaigns = workerContext
    ? [
        {
          campaign: {
            id: workerContext.campaignId,
            name: workerContext.campaignName,
          },
        },
      ]
    : campaignName
      ? [
          {
            campaign: (
              await getCampaignOverview(
                (
                  await ensureCampaignMetadata({
                    root,
                    args,
                    projectPath,
                    campaignName,
                  })
                ).campaignId,
                args
              )
            ).campaign,
          },
        ]
      : await resolveProject(root, args)
          .then((project) => listProjectCampaigns(project.id, args))
          .then((items) => items.map((campaign) => ({ campaign })))
  if (
    workerContext &&
    args.options.campaign &&
    !resolvedCampaigns.some(
      ({ campaign }) =>
        campaign.id === args.options.campaign ||
        campaign.name === args.options.campaign
    )
  ) {
    throw new Error(
      `Worker ${workerContext.workerId} is not assigned to campaign ${args.options.campaign}.`
    )
  }
  const rows: LocalResearchHistoryRecord[] = []
  for (const { campaign } of resolvedCampaigns) {
    let cursor: string | null = null
    do {
      const disposition =
        (args.options.disposition as
          | "all"
          | "received"
          | "accepted"
          | "discarded"
          | undefined) ?? "all"
      const page: Awaited<ReturnType<typeof listCampaignExperiments>> =
        workerContext
          ? await listWorkerExperiments(args, {
              limit: Math.min(100, Math.max(limit, 1)),
              cursor: cursor ?? undefined,
              disposition,
            })
          : await listCampaignExperiments(campaign.id, args, {
              limit: Math.min(100, Math.max(limit, 1)),
              cursor: cursor ?? undefined,
              disposition,
            })
      for (const experiment of page.items) {
        const row = apiExperimentToHistory(campaign, experiment)
        if (row) rows.push(row)
      }
      cursor = page.page.nextCursor
    } while (
      cursor &&
      rows.length < Math.max(limit, 100) &&
      (args.options.grep || args.options.status)
    )
  }

  let filtered = rows
  if (args.options.status) {
    const status = validateStatus(args.options.status)
    filtered = filtered.filter((row) => row.status === status)
  }
  if (args.options.grep) {
    let pattern: RegExp
    try {
      pattern = new RegExp(args.options.grep, "i")
    } catch (error) {
      throw new Error(
        `--grep is not a valid regex: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    filtered = filtered.filter((row) =>
      pattern.test(
        [
          row.name,
          row.description ?? "",
          JSON.stringify(row.agentNotes),
          row.outputSummary ?? "",
        ].join("\n")
      )
    )
  }

  filtered.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  )
  const limited = filtered.slice(0, limit)

  if (optionalFlag(args, "json")) {
    console.log(JSON.stringify(limited, null, 2))
    return
  }

  if (limited.length === 0) {
    console.log(
      rows.length === 0
        ? "No experiments recorded in the Onyx API yet."
        : "No experiments matched the given filters."
    )
    return
  }

  const lines = renderExperimentTable(limited, {
    columns: process.stdout.columns ?? 120,
    color: process.stdout.isTTY ?? false,
    nowMs: Date.now(),
    showCampaign: !args.options.campaign,
  })
  for (const line of lines) console.log(line)
  if (filtered.length > limited.length) {
    console.log(
      `… ${filtered.length - limited.length} more; raise --limit to see all.`
    )
  }
}

function hardwareRunLine(
  run: LocalWorkflowRun,
  metricName: string,
  position: number | null
) {
  const ref = run.runRef.split("/").pop()?.slice(0, 8) ?? run.runRef
  const commit = run.resultCommitSha?.slice(0, 7) ?? "none"
  const sim = run.sim
    ? ` sim ${run.sim.status}${
        Object.keys(run.sim.metrics).length > 0
          ? ` (${Object.entries(run.sim.metrics)
              .map(([name, value]) => `${name}=${value}`)
              .join(", ")})`
          : ""
      }`
    : ""
  const label =
    run.status === "queued"
      ? `queued${position ? ` #${position}` : ""}`
      : run.status === "running"
        ? `on hardware since ${run.hardware?.startedAt ?? "?"}`
        : run.status
  const metric =
    run.metrics[metricName] === undefined
      ? ""
      : ` ${metricName}=${run.metrics[metricName]}`
  const delivery = run.hardware?.delivery
    ? ` [report ${run.hardware.delivery}${
        run.hardware.deliveryError ? `: ${run.hardware.deliveryError}` : ""
      }]`
    : ""
  const reason =
    run.hardware?.cancelReason ??
    (run.status !== "succeeded" && run.status !== "queued" && run.blockReason
      ? run.blockReason.split("\n")[0]
      : null)
  return `- ${ref} ${commit}: ${label}${metric}${sim}${delivery}${
    reason ? ` (${reason})` : ""
  }`
}

/**
 * Hardware queue status. Inside a supervised worker it shows the session's
 * line and this worker's own experiments, including finished hardware
 * results; `--wait` blocks until none of them is still queued or running.
 */
export async function commandExpQueue(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const context = await getWorkerRuntimeContextCached()
  const sessionId = context?.sessionId ?? args.options.session
  const workerId = context?.workerId ?? args.options.worker
  const metricName =
    context?.campaign.metricName ??
    (await readSetupFile(root, await resolveProjectPath(root, args))
      .then((setup) => setup.metric.name)
      .catch(() => "metric"))

  const snapshot = async () => {
    const all = (
      await listWorkflowRuns(root, sessionId ? { sessionId } : {})
    ).filter((run) => run.hardware)
    const line = all
      .filter((run) => run.status === "queued" && !run.hardware!.startedAt)
      .sort((left, right) =>
        left.hardware!.queuedAt.localeCompare(right.hardware!.queuedAt)
      )
    const running = all.filter(isHardwareQueueRun).filter(
      (run) => run.status === "running"
    )
    const mine = workerId
      ? all
          .filter((run) => run.workerId === workerId)
          .sort((left, right) =>
            right.hardware!.queuedAt.localeCompare(left.hardware!.queuedAt)
          )
      : all
          .sort((left, right) =>
            right.hardware!.queuedAt.localeCompare(left.hardware!.queuedAt)
          )
          .slice(0, 20)
    return { line, running, mine }
  }

  let view = await snapshot()
  if (optionalFlag(args, "wait")) {
    const timeoutMs = numberOption(args, "timeout", 600) * 1000
    const deadline = Date.now() + timeoutMs
    while (
      view.mine.some(isHardwareQueueRun) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      view = await snapshot()
    }
  }

  const positionOf = (run: LocalWorkflowRun) => {
    const index = view.line.findIndex((item) => item.id === run.id)
    return index === -1 ? null : index + 1
  }
  if (optionalFlag(args, "json")) {
    console.log(
      JSON.stringify(
        {
          sessionId: sessionId ?? null,
          workerId: workerId ?? null,
          waiting: view.line.length,
          running: view.running.length,
          experiments: view.mine.map((run) => ({
            workflowRunId: run.id,
            runRef: run.runRef,
            resultCommitSha: run.resultCommitSha,
            status: run.status,
            position: positionOf(run),
            metrics: run.metrics,
            sim: run.sim ?? null,
            hardware: run.hardware,
            blockReason: run.blockReason,
          })),
        },
        null,
        2
      )
    )
    return
  }
  console.log(
    `Hardware queue: ${view.line.length} waiting, ${view.running.length} running`
  )
  if (view.mine.length === 0) {
    console.log(
      workerId
        ? "You have no experiments in the hardware queue."
        : "No hardware experiments recorded."
    )
    return
  }
  console.log(workerId ? "Your hardware experiments:" : "Hardware experiments:")
  for (const run of view.mine) {
    console.log(hardwareRunLine(run, metricName, positionOf(run)))
  }
}
