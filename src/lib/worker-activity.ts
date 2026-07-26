import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

import type { ApiWorker } from "./api"
import type { WorkerLaunchManifest } from "./worker-launcher"

export type WorkerLatestState = {
  schemaVersion: 1
  at: string
  sessionId: string
  workerId: string
  hypothesisId: string
  status: ApiWorker["status"]
  phase: string
  progressMessage: string
  metadata?: Record<string, unknown>
}

export async function writeWorkerLatestState(
  latestStatePath: string,
  state: WorkerLatestState
) {
  await mkdir(dirname(latestStatePath), { recursive: true })
  const tmp = `${latestStatePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(tmp, latestStatePath)
}

export async function readWorkerLatestState(
  manifest: WorkerLaunchManifest
): Promise<WorkerLatestState | null> {
  try {
    const parsed = JSON.parse(await readFile(manifest.latestStatePath, "utf8"))
    if (
      parsed?.schemaVersion === 1 &&
      parsed.sessionId === manifest.sessionId &&
      parsed.workerId === manifest.workerId &&
      parsed.hypothesisId === manifest.hypothesisId &&
      typeof parsed.at === "string" &&
      typeof parsed.phase === "string" &&
      typeof parsed.progressMessage === "string"
    ) {
      return parsed as WorkerLatestState
    }
  } catch {
    // Latest-state snapshots are best-effort live telemetry.
  }
  return null
}

export function activitySummaryForManifest(
  manifest: WorkerLaunchManifest,
  latest?: WorkerLatestState | null
) {
  return {
    status: manifest.status,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    latestAt: latest?.at ?? null,
    latestPhase: latest?.phase ?? null,
    exitCode: manifest.exitCode,
    signal: manifest.signal,
    timedOut: manifest.timedOut,
    startupTimedOut: manifest.startupTimedOut,
    warningCount:
      (manifest.warnings?.length ?? 0) +
      (manifest.teardown?.warnings?.length ?? 0),
    teardownStatus: manifest.teardown?.attemptDelivery ?? null,
    resultRefPushStatus: manifest.teardown?.resultRefPushStatus ?? null,
    terminalReasonCode: manifest.teardown?.reasonCode ?? null,
    worktreeCleanup: manifest.teardown?.worktreeCleanup ?? null,
    teardownError:
      manifest.teardown?.error ??
      manifest.teardown?.providerError ??
      manifest.error ??
      null,
  }
}
