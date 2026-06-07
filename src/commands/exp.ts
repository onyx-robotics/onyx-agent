import type {
  LocalResearchExperimentLoggedRecord,
  LocalResearchHistoryRecord,
} from "../protocol"

import { readFile } from "node:fs/promises"

import { descriptionOption, optionalFlag, type Args } from "../lib/args"
import { emitEvent } from "../lib/events"
import { currentBranch, currentCommit, repoRoot } from "../lib/git"
import {
  appendHistory,
  experimentRecordToHistory,
  readHistory,
} from "../lib/history"
import { branchMetadata, resolveBranchName } from "../lib/markdown"
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
  writeLastRun,
  type LastRunRecord,
} from "../lib/outbox"
import { onyxPath, resolveProjectPath, scopedRoot } from "../lib/project"
import { pathExists, runProcess } from "../lib/process"
import { flushOutbox } from "../lib/sync"
import { renderExperimentTable } from "../lib/tui"

type ExperimentStatus = LocalResearchExperimentLoggedRecord["status"]
type ChecksRecord = NonNullable<LocalResearchExperimentLoggedRecord["checks"]>

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

export async function commandExpRun(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const branchName = await resolveBranchName(root, args.options.branch)
  const gitBranchName = await currentBranch(root)
  const commitSha = await currentCommit(root)
  const branch = await branchMetadata({
    root,
    projectPath,
    branchName,
    gitBranchName,
  })
  const evalSh = onyxPath(root, projectPath, "eval.sh")
  await assertEvalReady(evalSh)

  const timeoutMs = numberOption(args, "timeout", 600) * 1000
  const checksTimeoutMs = numberOption(args, "checks-timeout", 300) * 1000
  const started = new Date()
  const runRef = clientRunRef(branchName)
  await emitEvent(root, { type: "exp_run_started", branchName, commitSha })
  const result = await runProcess("bash", [evalSh], {
    cwd: scopedRoot(root, projectPath),
    timeoutMs,
  })
  const completed = new Date()
  const metrics = parseMetricLines(result.stdout, branch.metricName)
  const primary = primaryMetric(metrics, branch.metricName)
  const benchmarkSucceeded =
    result.code === 0 && !result.timedOut && primary.value !== null
  await emitEvent(root, {
    type: "eval_finished",
    branchName,
    commitSha,
    message: `${primary.name}=${primary.value ?? "null"} (${benchmarkSucceeded ? "ok" : "failed"})`,
  })
  const checks = benchmarkSucceeded
    ? await runChecks({ root, projectPath, timeoutMs: checksTimeoutMs })
    : null
  if (checks) {
    await emitEvent(root, {
      type: "checks_finished",
      branchName,
      commitSha,
      message: checks.status,
    })
  }
  const status: ExperimentStatus = !benchmarkSucceeded
    ? "failed"
    : checks && checks.status !== "passed"
      ? "checks_failed"
      : "succeeded"

  const outputSummaryParts = [
    result.timedOut ? `Eval timed out after ${timeoutMs / 1000}s.` : "",
    result.code === 0 && primary.value === null
      ? `No METRIC line found for ${branch.metricName}.`
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
    branchName,
    gitBranchName,
    projectPath,
    commitSha,
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
  }
  await writeLastRun(root, record)
  await emitEvent(root, {
    type: "run_finished",
    branchName,
    commitSha,
    message: status,
  })
  console.log(
    `Measured ${commitSha.slice(0, 7)} (${primary.name}=${primary.value ?? "null"}, ${status}); runRef ${runRef}`
  )
  console.log("Run `onyx exp log --description <text>` to record this result.")

  if (!benchmarkSucceeded || status === "checks_failed") {
    process.exitCode = result.code && result.code !== 0 ? result.code : 1
  }
}

export async function commandExpLog(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const branchName = await resolveBranchName(root, args.options.branch)
  const gitBranchName = await currentBranch(root)
  const lastRun = await readLastRun(root)
  const usableLastRun =
    lastRun?.branchName === branchName && lastRun.projectPath === projectPath
      ? lastRun
      : null
  const commitSha =
    args.options.commit ??
    usableLastRun?.commitSha ??
    (await currentCommit(root))
  const branch = await branchMetadata({
    root,
    projectPath,
    branchName,
    gitBranchName,
  })
  const metricName =
    args.options["metric-name"] ??
    usableLastRun?.primaryMetricName ??
    branch.metricName
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

  const record: LocalResearchExperimentLoggedRecord = {
    schemaVersion: 1,
    type: "experiment_logged",
    createdAt: completedAt,
    runRef: usableLastRun?.runRef ?? clientRunRef(branchName),
    branchName,
    name: args.options.name ?? `experiment-${commitSha.slice(0, 7)}`,
    description: descriptionOption(args),
    gitBranchName,
    projectPath,
    commitSha,
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
  }
  await appendOutbox(root, record)
  // Permanent local history row; superseded by the canonical record on sync.
  await appendHistory(root, experimentRecordToHistory(record)).catch(() => {})
  await emitEvent(root, {
    type: "exp_logged",
    branchName,
    commitSha,
    message: `${record.name} (${status})`,
  })
  console.log(`Recorded ${record.name} (${status})`)
  if (usableLastRun) await clearLastRun(root)

  await syncAfterRecord(root, args, record.name)
}

/**
 * Searches the local history cache (`.git/onyx/history.jsonl`). Works fully
 * offline; run `onyx sync` first to hydrate cross-branch canonical history.
 */
export async function commandExpList(args: Args) {
  const root = await repoRoot()
  const { records, corrupt } = await readHistory(root)
  if (corrupt > 0) {
    console.warn(`Skipped ${corrupt} unreadable history record(s).`)
  }

  const rows: LocalResearchHistoryRecord[] = [...records]

  // Surface a measured-but-unlogged run so the latest attempt is never hidden.
  const lastRun = await readLastRun(root)
  if (lastRun && !rows.some((row) => row.runRef === lastRun.runRef)) {
    rows.push({
      schemaVersion: 1,
      source: "local",
      branchName: lastRun.branchName,
      gitBranchName: lastRun.gitBranchName,
      runRef: lastRun.runRef,
      commitSha: lastRun.commitSha,
      status: lastRun.status,
      name: `(unlogged) ${lastRun.commitSha.slice(0, 7)}`,
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
    })
  }

  let filtered = rows
  if (args.options.branch) {
    filtered = filtered.filter((row) => row.branchName === args.options.branch)
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

  // Newest first for reading; the file itself stays branch-grouped.
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
    // The branch column is redundant when filtering to a single branch.
    showBranch: !args.options.branch,
  })
  for (const line of lines) console.log(line)
  if (filtered.length > limited.length) {
    console.log(
      `… ${filtered.length - limited.length} more; raise --limit to see all.`
    )
  }
}
