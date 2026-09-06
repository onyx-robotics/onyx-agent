import { readFile, realpath } from "node:fs/promises"
import { sep } from "node:path"

import type { ResearchHypothesisPlan } from "../protocol"
import type { Args } from "./args"
import { repoRoot } from "./git"
import { normalizeProjectPath } from "./project-path"
import { ONYX_WORKER_CONTEXT_SCHEMA_VERSION } from "./version"

export const ONYX_WORKER_CONTEXT = "ONYX_WORKER_CONTEXT"

export type WorkerRuntimeContext = {
  schemaVersion: typeof ONYX_WORKER_CONTEXT_SCHEMA_VERSION
  deliveryDestination?: import("./report-delivery").DeliveryDestination
  campaignId: string
  campaignName: string
  sessionId: string
  assignmentId: string
  startingCommitSha: string
  hypothesisId: string
  hypothesisName: string
  campaign: {
    id: string
    name: string
    metricName: string
    metricUnit: string | null
    metricDirection: "maximize" | "minimize"
    /** Campaign-level base; workers pin attempts to the assignment starting
     * commit instead, so this is display/fallback metadata only. */
    baseCommitSha: string | null
  }
  assignment: {
    id: string
    startingCommitSha: string
    sourceExperimentId: string | null
  }
  hypothesis: {
    id: string
    name: string
    description: string | null
    status: "active" | "closed"
    plan: ResearchHypothesisPlan
    bestMetricValue: number | null
    bestCommitSha: string | null
    experimentCount: number
    lastWorkedAt: string | null
  }
  workerId: string
  workerCredential: string
  /** Supervisor-pinned worker CLI wrapper. Any `onyx-worker` entrypoint that
   * starts inside this runtime re-execs it, so bare PATH resolution always
   * lands on the supervised CLI even when login shells reorder PATH. */
  workerCliPath: string
  worktreeRoot: string
  projectPath: string
  projectRoot: string
  setupFile: string
  validationFile: string
  researchSpecFile: string
  /** Last moment to start new exploration (session deadline minus the
   * shutdown cushion); null when the session has no deadline. */
  researchDeadlineAt: string | null
  /** Hard exit moment for the worker; null when the session has no deadline. */
  shutdownDeadlineAt: string | null
  shutdownCushionSeconds: number | null
}

function contextPath() {
  const value = process.env[ONYX_WORKER_CONTEXT]?.trim()
  return value || null
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value : null
}

function objectField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

let cachedContext: {
  path: string
  context: WorkerRuntimeContext
} | null = null

/**
 * Memoized worker runtime context. The supervisor writes context.json once
 * before launch and never mutates it, so a per-process cache is safe.
 */
export async function getWorkerRuntimeContextCached() {
  const path = contextPath()
  if (!path) return null
  if (cachedContext && cachedContext.path === path) return cachedContext.context
  const context = await readWorkerRuntimeContext()
  if (context) cachedContext = { path, context }
  return context
}

export async function readWorkerRuntimeContext() {
  const path = contextPath()
  if (!path) return null
  return parseWorkerRuntimeContext(path)
}

/**
 * Strictly parse and validate a worker runtime context file. Throws an
 * actionable error on any problem — a set ONYX_WORKER_CONTEXT that cannot be
 * read is a broken supervised runtime, never something to silently ignore.
 */
export async function parseWorkerRuntimeContext(path: string) {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(
      `Supervised worker context at ${path} is missing or unreadable. Stop this worker and let the supervisor relaunch it.`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid worker context at ${path}: not valid JSON`)
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid worker context at ${path}: expected object`)
  }
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== ONYX_WORKER_CONTEXT_SCHEMA_VERSION) {
    throw new Error(`Invalid worker context at ${path}: unsupported schema`)
  }

  const campaign = objectField(record, "campaign")
  const assignment = objectField(record, "assignment")
  const hypothesis = objectField(record, "hypothesis")
  const plan = hypothesis ? objectField(hypothesis, "plan") : null
  if (!campaign || !assignment || !hypothesis || !plan) {
    throw new Error(
      `Invalid worker context at ${path}: missing campaign, assignment, or hypothesis guidance`
    )
  }

  const context: WorkerRuntimeContext = {
    schemaVersion: ONYX_WORKER_CONTEXT_SCHEMA_VERSION,
    deliveryDestination:
      record.deliveryDestination as WorkerRuntimeContext["deliveryDestination"],
    campaignId: stringField(record, "campaignId") ?? "",
    campaignName: stringField(record, "campaignName") ?? "",
    sessionId: stringField(record, "sessionId") ?? "",
    assignmentId: stringField(record, "assignmentId") ?? "",
    startingCommitSha: stringField(record, "startingCommitSha") ?? "",
    hypothesisId: stringField(record, "hypothesisId") ?? "",
    hypothesisName: stringField(record, "hypothesisName") ?? "",
    campaign: {
      id: stringField(campaign, "id") ?? "",
      name: stringField(campaign, "name") ?? "",
      metricName: stringField(campaign, "metricName") ?? "",
      metricUnit: stringField(campaign, "metricUnit") ?? null,
      metricDirection:
        campaign.metricDirection === "minimize" ? "minimize" : "maximize",
      baseCommitSha: stringField(campaign, "baseCommitSha") || null,
    },
    assignment: {
      id: stringField(assignment, "id") ?? "",
      startingCommitSha: stringField(assignment, "startingCommitSha") ?? "",
      sourceExperimentId: stringField(assignment, "sourceExperimentId") ?? null,
    },
    hypothesis: {
      id: stringField(hypothesis, "id") ?? "",
      name: stringField(hypothesis, "name") ?? "",
      description: stringField(hypothesis, "description") ?? null,
      status: hypothesis.status === "closed" ? "closed" : "active",
      plan: plan as ResearchHypothesisPlan,
      bestMetricValue:
        typeof hypothesis.bestMetricValue === "number"
          ? hypothesis.bestMetricValue
          : null,
      bestCommitSha: stringField(hypothesis, "bestCommitSha") ?? null,
      experimentCount:
        typeof hypothesis.experimentCount === "number"
          ? hypothesis.experimentCount
          : 0,
      lastWorkedAt: stringField(hypothesis, "lastWorkedAt") ?? null,
    },
    workerId: stringField(record, "workerId") ?? "",
    workerCredential: stringField(record, "workerCredential") ?? "",
    workerCliPath: stringField(record, "workerCliPath") ?? "",
    worktreeRoot: stringField(record, "worktreeRoot") ?? "",
    projectPath: stringField(record, "projectPath") ?? "",
    projectRoot: stringField(record, "projectRoot") ?? "",
    setupFile: stringField(record, "setupFile") ?? "",
    validationFile: stringField(record, "validationFile") ?? "",
    researchSpecFile: stringField(record, "researchSpecFile") ?? "",
    researchDeadlineAt: stringField(record, "researchDeadlineAt"),
    shutdownDeadlineAt: stringField(record, "shutdownDeadlineAt"),
    shutdownCushionSeconds:
      typeof record.shutdownCushionSeconds === "number" &&
      Number.isFinite(record.shutdownCushionSeconds)
        ? record.shutdownCushionSeconds
        : null,
  }

  const missing = Object.entries(context)
    .filter(
      ([key, value]) =>
        key !== "projectPath" && typeof value === "string" && value === ""
    )
    .map(([key]) => key)
  if (
    !context.campaign.id ||
    !context.campaign.name ||
    !context.campaign.metricName
  ) {
    missing.push("campaign")
  }
  if (!context.assignment.id || !context.assignment.startingCommitSha) {
    missing.push("assignment")
  }
  if (!context.hypothesis.id || !context.hypothesis.name) {
    missing.push("hypothesis")
  }
  if (missing.length > 0) {
    throw new Error(
      `Invalid worker context at ${path}: missing ${missing.join(", ")}`
    )
  }

  return context
}

function assertSameOption({
  args,
  name,
  expected,
  label,
}: {
  args: Args
  name: string
  expected: string
  label: string
}) {
  const actual = args.options[name]
  if (actual !== undefined && actual !== expected) {
    throw new Error(
      `--${name} conflicts with supervised worker context ${label} ${expected}`
    )
  }
}

/**
 * Authoritative supervised-worker scope resolution. Inside a worker runtime
 * (ONYX_WORKER_CONTEXT set) the context is the single source of scope:
 * conflicting identity flags are rejected, the process must run inside the
 * assigned worktree and project root, and every scope option the commands read
 * is filled from the context so no command falls back to shared convenience
 * state. Outside a worker runtime this is a no-op returning null.
 */
export async function resolveWorkerScope(args: Args) {
  const context = await getWorkerRuntimeContextCached()
  if (!context) return null

  if (args.options.profile !== undefined) {
    throw new Error(
      "--profile is not allowed in a supervised worker context; the worker runtime pins authentication."
    )
  }
  if (args.options["api-url"] !== undefined) {
    throw new Error(
      "--api-url is not allowed in a supervised worker context; the worker runtime pins the API target."
    )
  }
  if (args.options.project !== undefined) {
    throw new Error(
      "--project is not allowed in a supervised worker context; the worker runtime pins the project."
    )
  }

  assertSameOption({
    args,
    name: "campaign",
    expected: context.campaignName,
    label: "campaign",
  })
  assertSameOption({
    args,
    name: "session",
    expected: context.sessionId,
    label: "session",
  })
  assertSameOption({
    args,
    name: "assignment",
    expected: context.assignmentId,
    label: "assignment",
  })
  assertSameOption({
    args,
    name: "hypothesis",
    expected: context.hypothesisId,
    label: "hypothesis",
  })
  assertSameOption({
    args,
    name: "worker",
    expected: context.workerId,
    label: "worker",
  })
  if (
    args.options["project-path"] !== undefined &&
    normalizeProjectPath(args.options["project-path"]) !==
      normalizeProjectPath(context.projectPath)
  ) {
    throw new Error(
      `--project-path conflicts with supervised worker context project path "${context.projectPath}"`
    )
  }

  await assertWorkerRootBoundary(args, context)

  args.options.campaign ??= context.campaignName
  args.options.session ??= context.sessionId
  args.options.assignment ??= context.assignmentId
  args.options.hypothesis ??= context.hypothesisId
  args.options.worker ??= context.workerId
  args.options["project-path"] ??= context.projectPath
  args.options.cwd ??= context.worktreeRoot

  return context
}

/**
 * A supervised worker may only operate inside its assigned worktree and
 * project scope; a worker command invoked from another checkout must fail
 * before reading setup, touching git, or calling the API.
 */
async function assertWorkerRootBoundary(
  args: Args,
  context: WorkerRuntimeContext
) {
  const effectiveCwd = args.options.cwd ?? process.cwd()
  const realWorktree = await realpath(context.worktreeRoot)
  let realCwd: string
  let realRoot: string
  try {
    realCwd = await realpath(effectiveCwd)
    realRoot = await realpath(await repoRoot(effectiveCwd))
  } catch {
    throw new Error(
      `This onyx-worker is scoped to worktree ${context.worktreeRoot} but is not running inside a git checkout (cwd ${effectiveCwd}). Run worker commands from the assigned worktree.`
    )
  }
  if (realRoot !== realWorktree) {
    throw new Error(
      `This onyx-worker is scoped to worktree ${context.worktreeRoot} but is running inside ${realRoot}. Run worker commands from the assigned worktree.`
    )
  }
  const realProjectRoot = await realpath(context.projectRoot)
  if (
    realCwd !== realProjectRoot &&
    !realCwd.startsWith(realProjectRoot + sep)
  ) {
    throw new Error(
      `This onyx-worker is scoped to project root ${context.projectRoot} but the working directory is ${effectiveCwd}. Run worker commands from inside the project scope.`
    )
  }
}
