import type {
  LocalResearchCampaignExperimentLoggedRecord,
  LocalResearchHistoryRecord,
} from "../protocol"

import { listProjectCampaigns, resolveProject } from "../lib/api"
import { descriptionOption, optionalFlag, type Args } from "../lib/args"
import { readSetupFile, type ResearchSetupFile } from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, git, repoRoot } from "../lib/git"
import {
  appendHistory,
  experimentRecordToHistory,
  readHistory,
} from "../lib/history"
import {
  parseMetricLines,
  primaryMetric,
  summarizeOutput,
} from "../lib/metrics"
import {
  appendOutbox,
  clearLastRun,
  clientRunRef,
  readOutbox,
  readLastRun,
  readState,
  writeLastRun,
  writeState,
  type LastRunRecord,
} from "../lib/outbox"
import { campaignStateKey, onyxPath, resolveProjectPath } from "../lib/project"
import { pathExists } from "../lib/process"
import { renderExperimentTable } from "../lib/tui"
import {
  hasToolCommand,
  runToolCommand,
  type ToolRunResult,
} from "../lib/tools"
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
    "onyx/eval.sh",
    "onyx/checks.sh",
    "onyx/tools",
  ]
  const protectedPaths = [...defaultProtected, ...setup.protectedPaths]
  const protectedPathsChanged = changedPaths.filter((path) =>
    protectedPaths.some((scope) => pathMatchesScope(path, scope))
  )
  const outOfScopePathsChanged =
    setup.editableScope.length === 0
      ? []
      : changedPaths.filter(
          (path) =>
            !setup.editableScope.some((scope) => pathMatchesScope(path, scope))
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

async function runChecks({
  root,
  projectPath,
  timeoutMs,
}: {
  root: string
  projectPath: string
  timeoutMs: number
}): Promise<ChecksRecord | null> {
  const hasManifestCheck = await hasToolCommand({
    root,
    projectPath,
    name: "check",
  })
  const checksSh = onyxPath(root, projectPath, "checks.sh")
  if (!hasManifestCheck && !(await pathExists(checksSh))) return null

  const started = Date.now()
  const result = await runToolCommand({
    root,
    projectPath,
    name: hasManifestCheck ? "check" : "checks",
    timeoutSeconds: timeoutMs / 1000,
  })
  const durationMs = Date.now() - started
  const outputSummary =
    result.outputSummary ??
    summarizeOutput(result.stdout, result.stderr) ??
    null

  return {
    status: result.timedOut
      ? "timed_out"
      : result.code === 0
        ? "passed"
        : "failed",
    durationMs,
    outputSummary,
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

  return {
    campaignId: campaign.id,
    hypothesisId: state.campaigns[key]?.hypothesisId,
    metricName: campaign.metricName,
    baseCommitSha: campaign.baseCommitSha,
  }
}

export async function commandExpRun(args: Args) {
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
  const resultCommitSha = await currentCommit(root)

  const timeoutMs = numberOption(args, "timeout", 600) * 1000
  const checksTimeoutMs = numberOption(args, "checks-timeout", 300) * 1000
  const started = new Date()
  const hypothesisId =
    args.options.hypothesis ??
    process.env.ONYX_HYPOTHESIS_ID ??
    campaign.hypothesisId
  const sessionId = args.options.session ?? process.env.ONYX_SESSION_ID
  const workerId = args.options.worker ?? process.env.ONYX_WORKER_ID
  const baseCommitSha =
    args.options.base ?? process.env.ONYX_BASE_COMMIT ?? campaign.baseCommitSha
  const noLog = optionalFlag(args, "no-log")
  const existingAttempt = noLog ? null : await readLastRun(root)
  const reusableAttempt =
    existingAttempt?.campaignName === campaignName &&
    existingAttempt.projectPath === projectPath &&
    existingAttempt.baseCommitSha === baseCommitSha &&
    existingAttempt.resultCommitSha === resultCommitSha
      ? existingAttempt
      : null
  const runRef = reusableAttempt?.runRef ?? clientRunRef(campaignName)
  const resultRef =
    reusableAttempt?.resultRef ??
    `refs/onyx/experiments/${campaign.campaignId}/${safeRefSegment(runRef)}`
  const initialRun: LastRunRecord = {
    schemaVersion: 1,
    createdAt: started.toISOString(),
    runRef,
    campaignName,
    projectPath,
    baseCommitSha,
    resultCommitSha,
    resultRef,
    status: "running",
    setupCompliance: {
      status: "passed",
      protectedPathsChanged: [],
      outOfScopePathsChanged: [],
      setupPathsChanged: [],
      notes: null,
    },
    primaryMetricName: campaign.metricName,
    primaryMetricValue: null,
    metrics: {},
    agentNotes: {},
    checks: null,
    durationMs: 0,
    startedAt: started.toISOString(),
    completedAt: null,
    outputSummary: null,
    sessionId,
    workerId,
    hypothesisId,
  }
  if (!noLog) await writeLastRun(root, initialRun)

  await emitEvent(root, {
    type: "exp_run_started",
    campaignName,
    campaignId: campaign.campaignId,
    runRef,
    commitSha: resultCommitSha,
    resultRef,
  })
  if (await hasToolCommand({ root, projectPath, name: "reset" })) {
    const reset = await runToolCommand({
      root,
      projectPath,
      name: "reset",
      timeoutSeconds: numberOption(args, "reset-timeout", 120),
    })
    if (reset.code !== 0 || reset.timedOut) {
      if (!noLog) {
        await writeLastRun(root, {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          runRef,
          campaignName,
          projectPath,
          baseCommitSha,
          resultCommitSha,
          resultRef,
          status: "failed",
          setupCompliance: initialRun.setupCompliance,
          primaryMetricName: campaign.metricName,
          primaryMetricValue: null,
          metrics: {},
          agentNotes: {},
          checks: null,
          durationMs: 0,
          startedAt: started.toISOString(),
          completedAt: new Date().toISOString(),
          outputSummary:
            reset.outputSummary ??
            summarizeOutput(reset.stdout, reset.stderr) ??
            "Environment reset failed.",
          sessionId,
          workerId,
          hypothesisId,
        })
      }
      throw new Error("Environment reset failed before evaluation.")
    }
  }
  const result: ToolRunResult = await runToolCommand({
    root,
    projectPath,
    name: "evaluate",
    timeoutSeconds: timeoutMs / 1000,
  })
  const completed = new Date()
  const metrics = parseMetricLines(result.stdout, campaign.metricName)
  const primary = primaryMetric(metrics, campaign.metricName)
  const benchmarkSucceeded =
    result.code === 0 && !result.timedOut && primary.value !== null
  await emitEvent(root, {
    type: "eval_finished",
    campaignName,
    campaignId: campaign.campaignId,
    runRef,
    commitSha: resultCommitSha,
    resultRef,
    message: `${primary.name}=${primary.value ?? "null"} (${benchmarkSucceeded ? "ok" : "failed"})`,
  })
  const checks = benchmarkSucceeded
    ? await runChecks({ root, projectPath, timeoutMs: checksTimeoutMs })
    : null
  if (checks) {
    await emitEvent(root, {
      type: "checks_finished",
      campaignName,
      campaignId: campaign.campaignId,
      runRef,
      commitSha: resultCommitSha,
      resultRef,
      message: checks.status,
    })
  }
  const measuredStatus: ExperimentStatus = !benchmarkSucceeded
    ? "failed"
    : checks && checks.status !== "passed"
      ? "checks_failed"
      : "succeeded"
  const compliance = setupCompliance({
    setup,
    changedPaths: await changedProjectPaths({
      root,
      projectPath,
      baseCommitSha,
      resultCommitSha,
    }),
  })
  const status: ExperimentStatus =
    compliance.status === "setup_violation" ? "setup_violation" : measuredStatus
  const outputSummaryParts = [
    result.timedOut ? `Eval timed out after ${timeoutMs / 1000}s.` : "",
    result.code === 0 && primary.value === null
      ? `No METRIC line found for ${campaign.metricName}.`
      : "",
    result.outputSummary ?? summarizeOutput(result.stdout, result.stderr),
  ].filter(Boolean)
  const outputSummary = outputSummaryParts.join("\n").slice(0, 4000) || null

  if (noLog) {
    console.log(
      JSON.stringify({ metrics, status, checks, compliance }, null, 2)
    )
    if (result.code !== 0) process.exitCode = result.code ?? 1
    return
  }

  const record: LastRunRecord = {
    schemaVersion: 1,
    createdAt: completed.toISOString(),
    runRef,
    campaignName,
    projectPath,
    baseCommitSha,
    resultCommitSha,
    resultRef,
    status,
    setupCompliance: compliance,
    primaryMetricName: primary.name,
    primaryMetricValue: primary.value,
    metrics,
    agentNotes: {},
    checks,
    durationMs: completed.getTime() - started.getTime(),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    outputSummary,
    sessionId,
    workerId,
    hypothesisId,
  }
  await writeLastRun(root, record)
  await emitEvent(root, {
    type: "run_finished",
    campaignName,
    campaignId: campaign.campaignId,
    runRef,
    commitSha: resultCommitSha,
    resultRef,
    message: status,
  })
  console.log(
    `Measured ${resultCommitSha.slice(0, 7)} (${primary.name}=${primary.value ?? "null"}, ${status}); runRef ${runRef}`
  )
  console.log("Run `onyx exp log --description <text>` to record this result.")

  if (
    !benchmarkSucceeded ||
    status === "checks_failed" ||
    status === "setup_violation"
  ) {
    process.exitCode = result.code && result.code !== 0 ? result.code : 1
  }
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
  const lastRun = await readLastRun(root)
  const usableLastRun =
    lastRun?.campaignName === campaignName &&
    lastRun.projectPath === projectPath
      ? lastRun
      : null
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
  await appendOutbox(root, record)
  await flushOutbox(root, args, { quiet: true }).catch(() => {})
  await appendHistory(root, experimentRecordToHistory(record)).catch(() => {})
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
  if (usableLastRun) await clearLastRun(root)
}

export async function commandExpList(args: Args) {
  const root = await repoRoot()
  const { records, corrupt } = await readHistory(root)
  if (corrupt > 0) {
    console.warn(`Skipped ${corrupt} unreadable history record(s).`)
  }

  const rows: LocalResearchHistoryRecord[] = [...records]
  const seenRunRefs = new Set(rows.map((row) => row.runRef))
  const { records: pendingOutbox, corrupt: corruptOutbox } =
    await readOutbox(root)
  if (corruptOutbox > 0) {
    console.warn(
      `Skipped ${corruptOutbox} unreadable pending outbox record(s).`
    )
  }
  for (const record of pendingOutbox) {
    if (record.type !== "campaign_experiment_logged") continue
    if (seenRunRefs.has(record.runRef)) continue
    rows.push(experimentRecordToHistory(record))
    seenRunRefs.add(record.runRef)
  }

  const lastRun = await readLastRun(root)
  if (lastRun && !seenRunRefs.has(lastRun.runRef)) {
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
