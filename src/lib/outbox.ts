import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import {
  localResearchRecordSchema,
  type LocalResearchCampaignExperimentLoggedRecord,
  type LocalResearchRecord,
} from "../protocol"

import { gitCommonDir } from "./git"

export type CliState = {
  projectId?: string
  projectCache?: {
    id: string
    name: string
    repositoryUrl: string
    repositoryFullName: string | null
    defaultBranch: string
    projectPath: string
    resolvedAt: string
    lastDeletionFetchAt?: string
  }
  projectPath?: string
  activeCampaign?: string
  campaigns?: Record<
    string,
    {
      campaignId?: string
      projectPath?: string
      baseCommitSha?: string | null
      description?: string | null
      metricName?: string
      metricUnit?: string | null
      metricDirection?: "maximize" | "minimize"
      setup?: Record<string, unknown>
      humanFeedback?: string | null
      promotionRefName?: string | null
      sessionId?: string
      hypothesisId?: string
      hypothesisName?: string
      workerBranch?: string
      workers?: Record<
        string,
        {
          workerId: string
          status?: string
          lastSeenAt?: string
        }
      >
    }
  >
  sessions?: Record<
    string,
    {
      campaignName?: string
      campaignId?: string
      endTimeMs?: number
      maxIterations?: number
      maxWorkerIterations?: number
      maxExperiments?: number | null
      stopRequested?: boolean
      status?: string
      finalizationStatus?:
        | "not_started"
        | "running"
        | "complete"
        | "incomplete"
        | "failed"
      ignoredPresence?: {
        total: number
        byReason: Record<string, number>
        lastAt: string | null
        recent: Array<{
          id: string
          reason: string
          message?: string
          at: string
        }>
      }
      providerBackoff?: {
        reason: string
        until: string
        attempt?: number
        delayMs?: number
      } | null
    }
  >
}

export type LastRunRecord = Omit<
  LocalResearchCampaignExperimentLoggedRecord,
  "type" | "schemaVersion" | "createdAt" | "name" | "description"
> & {
  schemaVersion: 1
  createdAt: string
}

export type LastRunSelector = {
  runRef?: string
  campaignName?: string
  projectPath?: string
  sessionId?: string
  workerId?: string
  hypothesisId?: string
  legacyOnly?: boolean
}

export async function onyxStateDir(root: string) {
  const dir = join(await gitCommonDir(root), "onyx")
  await mkdir(dir, { recursive: true })
  return dir
}

export async function outboxPath(root: string) {
  return join(await onyxStateDir(root), "outbox.jsonl")
}

export async function outboxSpoolDir(root: string) {
  const dir = join(await onyxStateDir(root), "outbox.d", "pending")
  await mkdir(dir, { recursive: true })
  return dir
}

export async function outboxConflictDir(root: string) {
  const dir = join(await onyxStateDir(root), "outbox.d", "conflicts")
  await mkdir(dir, { recursive: true })
  return dir
}

export async function statePath(root: string) {
  return join(await onyxStateDir(root), "state.json")
}

async function locksDir(root: string) {
  const dir = join(await onyxStateDir(root), "locks")
  await mkdir(dir, { recursive: true })
  return dir
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uniqueTempPath(path: string) {
  return `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
}

export async function withOnyxLock<T>(
  root: string,
  name: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const staleMs = options.staleMs ?? 120_000
  const path = join(await locksDir(root), `${name}.lock`)
  const deadline = Date.now() + timeoutMs

  while (true) {
    try {
      await mkdir(path)
      await writeFile(
        join(path, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            createdAt: new Date().toISOString(),
          },
          null,
          2
        )}\n`,
        "utf8"
      )
      break
    } catch {
      const ageMs = await stat(path)
        .then((entry) => Date.now() - entry.mtimeMs)
        .catch(() => 0)
      if (ageMs > staleMs) {
        await rm(path, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for local Onyx ${name} lock.`)
      }
      await sleep(50 + Math.floor(Math.random() * 100))
    }
  }

  try {
    return await fn()
  } finally {
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

export async function lastRunPath(root: string) {
  return join(await onyxStateDir(root), "last-run.json")
}

export async function lastRunsDir(root: string) {
  const dir = join(await onyxStateDir(root), "last-runs")
  await mkdir(dir, { recursive: true })
  return dir
}

function lastRunFileName(runRef: string) {
  return `${encodeURIComponent(runRef)}.json`
}

export async function scopedLastRunPath(root: string, runRef: string) {
  return join(await lastRunsDir(root), lastRunFileName(runRef))
}

export function clientRunRef(campaignName: string) {
  return `local/${campaignName}/${randomUUID()}`
}

export async function appendOutbox(root: string, record: LocalResearchRecord) {
  const validated = localResearchRecordSchema.parse(record)
  const dir = await outboxSpoolDir(root)
  const name = `${Date.now()}-${process.pid}-${randomUUID()}.json`
  const path = join(dir, name)
  const tmp = uniqueTempPath(path)
  await writeFile(tmp, `${JSON.stringify(validated)}\n`, "utf8")
  await rename(tmp, path)
}

export async function quarantineOutboxRecord(
  root: string,
  record: LocalResearchRecord,
  reason: string
) {
  const dir = await outboxConflictDir(root)
  const name = `${Date.now()}-${process.pid}-${randomUUID()}.json`
  const path = join(dir, name)
  const tmp = uniqueTempPath(path)
  await writeFile(
    tmp,
    `${JSON.stringify({ reason, record }, null, 2)}\n`,
    "utf8"
  )
  await rename(tmp, path)
}

export async function readOutboxConflictCount(root: string) {
  const files = await readdir(await outboxConflictDir(root)).catch(() => [])
  return files.filter((file) => file.endsWith(".json")).length
}

/**
 * Reads queued records. Corrupt or partially-written lines are skipped and
 * counted rather than thrown, so a crash mid-append never wedges the outbox.
 */
export async function readOutbox(
  root: string
): Promise<{ records: LocalResearchRecord[]; corrupt: number }> {
  const records: LocalResearchRecord[] = []
  let corrupt = 0

  let text = ""
  try {
    text = await readFile(await outboxPath(root), "utf8")
  } catch {
    text = ""
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      corrupt += 1
      continue
    }
    const result = localResearchRecordSchema.safeParse(parsed)
    if (result.success) {
      records.push(result.data)
    } else {
      corrupt += 1
    }
  }

  let files: string[] = []
  try {
    files = await readdir(await outboxSpoolDir(root))
  } catch {
    files = []
  }

  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(
        await readFile(join(await outboxSpoolDir(root), file), "utf8")
      )
      const result = localResearchRecordSchema.safeParse(parsed)
      if (result.success) {
        records.push(result.data)
      } else {
        corrupt += 1
      }
    } catch {
      corrupt += 1
    }
  }

  return { records, corrupt }
}

/** Atomically replaces the offline queue with the still-pending records. */
export async function rewriteOutbox(
  root: string,
  records: LocalResearchRecord[]
) {
  await withOnyxLock(root, "outbox", () => rewriteOutboxUnlocked(root, records))
}

export async function rewriteOutboxUnlocked(
  root: string,
  records: LocalResearchRecord[]
) {
  const legacyPath = await outboxPath(root)
  await unlink(legacyPath).catch(() => {})

  const spool = await outboxSpoolDir(root)
  const files = await readdir(spool).catch(() => [])
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => unlink(join(spool, file)).catch(() => {}))
  )

  for (const record of records) {
    await appendOutbox(root, record)
  }
}

export async function readState(root: string): Promise<CliState> {
  try {
    const parsed = JSON.parse(
      await readFile(await statePath(root), "utf8")
    ) as Partial<CliState>
    return {
      projectId: parsed.projectId,
      projectCache: parsed.projectCache,
      projectPath: parsed.projectPath,
      activeCampaign: parsed.activeCampaign,
      campaigns: parsed.campaigns ?? {},
      sessions: parsed.sessions ?? {},
    }
  } catch {
    return { campaigns: {}, sessions: {} }
  }
}

export async function writeState(root: string, state: CliState) {
  await withOnyxLock(root, "state", async () => {
    await writeStateUnlocked(root, state)
  })
}

async function writeStateUnlocked(root: string, state: CliState) {
  const path = await statePath(root)
  const tmp = uniqueTempPath(path)
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export async function updateState(
  root: string,
  updater: (state: CliState) => Promise<void> | void
): Promise<CliState> {
  return withOnyxLock(root, "state", async () => {
    const state = await readState(root)
    await updater(state)
    await writeStateUnlocked(root, state)
    return state
  })
}

async function readLastRunFile(path: string): Promise<LastRunRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"))
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schemaVersion === 1 &&
      typeof parsed.runRef === "string"
    ) {
      return parsed as LastRunRecord
    }
  } catch {
    return null
  }

  return null
}

function shouldWriteScopedLastRun(record: LastRunRecord) {
  return Boolean(record.workerId || record.sessionId || record.hypothesisId)
}

function matchesLastRunSelector(
  record: LastRunRecord,
  selector: LastRunSelector
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

export async function readLastRuns(root: string): Promise<LastRunRecord[]> {
  const byRunRef = new Map<string, LastRunRecord>()
  const legacy = await readLastRunFile(await lastRunPath(root))
  if (legacy) byRunRef.set(legacy.runRef, legacy)

  let entries: string[] = []
  try {
    entries = await readdir(await lastRunsDir(root))
  } catch {
    entries = []
  }

  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const record = await readLastRunFile(
          join(await lastRunsDir(root), entry)
        )
        if (record) byRunRef.set(record.runRef, record)
      })
  )

  return [...byRunRef.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  )
}

export async function readLastRun(
  root: string,
  selector: LastRunSelector = {}
): Promise<LastRunRecord | null> {
  if (selector.legacyOnly) {
    const legacy = await readLastRunFile(await lastRunPath(root))
    return legacy && matchesLastRunSelector(legacy, selector) ? legacy : null
  }

  const runs = await readLastRuns(root)
  return runs.find((record) => matchesLastRunSelector(record, selector)) ?? null
}

export async function writeLastRun(root: string, record: LastRunRecord) {
  const path = shouldWriteScopedLastRun(record)
    ? await scopedLastRunPath(root, record.runRef)
    : await lastRunPath(root)
  const tmp = uniqueTempPath(path)
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export async function clearLastRun(
  root: string,
  selector: LastRunSelector = { legacyOnly: true }
) {
  if (selector.runRef && !selector.legacyOnly) {
    await unlink(await scopedLastRunPath(root, selector.runRef)).catch(() => {})
    const legacy = await readLastRunFile(await lastRunPath(root))
    if (legacy?.runRef === selector.runRef) {
      await unlink(await lastRunPath(root)).catch(() => {})
    }
    return
  }

  const runs = selector.legacyOnly
    ? [await readLastRunFile(await lastRunPath(root))]
    : await readLastRuns(root)
  await Promise.all(
    runs
      .filter((record): record is LastRunRecord => Boolean(record))
      .filter((record) => matchesLastRunSelector(record, selector))
      .map(async (record) => {
        const path = shouldWriteScopedLastRun(record)
          ? await scopedLastRunPath(root, record.runRef)
          : await lastRunPath(root)
        await unlink(path).catch(() => {})
      })
  )

  try {
    if (selector.legacyOnly) await unlink(await lastRunPath(root))
  } catch {
    // no last run to clear
  }
}
