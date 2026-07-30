import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { ApiSessionControlState } from "./api"
import { onyxStateDir } from "./runtime-state"

export const SUPERVISOR_CONTROL_STATE_STALE_MS = 10_000

export type SupervisorControlStateSnapshot = {
  schemaVersion: 1
  sequence: number
  fetchedAt: string
  control: ApiSessionControlState
}

function safeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "unknown"
}

export async function supervisorControlStatePath(
  root: string,
  sessionId: string
) {
  return join(
    await onyxStateDir(root),
    "worker-runtime",
    safeSegment(sessionId),
    "supervisor-control-state.json"
  )
}

export async function writeSupervisorControlStateSnapshot({
  root,
  sessionId,
  snapshot,
}: {
  root: string
  sessionId: string
  snapshot: SupervisorControlStateSnapshot
}) {
  const path = await supervisorControlStatePath(root, sessionId)
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await writeFile(
    temporaryPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8"
  )
  await rename(temporaryPath, path)
}

export async function readSupervisorControlStateSnapshot({
  root,
  sessionId,
}: {
  root: string
  sessionId: string
}) {
  const path = await supervisorControlStatePath(root, sessionId)
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid supervisor control state at ${path}`)
  }
  const record = parsed as Partial<SupervisorControlStateSnapshot>
  if (
    record.schemaVersion !== 1 ||
    typeof record.sequence !== "number" ||
    typeof record.fetchedAt !== "string" ||
    !record.control ||
    typeof record.control !== "object" ||
    typeof record.control.sessionId !== "string"
  ) {
    throw new Error(`Invalid supervisor control state at ${path}`)
  }
  return record as SupervisorControlStateSnapshot
}

export function supervisorControlStateIsFresh(
  snapshot: SupervisorControlStateSnapshot,
  nowMs = Date.now()
) {
  const fetchedAt = Date.parse(snapshot.fetchedAt)
  return (
    Number.isFinite(fetchedAt) &&
    nowMs - fetchedAt >= 0 &&
    nowMs - fetchedAt <= SUPERVISOR_CONTROL_STATE_STALE_MS
  )
}
