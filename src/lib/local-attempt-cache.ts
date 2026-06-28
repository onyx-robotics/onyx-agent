import { randomUUID } from "node:crypto"
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import type { LocalResearchCampaignExperimentLoggedRecord } from "../protocol"

import { onyxStateDir } from "./runtime-state"

export type CachedAttemptRecord = Omit<
  LocalResearchCampaignExperimentLoggedRecord,
  "type" | "schemaVersion" | "createdAt" | "name" | "description"
> & {
  schemaVersion: 1
  createdAt: string
}

export type CachedAttemptSelector = {
  runRef?: string
  campaignName?: string
  projectPath?: string
  sessionId?: string
  workerId?: string
  hypothesisId?: string
  unscopedOnly?: boolean
}

export async function unscopedAttemptPath(root: string) {
  return join(await onyxStateDir(root), "last-run.json")
}

export async function cachedAttemptsDir(root: string) {
  const dir = join(await onyxStateDir(root), "last-runs")
  await mkdir(dir, { recursive: true })
  return dir
}

function attemptFileName(runRef: string) {
  return `${encodeURIComponent(runRef)}.json`
}

export async function scopedCachedAttemptPath(root: string, runRef: string) {
  return join(await cachedAttemptsDir(root), attemptFileName(runRef))
}

export function clientRunRef(campaignName: string) {
  return `local/${campaignName}/${randomUUID()}`
}

async function readAttemptFile(
  path: string
): Promise<CachedAttemptRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"))
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schemaVersion === 1 &&
      typeof parsed.runRef === "string"
    ) {
      return parsed as CachedAttemptRecord
    }
  } catch {
    return null
  }

  return null
}

function shouldWriteScopedAttempt(record: CachedAttemptRecord) {
  return Boolean(record.workerId || record.sessionId || record.hypothesisId)
}

function matchesCachedAttempt(
  record: CachedAttemptRecord,
  selector: CachedAttemptSelector
) {
  return (
    (!selector.runRef || record.runRef === selector.runRef) &&
    (!selector.campaignName || record.campaignName === selector.campaignName) &&
    (selector.projectPath === undefined ||
      record.projectPath === selector.projectPath) &&
    (!selector.sessionId || record.sessionId === selector.sessionId) &&
    (!selector.workerId || record.workerId === selector.workerId) &&
    (!selector.hypothesisId || record.hypothesisId === selector.hypothesisId)
  )
}

export async function readCachedAttempts(
  root: string
): Promise<CachedAttemptRecord[]> {
  const byRunRef = new Map<string, CachedAttemptRecord>()
  const unscoped = await readAttemptFile(await unscopedAttemptPath(root))
  if (unscoped) byRunRef.set(unscoped.runRef, unscoped)

  let entries: string[] = []
  try {
    entries = await readdir(await cachedAttemptsDir(root))
  } catch {
    entries = []
  }

  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const record = await readAttemptFile(
          join(await cachedAttemptsDir(root), entry)
        )
        if (record) byRunRef.set(record.runRef, record)
      })
  )

  return [...byRunRef.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  )
}

export async function readCachedAttempt(
  root: string,
  selector: CachedAttemptSelector = {}
): Promise<CachedAttemptRecord | null> {
  if (selector.unscopedOnly) {
    const unscoped = await readAttemptFile(await unscopedAttemptPath(root))
    return unscoped && matchesCachedAttempt(unscoped, selector)
      ? unscoped
      : null
  }

  const attempts = await readCachedAttempts(root)
  return (
    attempts.find((record) => matchesCachedAttempt(record, selector)) ?? null
  )
}

export async function writeCachedAttempt(
  root: string,
  record: CachedAttemptRecord
) {
  const path = shouldWriteScopedAttempt(record)
    ? await scopedCachedAttemptPath(root, record.runRef)
    : await unscopedAttemptPath(root)
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export async function clearCachedAttempt(
  root: string,
  selector: CachedAttemptSelector = { unscopedOnly: true }
) {
  if (selector.runRef && !selector.unscopedOnly) {
    await unlink(await scopedCachedAttemptPath(root, selector.runRef)).catch(
      () => {}
    )
    const unscoped = await readAttemptFile(await unscopedAttemptPath(root))
    if (unscoped?.runRef === selector.runRef) {
      await unlink(await unscopedAttemptPath(root)).catch(() => {})
    }
    return
  }

  const attempts = selector.unscopedOnly
    ? [await readAttemptFile(await unscopedAttemptPath(root))]
    : await readCachedAttempts(root)
  await Promise.all(
    attempts
      .filter((record): record is CachedAttemptRecord => Boolean(record))
      .filter((record) => matchesCachedAttempt(record, selector))
      .map(async (record) => {
        const path = shouldWriteScopedAttempt(record)
          ? await scopedCachedAttemptPath(root, record.runRef)
          : await unscopedAttemptPath(root)
        await unlink(path).catch(() => {})
      })
  )

  try {
    if (selector.unscopedOnly) await unlink(await unscopedAttemptPath(root))
  } catch {
    // no cached attempt to clear
  }
}
