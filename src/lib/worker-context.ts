import { readFile } from "node:fs/promises"

import type { ResearchHypothesisPlan } from "../protocol"
import type { Args } from "./args"

export const ONYX_WORKER_CONTEXT = "ONYX_WORKER_CONTEXT"

export type WorkerRuntimeContext = {
  schemaVersion: 5
  campaignId: string
  campaignName: string
  sessionId: string
  assignmentId: string
  startingCommitSha: string
  hypothesisId: string
  hypothesisName: string
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
  worktreeRoot: string
  projectPath: string
  projectRoot: string
  setupFile: string
  validationFile: string
  researchSpecFile: string
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

export async function readWorkerRuntimeContext() {
  const path = contextPath()
  if (!path) return null
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid worker context at ${path}: expected object`)
  }
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== 5) {
    throw new Error(`Invalid worker context at ${path}: unsupported schema`)
  }

  const assignment = objectField(record, "assignment")
  const hypothesis = objectField(record, "hypothesis")
  const plan = hypothesis ? objectField(hypothesis, "plan") : null
  if (!assignment || !hypothesis || !plan) {
    throw new Error(
      `Invalid worker context at ${path}: missing assignment or hypothesis guidance`
    )
  }

  const context: WorkerRuntimeContext = {
    schemaVersion: 5,
    campaignId: stringField(record, "campaignId") ?? "",
    campaignName: stringField(record, "campaignName") ?? "",
    sessionId: stringField(record, "sessionId") ?? "",
    assignmentId: stringField(record, "assignmentId") ?? "",
    startingCommitSha: stringField(record, "startingCommitSha") ?? "",
    hypothesisId: stringField(record, "hypothesisId") ?? "",
    hypothesisName: stringField(record, "hypothesisName") ?? "",
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
    worktreeRoot: stringField(record, "worktreeRoot") ?? "",
    projectPath: stringField(record, "projectPath") ?? "",
    projectRoot: stringField(record, "projectRoot") ?? "",
    setupFile: stringField(record, "setupFile") ?? "",
    validationFile: stringField(record, "validationFile") ?? "",
    researchSpecFile: stringField(record, "researchSpecFile") ?? "",
  }

  const missing = Object.entries(context)
    .filter(
      ([key, value]) =>
        key !== "projectPath" && typeof value === "string" && value === ""
    )
    .map(([key]) => key)
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

export async function assertWorkerContextArgs(args: Args) {
  const context = await readWorkerRuntimeContext()
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
  assertSameOption({
    args,
    name: "cwd",
    expected: context.worktreeRoot,
    label: "worktree",
  })
  assertSameOption({
    args,
    name: "project-path",
    expected: context.projectPath,
    label: "project path",
  })

  return context
}
