import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { onyxStateDir } from "./runtime-state"

type ResourceLockRecord = {
  ownerId: string
  pid: number
  acquiredAt: string
  expiresAt: string
  metadata: Record<string, unknown>
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "resource"
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pidIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function resourceLockDir(root: string, resourceName: string) {
  const dir = join(
    await onyxStateDir(root),
    "resource-locks",
    safeSegment(resourceName)
  )
  await mkdir(dir, { recursive: true })
  return dir
}

async function readLock(path: string) {
  try {
    return JSON.parse(
      await readFile(path, "utf8")
    ) as Partial<ResourceLockRecord>
  } catch {
    return null
  }
}

async function removeStaleLock(path: string, nowMs: number) {
  const lock = await readLock(path)
  if (!lock) {
    await unlink(path).catch(() => {})
    return
  }
  const expiresAt =
    typeof lock.expiresAt === "string" ? Date.parse(lock.expiresAt) : 0
  const pid = typeof lock.pid === "number" ? lock.pid : 0
  if (expiresAt <= nowMs || !pidIsAlive(pid)) {
    await unlink(path).catch(() => {})
  }
}

export async function acquireFileResourceLease({
  root,
  resourceName,
  slots,
  timeoutMs,
  leaseMs,
  ownerId,
  metadata = {},
}: {
  root: string
  resourceName: string
  slots: number
  timeoutMs: number
  leaseMs: number
  ownerId: string
  metadata?: Record<string, unknown>
}) {
  const dir = await resourceLockDir(root, resourceName)
  const slotCount = Math.max(1, Math.floor(slots))
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    for (let slot = 0; slot < slotCount; slot += 1) {
      const path = join(dir, `${slot}.json`)
      await removeStaleLock(path, Date.now())
      const record: ResourceLockRecord = {
        ownerId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + leaseMs).toISOString(),
        metadata,
      }
      try {
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
          flag: "wx",
        })
        return async () => {
          const current = await readLock(path)
          if (current?.ownerId === ownerId) await unlink(path).catch(() => {})
        }
      } catch {
        // Slot is already held by another live process.
      }
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for tool resource ${resourceName}`)
}
