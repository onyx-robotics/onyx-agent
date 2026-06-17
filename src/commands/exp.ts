import type {
  LocalResearchCampaignExperimentLoggedRecord,
  LocalResearchHistoryRecord,
} from "../protocol"

import { readFile } from "node:fs/promises"

import { listProjectCampaigns, resolveProject } from "../lib/api"
import { descriptionOption, optionalFlag, type Args } from "../lib/args"
import { emitEvent } from "../lib/events"
import { currentCommit, repoRoot } from "../lib/git"
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
  readLastRun,
  readState,
  writeLastRun,
  writeState,
  type LastRunRecord,
} from "../lib/outbox"
import {
  campaignStateKey,
  onyxPath,
  resolveProjectPath,
  scopedRoot,
} from "../lib/project"
import { pathExists, runProcess } from "../lib/process"
import { flushOutbox } from "../lib/sync"
import { renderExperimentTable } from "../lib/tui"

type ExperimentStatus = LocalResearchCampaignExperimentLoggedRecord["status"]
type ChecksRecord = NonNullable<
  LocalResearchCampaignExperimentLoggedRecord["checks"]
>

async function syncAfterRecord(root: string, args: Args, recordName: string) {
  await flushOutbox(root, args).catch((error) => {
    console.warn(
      `Recorded ${recordName} locally; sync failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  })
}

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
    value === "accepted" ||
    value === "rejected"
  ) {
    return value
  }

  throw new Error(
    "--status must be queued, running, succeeded, failed, checks_failed, accepted, or rejected"
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

async function assertEvalReady(evalSh: string) {
  if (!(await pathExists(evalSh))) {
    throw new Error(
      `Missing ${evalSh}. Create onyx/eval.sh before running experiments.`
    )
  }

  const text = await readFile(evalSh, "utf8")
  if (text.includes("ONYX_STUB_EVAL")) {
    throw new Error(
      `${evalSh} still contains ONYX_STUB_EVAL. Replace the stub with a real eval before running experiments.`
    )
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
  const checksSh = onyxPath(root, projectPath, "checks.sh")
  if (!(await pathExists(checksSh))) return null

  const started = Date.now()
  const result = await runProcess("bash", [checksSh], {
    cwd: scopedRoot(root, projectPath),
    timeoutMs,
  })
  const durationMs = Date.now() - started
  const outputSummary = summarizeOutput(result.stdout, result.stderr) || null

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
  await flushOutbox(root, args, { quiet: true }).catch(() => {})

  const state = await readState(root)
  const key = campaignStateKey(projectPath, campaignName)
  const cached = state.campaigns?.[key]
  if (cached?.campaignId && cached.metricName && cached.baseCommitSha) {
    return {
      campaignId: cached.campaignId,
      setupId: cached.setupId,
      laneId: cached.laneId,
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
      `Campaign ${campaignName} is not synced. Run \`onyx campaign setup --name ${campaignName} --metric <metric>\` and \`onyx sync\`.`
    )
  }

  state.projectId = project.id
  state.projectPath = projectPath
  state.activeCampaign = campaignName
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    setupId: campaign.activeSetupId ?? undefined,
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
    setupId: campaign.activeSetupId ?? undefined,
    laneId: state.campaigns[key]?.laneId,
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
  const resultCommitSha = await currentCommit(root)
  const evalSh = onyxPath(root, projectPath, "eval.sh")
  await assertEvalReady(evalSh)

  const timeoutMs = numberOption(args, "timeout", 600) * 1000
  const checksTimeoutMs = numberOption(args, "checks-timeout", 300) * 1000
  const started = new Date()
  const runRef = clientRunRef(campaignName)
  const resultRef = `refs/onyx/experiments/${campaign.campaignId}/${safeRefSegment(runRef)}`
  await emitEvent(root, {
    type: "exp_run_started",
    campaignName,
    campaignId: campaign.campaignId,
    runRef,
    commitSha: resultCommitSha,
    resultRef,
  })
  const result = await runProcess("bash", [evalSh], {
    cwd: scopedRoot(root, projectPath),
    timeoutMs,
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
  const status: ExperimentStatus = !benchmarkSucceeded
    ? "failed"
    : checks && checks.status !== "passed"
      ? "checks_failed"
      : "succeeded"
  const setupId =
    args.options.setup ?? process.env.ONYX_SETUP_ID ?? campaign.setupId
  if (!setupId) {
    throw new Error(
      "No active setup id. Run `onyx setup validate` or pass --setup <id>."
    )
  }
  const laneId =
    args.options.lane ?? process.env.ONYX_LANE_ID ?? campaign.laneId
  const sessionId = args.options.session ?? process.env.ONYX_SESSION_ID
  const workerId = args.options.worker ?? process.env.ONYX_WORKER_ID

  const outputSummaryParts = [
    result.timedOut ? `Eval timed out after ${timeoutMs / 1000}s.` : "",
    result.code === 0 && primary.value === null
      ? `No METRIC line found for ${campaign.metricName}.`
      : "",
    summarizeOutput(result.stdout, result.stderr),
  ].filter(Boolean)
  const outputSummary = outputSummaryParts.join("\n").slice(0, 4000) || null

  if (optionalFlag(args, "no-log")) {
    console.log(JSON.stringify({ metrics, status, checks }, null, 2))
    if (result.code !== 0) process.exitCode = result.code ?? 1
    return
  }

  const record: LastRunRecord = {
    schemaVersion: 1,
    createdAt: completed.toISOString(),
    runRef,
    campaignName,
    projectPath,
    baseCommitSha: campaign.baseCommitSha,
    resultCommitSha,
    resultRef,
    status,
    primaryMetricName: primary.name,
    primaryMetricValue: primary.value,
    metrics,
    agentNotes: {},
    checks,
    durationMs: completed.getTime() - started.getTime(),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    outputSummary,
    setupId,
    sessionId,
    workerId,
    laneId,
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

  if (!benchmarkSucceeded || status === "checks_failed") {
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
  const setupId =
    args.options.setup ??
    usableLastRun?.setupId ??
    process.env.ONYX_SETUP_ID ??
    campaign.setupId
  if (!setupId) {
    throw new Error(
      "No active setup id. Run `onyx setup validate` or pass --setup <id>."
    )
  }
  const laneId =
    args.options.lane ??
    usableLastRun?.laneId ??
    process.env.ONYX_LANE_ID ??
    campaign.laneId
  const sessionId =
    args.options.session ??
    usableLastRun?.sessionId ??
    process.env.ONYX_SESSION_ID
  const workerId =
    args.options.worker ?? usableLastRun?.workerId ?? process.env.ONYX_WORKER_ID

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
    status,
    primaryMetricName: metricName,
    primaryMetricValue: metricValue,
    metrics,
    agentNotes: parseAgentNotes(args.options["agent-notes"]),
    checks,
    durationMs: usableLastRun?.durationMs ?? null,
    startedAt: usableLastRun?.startedAt ?? null,
    completedAt: usableLastRun?.completedAt ?? completedAt,
    outputSummary: usableLastRun?.outputSummary ?? null,
    setupId,
    sessionId,
    workerId,
    laneId,
  }
  await appendOutbox(root, record)
  await appendHistory(root, experimentRecordToHistory(record)).catch(() => {})
  await emitEvent(root, {
    type: "exp_logged",
    campaignName,
    campaignId: campaign.campaignId,
    runRef,
    commitSha: resultCommitSha,
    resultRef,
    message: `${record.name} (${status})`,
  })
  console.log(
    `Recorded ${record.name} (${status}) for campaign ${campaignName}`
  )
  if (usableLastRun) await clearLastRun(root)

  await syncAfterRecord(root, args, record.name)
}

export async function commandExpList(args: Args) {
  const root = await repoRoot()
  const { records, corrupt } = await readHistory(root)
  if (corrupt > 0) {
    console.warn(`Skipped ${corrupt} unreadable history record(s).`)
  }

  const rows: LocalResearchHistoryRecord[] = [...records]

  const lastRun = await readLastRun(root)
  if (lastRun && !rows.some((row) => row.runRef === lastRun.runRef)) {
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
      setupId: lastRun.setupId,
      sessionId: lastRun.sessionId,
      workerId: lastRun.workerId,
      laneId: lastRun.laneId,
    })
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
      records.length === 0
        ? "No experiments recorded yet. Run `onyx sync` to hydrate from the Onyx app."
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
