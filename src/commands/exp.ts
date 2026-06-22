import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type {
  LocalResearchCampaignExperimentLoggedRecord,
  LocalResearchHistoryRecord,
} from "../protocol"

import { listProjectCampaigns, resolveProject } from "../lib/api"
import { descriptionOption, optionalFlag, type Args } from "../lib/args"
import {
  normalizeSetupFile,
  readSetupFile,
  setupHash,
  type ResearchSetupFile,
  type ResearchSetupWorkflowStep,
} from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, git, repoRoot } from "../lib/git"
import { summarizeOutput } from "../lib/metrics"
import {
  clientRunRef,
  onyxStateDir,
  readState,
  writeState,
  type LastRunSelector,
  type LastRunRecord,
} from "../lib/outbox"
import { campaignStateKey, resolveProjectPath } from "../lib/project"
import {
  cacheLocalCampaign,
  clearLocalAttempt,
  listWorkflowSteps,
  listLocalAttempts,
  listLocalExperimentHistory,
  localCampaignByName,
  logLocalExperiment,
  readLocalAttempt,
  readWorkflowRun,
  upsertWorkflowRun,
  upsertWorkflowStep,
  writeLocalAttempt,
  type LocalWorkflowRun,
  type LocalWorkflowStep,
} from "../lib/research-db"
import { renderExperimentTable } from "../lib/tui"
import { runToolCommand, type ToolRunResult } from "../lib/tools"
import { flushOutbox } from "../lib/sync"

type ExperimentStatus = LocalResearchCampaignExperimentLoggedRecord["status"]
type ChecksRecord = NonNullable<
  LocalResearchCampaignExperimentLoggedRecord["checks"]
>

function numberOption(args: Args, name: string, fallback: number) {
  const value = args.options[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive number`)
  }
  return parsed
}

function validateStatus(value: string): ExperimentStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "checks_failed" ||
    value === "setup_violation" ||
    value === "accepted" ||
    value === "rejected"
  ) {
    return value
  }

  throw new Error(
    "--status must be queued, running, succeeded, failed, checks_failed, setup_violation, accepted, or rejected"
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
}): LastRunSelector {
  const selector: LastRunSelector = { campaignName, projectPath }
  if (runRef) {
    selector.runRef = runRef
    return selector
  }
  if (sessionId) selector.sessionId = sessionId
  if (workerId) selector.workerId = workerId
  if (hypothesisId) selector.hypothesisId = hypothesisId
  if (!sessionId && !workerId && !hypothesisId) selector.legacyOnly = true
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
}: {
  setup: ResearchSetupFile
  changedPaths: string[]
}): LocalResearchCampaignExperimentLoggedRecord["setupCompliance"] {
  const defaultProtected = [
    "onyx/onyx.md",
    "onyx/setup.json",
    "onyx/validation.json",
    "onyx/tools",
  ]
  const protectedPaths = [...defaultProtected, ...setup.scope.protected]
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
  const state = await readState(root)
  const campaignName = args.options.campaign ?? state.activeCampaign
  if (!campaignName) {
    throw new Error(
      "No active campaign. Run `onyx campaign use --name <name>` or pass `--campaign <name>`."
    )
  }
  return campaignName
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
  const localCampaign = await localCampaignByName({
    root,
    projectPath,
    name: campaignName,
  })
  if (localCampaign) {
    const state = await readState(root)
    const key = campaignStateKey(projectPath, campaignName)
    state.projectPath = projectPath
    state.activeCampaign = campaignName
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
    return {
      campaignId: localCampaign.id,
      hypothesisId: state.campaigns[key]?.hypothesisId,
      metricName: localCampaign.metricName,
      baseCommitSha: localCampaign.baseCommitSha,
    }
  }

  const state = await readState(root)
  const key = campaignStateKey(projectPath, campaignName)
  const cached = state.campaigns?.[key]
  if (cached?.campaignId && cached.metricName && cached.baseCommitSha) {
    await cacheLocalCampaign({
      root,
      projectPath,
      setup: cached.setup ?? {},
      campaign: {
        id: cached.campaignId,
        projectId: state.projectId ?? "local",
        name: campaignName,
        description: cached.description ?? null,
        baseCommitSha: cached.baseCommitSha,
        metricName: cached.metricName,
        metricUnit: cached.metricUnit ?? null,
        metricDirection: cached.metricDirection ?? "maximize",
        bestMetricValue: null,
        bestCommitSha: null,
        experimentCount: 0,
        promotionRefName: cached.promotionRefName ?? null,
      },
    }).catch(() => null)
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
      `Campaign ${campaignName} is not synced. Run \`onyx campaign setup --name ${campaignName}\` after creating onyx/setup.json, then \`onyx sync\`.`
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

  return {
    campaignId: campaign.id,
    hypothesisId: state.campaigns[key]?.hypothesisId,
    metricName: campaign.metricName,
    baseCommitSha: campaign.baseCommitSha,
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
    await git(["rev-list", "--count", `${baseCommitSha}..${headCommitSha}`], root)
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

export function parseWorkflowMetricLines(stdout: string, metricName: string) {
  const metricLines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("METRIC "))
  if (metricLines.length === 0) {
    return {
      metrics: {},
      error: `Expected one primary METRIC ${metricName}=<number> line; found none.`,
    }
  }
  const metrics: Record<string, number> = {}
  for (const line of metricLines) {
    const match = line.match(
      /^METRIC\s+([A-Za-z0-9_.:-]+)=(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i
    )
    if (!match) {
      return { metrics: {}, error: `Invalid METRIC line: ${line}` }
    }
    const name = match[1]!
    if (Object.hasOwn(metrics, name)) {
      return {
        metrics: {},
        error: `Duplicate METRIC ${name}=<number> line.`,
      }
    }
    metrics[name] = Number(match[2])
  }
  if (!Object.hasOwn(metrics, metricName)) {
    return {
      metrics: {},
      error: `Expected one primary METRIC ${metricName}=<number> line; found ${metricLines.length} metric line(s) without the primary metric.`,
    }
  }
  return { metrics, error: null }
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
}: {
  root: string
  run: LocalWorkflowRun
  setup: ResearchSetupFile
  status: ExperimentStatus
  outputSummary: string | null
  checks: ChecksRecord | null
}) {
  const resultCommitSha = run.resultCommitSha
  if (!resultCommitSha) {
    throw new Error("Workflow cannot finish before a result commit is selected.")
  }
  const completed = new Date()
  const compliance = setupCompliance({
    setup,
    changedPaths: await changedProjectPaths({
      root,
      projectPath: run.projectPath,
      baseCommitSha: run.baseCommitSha,
      resultCommitSha,
    }),
  })
  const finalStatus =
    compliance.status === "setup_violation" ? "setup_violation" : status
  const record: LastRunRecord = {
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
  }
  await writeLocalAttempt({ root, record })
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
  console.log(
    `Run \`onyx exp log --run-ref ${run.runRef} --description <text>\` to record this result.`
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
}: {
  root: string
  args: Args
  campaignName: string
  campaign: Awaited<ReturnType<typeof ensureCampaignMetadata>>
  projectPath: string
  setup: ResearchSetupFile
}) {
  const started = new Date().toISOString()
  const runRef = clientRunRef(campaignName)
  const sessionId = args.options.session ?? process.env.ONYX_SESSION_ID
  const workerId = args.options.worker ?? process.env.ONYX_WORKER_ID
  const hypothesisId =
    args.options.hypothesis ??
    process.env.ONYX_HYPOTHESIS_ID ??
    campaign.hypothesisId
  const baseCommitSha =
    args.options.base ?? process.env.ONYX_BASE_COMMIT ?? campaign.baseCommitSha
  const run: LocalWorkflowRun = {
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

async function executeWorkflow({
  root,
  projectPath,
  setup,
  run,
  args,
  mode,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
  run: LocalWorkflowRun
  args: Args
  mode: "auto" | "next"
}) {
  let currentRun = run
  let advanced = false
  const firstCommandStepIndex = setup.workflow.findIndex((step) => Boolean(step.run))

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
          blockReason: "Paused at agent step. Make exactly one commit, then resume.",
        }
        await upsertWorkflowRun({ root, run: paused })
        await upsertWorkflowStep({
          root,
          step: stepRecord({ run: paused, step, index, status: "paused" }),
        })
        console.log("Paused at agent step. Make exactly one commit, then resume.")
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
    })
    const logPath = await writeWorkflowStepLog({ root, run: currentRun, step, result })
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
      const terminalStatus: ExperimentStatus = step.guardrail && !step.metric
        ? "checks_failed"
        : "failed"
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
        firstCommandStepIndex >= 0 ? firstCommandStepIndex : setup.workflow.length
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
      return executeWorkflow({ root, projectPath, setup, run: currentRun, args, mode })
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
  })
}

export async function commandExpRun(args: Args) {
  if (optionalFlag(args, "no-log")) {
    throw new Error(
      "`onyx exp run --no-log` was removed. Use `onyx tools run <tool-id>` for transient diagnostics."
    )
  }
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const mode = workflowMode(args)

  let run: LocalWorkflowRun
  let setup: ResearchSetupFile
  if (args.options.resume) {
    const existing = await readWorkflowRun(root, args.options.resume)
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
    const baseCommitSha =
      args.options.base ?? process.env.ONYX_BASE_COMMIT ?? campaign.baseCommitSha
    setup = await readSetupFileFromCommit({
      root,
      projectPath,
      commitSha: baseCommitSha,
    }).catch(async () => readSetupFile(root, projectPath))
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
    })
  }

  console.log(`Workflow run: ${run.id}`)
  console.log(`Run ref: ${run.runRef}`)
  return executeWorkflow({ root, projectPath, setup, run, args, mode })
}

export async function commandExpLog(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const campaignName = await resolveCampaignName(root, args)
  const campaign = await ensureCampaignMetadata({
    root,
    args,
    projectPath,
    campaignName,
  })
  const setup = await readSetupFile(root, projectPath)
  if (setup.projectPath !== projectPath) {
    throw new Error(
      `onyx/setup.json projectPath is "${setup.projectPath}", but the active project path is "${projectPath}".`
    )
  }
  const contextSessionId = args.options.session ?? process.env.ONYX_SESSION_ID
  const contextWorkerId = args.options.worker ?? process.env.ONYX_WORKER_ID
  const contextHypothesisId =
    args.options.hypothesis ?? process.env.ONYX_HYPOTHESIS_ID
  const lastRun = await readLocalAttempt(
    root,
    lastRunSelectorForContext({
      campaignName,
      projectPath,
      runRef: args.options["run-ref"],
      sessionId: contextSessionId,
      workerId: contextWorkerId,
      hypothesisId: contextHypothesisId,
    })
  )
  const usableLastRun =
    lastRun?.campaignName === campaignName &&
    lastRun.projectPath === projectPath
      ? lastRun
      : null
  if (args.options["run-ref"] && !usableLastRun) {
    const localHistory = await listLocalExperimentHistory(root).catch(() => [])
    const logged = localHistory.find(
      (record) =>
        record.runRef === args.options["run-ref"] &&
        record.campaignName === campaignName
    )
    if (logged) {
      console.log(
        `Experiment ${args.options["run-ref"]} is already recorded for campaign ${campaignName}`
      )
      return
    }
    throw new Error(
      `No measured run found for --run-ref ${args.options["run-ref"]}. Run \`onyx exp list --json\` to inspect unlogged local runs.`
    )
  }
  const resultCommitSha =
    args.options.commit ??
    usableLastRun?.resultCommitSha ??
    (await currentCommit(root))
  const baseCommitSha =
    args.options.base ?? usableLastRun?.baseCommitSha ?? campaign.baseCommitSha
  const metricName =
    args.options["metric-name"] ??
    usableLastRun?.primaryMetricName ??
    campaign.metricName
  const metricValue =
    args.options.metric === undefined
      ? (usableLastRun?.primaryMetricValue ?? null)
      : Number(args.options.metric)
  if (metricValue !== null && !Number.isFinite(metricValue)) {
    throw new Error("--metric must be a finite number")
  }
  const status = validateStatus(
    args.options.status ?? usableLastRun?.status ?? "succeeded"
  )
  if (
    !usableLastRun &&
    status !== "failed" &&
    !optionalFlag(args, "allow-unmeasured")
  ) {
    throw new Error(
      "Measured attempts must be created by `onyx exp run` before `onyx exp log`. Use --status failed --allow-unmeasured only for failed unmeasured attempts."
    )
  }
  if (
    (status === "succeeded" || status === "accepted") &&
    metricValue === null
  ) {
    throw new Error(
      `Cannot record ${status} without a metric for "${metricName}".`
    )
  }
  const checks = usableLastRun?.checks ?? null
  if (
    checks &&
    checks.status !== "passed" &&
    (status === "succeeded" || status === "accepted")
  ) {
    throw new Error(
      `Cannot record ${status}: checks ${checks.status}. Use --status checks_failed.`
    )
  }
  const completedAt = new Date().toISOString()
  const metrics =
    args.options.metric === undefined
      ? (usableLastRun?.metrics ?? {})
      : metricValue === null
        ? {}
        : { ...(usableLastRun?.metrics ?? {}), [metricName]: metricValue }
  const runRef = usableLastRun?.runRef ?? clientRunRef(campaignName)
  const resultRef =
    args.options["result-ref"] ??
    usableLastRun?.resultRef ??
    `refs/onyx/experiments/${campaign.campaignId}/${safeRefSegment(runRef)}`
  const hypothesisId =
    args.options.hypothesis ??
    usableLastRun?.hypothesisId ??
    process.env.ONYX_HYPOTHESIS_ID ??
    campaign.hypothesisId
  const sessionId =
    args.options.session ??
    usableLastRun?.sessionId ??
    process.env.ONYX_SESSION_ID
  const workerId =
    args.options.worker ?? usableLastRun?.workerId ?? process.env.ONYX_WORKER_ID
  const loggedCompliance =
    usableLastRun?.setupCompliance ??
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
    name: args.options.name ?? `experiment-${resultCommitSha.slice(0, 7)}`,
    description: descriptionOption(args),
    projectPath,
    baseCommitSha,
    resultCommitSha,
    resultRef,
    status: loggedStatus,
    setupCompliance: loggedCompliance,
    primaryMetricName: metricName,
    primaryMetricValue: metricValue,
    metrics,
    agentNotes: parseAgentNotes(args.options["agent-notes"]),
    checks,
    durationMs: usableLastRun?.durationMs ?? null,
    startedAt: usableLastRun?.startedAt ?? null,
    completedAt: usableLastRun?.completedAt ?? completedAt,
    outputSummary: usableLastRun?.outputSummary ?? null,
    sessionId,
    workerId,
    hypothesisId,
  }
  await logLocalExperiment({ root, record })
  if (args.options.offline !== "true") {
    await flushOutbox(root, args, { quiet: true }).catch((error) => {
      if (args.options["require-online"] === "true") throw error
    })
  }
  await emitEvent(root, {
    type: "exp_logged",
    campaignName,
    campaignId: campaign.campaignId,
    runRef,
    commitSha: resultCommitSha,
    resultRef,
    message: `${record.name} (${loggedStatus})`,
  })
  console.log(
    `Recorded ${record.name} (${loggedStatus}) for campaign ${campaignName}`
  )
  if (usableLastRun)
    await clearLocalAttempt(root, { runRef: usableLastRun.runRef })
}

export async function commandExpList(args: Args) {
  const root = await repoRoot()
  const sqliteRows = await listLocalExperimentHistory(root).catch(() => [])
  const rows: LocalResearchHistoryRecord[] = [...sqliteRows]
  const seenRunRefs = new Set(rows.map((row) => row.runRef))
  const lastRuns = await listLocalAttempts(root)
  for (const lastRun of lastRuns) {
    if (seenRunRefs.has(lastRun.runRef)) continue
    rows.push({
      schemaVersion: 1,
      source: "local",
      campaignName: lastRun.campaignName,
      runRef: lastRun.runRef,
      baseCommitSha: lastRun.baseCommitSha,
      resultCommitSha: lastRun.resultCommitSha,
      resultRef: lastRun.resultRef,
      status: lastRun.status,
      name: `(unlogged) ${lastRun.resultCommitSha.slice(0, 7)}`,
      description: null,
      primaryMetricName: lastRun.primaryMetricName,
      primaryMetricValue: lastRun.primaryMetricValue,
      metrics: lastRun.metrics,
      agentNotes: lastRun.agentNotes,
      checks: lastRun.checks ?? null,
      durationMs: lastRun.durationMs ?? null,
      startedAt: lastRun.startedAt ?? null,
      completedAt: lastRun.completedAt ?? null,
      createdAt: lastRun.createdAt,
      sessionId: lastRun.sessionId,
      workerId: lastRun.workerId,
      hypothesisId: lastRun.hypothesisId,
    })
    seenRunRefs.add(lastRun.runRef)
  }

  let filtered = rows
  if (args.options.campaign) {
    filtered = filtered.filter(
      (row) => row.campaignName === args.options.campaign
    )
  }
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
  const limit = numberOption(args, "limit", 50)
  const limited = filtered.slice(0, limit)

  if (optionalFlag(args, "json")) {
    console.log(JSON.stringify(limited, null, 2))
    return
  }

  if (limited.length === 0) {
    console.log(
      rows.length === 0
        ? "No local experiments recorded yet. Run `onyx sync` to hydrate from the Onyx app, or `onyx exp run`/`onyx exp log` to create one locally."
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
