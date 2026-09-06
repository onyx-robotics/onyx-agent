import { randomUUID } from "node:crypto"
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
  link,
} from "node:fs/promises"
import { join } from "node:path"

import { onyxStateDir } from "./runtime-state"

export class ResourceLockContentionError extends Error {}

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
  } catch (error) {
    return errorCode(error) !== "ESRCH"
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

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code
}

async function readLock(
  path: string
): Promise<Partial<ResourceLockRecord> | null> {
  try {
    return JSON.parse(
      await readFile(path, "utf8")
    ) as Partial<ResourceLockRecord>
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw new Error(`Resource lock is unreadable or malformed: ${path}`, {
      cause: error,
    })
  }
}

/** Requires a quiescent repository: PID absence alone cannot prove children stopped. */
export async function resetResourceLocks(
  root: string,
  resourceName: string,
  dryRun = false
) {
  const dir = await resourceLockDir(root, resourceName)
  const paths = (await readdir(dir))
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => join(dir, name))
  for (const path of paths) {
    const record = await readLock(path).catch((error) => {
      if (error.cause instanceof SyntaxError) return null
      throw error
    })
    if (record?.pid && pidIsAlive(record.pid))
      throw new Error(`Resource owner is live or inaccessible: ${path}`)
  }
  if (!dryRun) {
    for (const path of paths) await unlink(path)
    await unlink(join(dir, "capacity")).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error
    })
  }
  return paths
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
  const capacityPath = join(dir, "capacity")
  const temporaryCapacity = join(dir, `.capacity-${randomUUID()}`)
  await writeFile(temporaryCapacity, String(slotCount), { flag: "wx" })
  try {
    await link(temporaryCapacity, capacityPath)
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error
  } finally {
    await unlink(temporaryCapacity)
  }
  if ((await readFile(capacityPath, "utf8")) !== String(slotCount))
    throw new Error(
      `Resource slot configuration changed or is incomplete: ${dir}. Drain holders and reset before changing capacity.`
    )
  const deadline = Date.now() + timeoutMs
  do {
    for (let slot = 0; slot < slotCount; slot += 1) {
      const path = join(dir, `${slot}.json`)
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
        let released = false
        return async () => {
          if (released) return
          released = true
          const current = await readLock(path)
          if (current?.ownerId === ownerId)
            await unlink(path).catch((error) => {
              if (errorCode(error) !== "ENOENT") throw error
            })
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
      }
    }
    if (Date.now() >= deadline) break
    await sleep(Math.min(100, deadline - Date.now()))
  } while (Date.now() <= deadline)
  throw new ResourceLockContentionError(
    `Timed out waiting for tool resource ${resourceName}; locks: ${dir}. Stop all resource users before research locks reset --resource ${resourceName} --confirm-idle.`
  )
}
