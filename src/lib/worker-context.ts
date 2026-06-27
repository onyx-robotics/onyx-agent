import { readFile } from "node:fs/promises"

import type { Args } from "./args"

export const ONYX_WORKER_CONTEXT = "ONYX_WORKER_CONTEXT"

export type WorkerRuntimeContext = {
  schemaVersion: 1
  campaignId: string
  campaignName: string
  sessionId: string
  hypothesisId: string
  hypothesisName: string
  workerId: string
  workerBranch: string
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

export async function readWorkerRuntimeContext() {
  const path = contextPath()
  if (!path) return null
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid worker context at ${path}: expected object`)
  }
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    throw new Error(`Invalid worker context at ${path}: unsupported schema`)
  }

  const context: WorkerRuntimeContext = {
    schemaVersion: 1,
    campaignId: stringField(record, "campaignId") ?? "",
    campaignName: stringField(record, "campaignName") ?? "",
    sessionId: stringField(record, "sessionId") ?? "",
    hypothesisId: stringField(record, "hypothesisId") ?? "",
    hypothesisName: stringField(record, "hypothesisName") ?? "",
    workerId: stringField(record, "workerId") ?? "",
    workerBranch: stringField(record, "workerBranch") ?? "",
    worktreeRoot: stringField(record, "worktreeRoot") ?? "",
    projectPath: stringField(record, "projectPath") ?? "",
    projectRoot: stringField(record, "projectRoot") ?? "",
    setupFile: stringField(record, "setupFile") ?? "",
    validationFile: stringField(record, "validationFile") ?? "",
    researchSpecFile: stringField(record, "researchSpecFile") ?? "",
  }

  const missing = Object.entries(context)
    .filter(([key, value]) => key !== "projectPath" && value === "")
    .map(([key]) => key)
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
