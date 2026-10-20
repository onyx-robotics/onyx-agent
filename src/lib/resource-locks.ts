import { linuxBootId } from "./linux-environment"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
  link,
} from "node:fs/promises"
import { join } from "node:path"

import { onyxStateDir } from "./runtime-state"

export class ResourceLockContentionError extends Error {}

type ResourceLockRecord = {
  bootId?: string | null
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
    if (
      record?.pid &&
      !(record.bootId && linuxBootId() && record.bootId !== linuxBootId()) &&
      pidIsAlive(record.pid)
    )
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
  const tryClaimSlot = async () => {
    for (let slot = 0; slot < slotCount; slot += 1) {
      const path = join(dir, `${slot}.json`)
      const record: ResourceLockRecord = {
        ownerId,
        bootId: linuxBootId(),
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
    return null
  }

  // A zero timeout is a single non-blocking probe and never joins the line.
  if (timeoutMs <= 0) {
    const release = await tryClaimSlot()
    if (release) return release
    throw contentionError(resourceName, dir)
  }

  // Waiters line up first come, first served: only the oldest `slotCount`
  // live tickets may claim a free slot, so no waiter can be starved.
  const ticket = await joinQueue(dir, ownerId)
  const deadline = Date.now() + timeoutMs
  try {
    do {
      if ((await queuePosition(dir, ticket)) < slotCount) {
        const release = await tryClaimSlot()
        if (release) return release
      }
      if (Date.now() >= deadline) break
      await sleep(Math.min(100, deadline - Date.now()))
    } while (Date.now() <= deadline)
  } finally {
    await unlink(ticket).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error
    })
  }
  throw contentionError(resourceName, dir)
}

function contentionError(resourceName: string, dir: string) {
  return new ResourceLockContentionError(
    `Timed out waiting for tool resource ${resourceName}; locks: ${dir}. Stop all resource users before research locks reset --resource ${resourceName} --confirm-idle.`
  )
}

type QueueTicket = {
  ownerId: string
  pid: number
  bootId?: string | null
  queuedAt: string
}

let ticketCounter = 0

async function joinQueue(dir: string, ownerId: string) {
  const queueDir = join(dir, "queue")
  await mkdir(queueDir, { recursive: true })
  ticketCounter = (ticketCounter + 1) % 1_000_000
  // Names sort by arrival time; the counter orders tickets created by one
  // process within the same millisecond.
  const name = `${String(Date.now()).padStart(15, "0")}-${String(ticketCounter).padStart(6, "0")}-${randomUUID()}.json`
  const path = join(queueDir, name)
  const ticket: QueueTicket = {
    ownerId,
    pid: process.pid,
    bootId: linuxBootId(),
    queuedAt: new Date().toISOString(),
  }
  await writeFile(path, `${JSON.stringify(ticket)}\n`, { flag: "wx" })
  return path
}

function ticketIsLive(ticket: Partial<QueueTicket> | null) {
  if (!ticket?.pid) return false
  const bootId = linuxBootId()
  if (ticket.bootId && bootId && ticket.bootId !== bootId) return false
  return pidIsAlive(ticket.pid)
}

async function liveTickets(queueDir: string) {
  const names = (await readdir(queueDir).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort()
  const live: string[] = []
  for (const name of names) {
    const path = join(queueDir, name)
    let ticket: Partial<QueueTicket> | null = null
    try {
      ticket = JSON.parse(await readFile(path, "utf8")) as Partial<QueueTicket>
    } catch (error) {
      // A ticket being written right now is briefly empty; leave it alone.
      if (errorCode(error) === "ENOENT") continue
      if (!(error instanceof SyntaxError)) throw error
      const age = await stat(path).then(
        (info) => Date.now() - info.mtimeMs,
        () => Number.POSITIVE_INFINITY
      )
      if (age < 5_000) live.push(path)
      else await unlink(path).catch(() => {})
      continue
    }
    if (ticketIsLive(ticket)) {
      live.push(path)
    } else {
      // The waiter died without leaving the line; drop its ticket.
      await unlink(path).catch(() => {})
    }
  }
  return live
}

async function queuePosition(dir: string, ticket: string) {
  const live = await liveTickets(join(dir, "queue"))
  const index = live.indexOf(ticket)
  return index === -1 ? live.length : index
}

/** Holders and waiters for one resource, for status displays. */
export async function resourceLockOccupancy(root: string, resourceName: string) {
  const dir = await resourceLockDir(root, resourceName)
  const held = (await readdir(dir).catch(() => [])).filter((name) =>
    /^\d+\.json$/.test(name)
  ).length
  const waiting = (await liveTickets(join(dir, "queue"))).length
  return { held, waiting }
}
