import { readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { Args } from "./args"
import { readWorkerRuntimeContext } from "./worker-context"

export type WorkerFinishReason =
  | "hypothesis_exhausted"
  | "goal_satisfied"
  | "no_viable_change"

export type WorkerFinishMarker = {
  schemaVersion: 1
  workerId: string
  sessionId: string
  hypothesisId: string
  reason: WorkerFinishReason
  summary: string
  completedAt: string
}

export function workerFinishMarkerPath(contextPath: string) {
  return join(dirname(contextPath), "finish-marker.json")
}

export async function readWorkerFinishMarker(contextPath: string) {
  try {
    return JSON.parse(
      await readFile(workerFinishMarkerPath(contextPath), "utf8")
    ) as WorkerFinishMarker
  } catch {
    return null
  }
}

export async function commandResearchFinish(args: Args) {
  const context = await readWorkerRuntimeContext()
  const contextPath = process.env.ONYX_WORKER_CONTEXT?.trim()
  if (!context || !contextPath) {
    throw new Error("research finish requires a supervised worker context")
  }
  const reason = args.options.reason as WorkerFinishReason | undefined
  if (
    reason !== "hypothesis_exhausted" &&
    reason !== "goal_satisfied" &&
    reason !== "no_viable_change"
  ) {
    throw new Error(
      "Pass --reason hypothesis_exhausted|goal_satisfied|no_viable_change."
    )
  }
  const summary = args.options.summary?.trim()
  if (!summary) throw new Error("Pass a non-empty --summary.")
  const marker: WorkerFinishMarker = {
    schemaVersion: 1,
    workerId: context.workerId,
    sessionId: context.sessionId,
    hypothesisId: context.hypothesisId,
    reason,
    summary: summary.slice(0, 2000),
    completedAt: new Date().toISOString(),
  }
  const path = workerFinishMarkerPath(contextPath)
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporaryPath, path)
  console.log(`Worker finished: ${reason}`)
}
