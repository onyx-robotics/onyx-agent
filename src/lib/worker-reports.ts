import { readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export type WorkerReportMarker = {
  schemaVersion: 1
  workerId: string
  sessionId: string
  hypothesisId: string
  reportedExperimentCount: number
  lastRunRef: string
  lastReportedAt: string
}

export function workerReportMarkerPath(contextPath: string) {
  return join(dirname(contextPath), "report-marker.json")
}

export async function readWorkerReportMarker(contextPath: string) {
  try {
    const marker = JSON.parse(
      await readFile(workerReportMarkerPath(contextPath), "utf8")
    ) as WorkerReportMarker
    if (
      marker.schemaVersion !== 1 ||
      !marker.workerId ||
      !marker.sessionId ||
      !marker.hypothesisId ||
      !Number.isInteger(marker.reportedExperimentCount) ||
      marker.reportedExperimentCount < 1
    ) {
      return null
    }
    return marker
  } catch {
    return null
  }
}

/**
 * Records successful remote report delivery for immediate supervisor teardown
 * classification. Supabase remains authoritative and replaces this provisional
 * count with its exact experiment count when the terminal heartbeat is stored.
 */
export async function recordWorkerReportedExperiment({
  contextPath,
  workerId,
  sessionId,
  hypothesisId,
  runRef,
}: {
  contextPath: string
  workerId: string
  sessionId: string
  hypothesisId: string
  runRef: string
}) {
  const previous = await readWorkerReportMarker(contextPath)
  const matchesWorker =
    previous?.workerId === workerId &&
    previous.sessionId === sessionId &&
    previous.hypothesisId === hypothesisId
  const alreadyRecorded = matchesWorker && previous.lastRunRef === runRef
  const marker: WorkerReportMarker = {
    schemaVersion: 1,
    workerId,
    sessionId,
    hypothesisId,
    reportedExperimentCount: alreadyRecorded
      ? previous.reportedExperimentCount
      : (matchesWorker ? previous.reportedExperimentCount : 0) + 1,
    lastRunRef: runRef,
    lastReportedAt: new Date().toISOString(),
  }
  const path = workerReportMarkerPath(contextPath)
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporaryPath, path)
  return marker
}
