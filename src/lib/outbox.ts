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
      deadlineAt?: string | null
      experimentTarget?: number | null
      acceptedExperimentCount?: number
      remainingExperimentCount?: number | null
      schedulerSiteId?: string | null
      stopRequested?: boolean
      status?: string
      terminalReason?: string | null
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
        recentFailures?: Array<{
          at: string
          reason: string
          workerId: string | null
          hypothesisId: string
          error?: string | null
          errorSummary?: string | null
        }>
      } | null
      supervisor?: {
        pid?: number | null
        logPath?: string | null
        activeProcessCount?: number
        launchRate?: {
          batchSize: number | null
          intervalSeconds: number | null
        } | null
        providerBackoff?: {
          reason: string
          until: string
          attempt?: number
          delayMs?: number
          recentFailures?: Array<{
            at: string
            reason: string
            workerId: string | null
            hypothesisId: string
            error?: string | null
            errorSummary?: string | null
          }>
        } | null
        recentFailedLaunches?: Array<{
          at: string
          reason: string
          workerId: string | null
          hypothesisId: string
          error?: string | null
          errorSummary?: string | null
        }>
        status?: string
        updatedAt?: string
      }
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
  return join(await onyxStateDir(root), "outbox.d", "pending")
}

export async function outboxConflictDir(root: string) {
  return join(await onyxStateDir(root), "outbox.d", "conflicts")
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
  localResearchRecordSchema.parse(record)
  await rm(await outboxPath(root), { force: true }).catch(() => {})
  await rm(join(await onyxStateDir(root), "outbox.d"), {
    recursive: true,
    force: true,
  }).catch(() => {})
}

export async function quarantineOutboxRecord(
  _root: string,
  record: LocalResearchRecord,
  _reason: string
) {
  void _root
  void _reason
  localResearchRecordSchema.parse(record)
}

export async function readOutboxConflictCount(_root: string) {
  void _root
  return 0
}

export async function readOutbox(
  _root: string
): Promise<{ records: LocalResearchRecord[]; corrupt: number }> {
  void _root
  return { records: [], corrupt: 0 }
}

export async function rewriteOutbox(
  root: string,
  _records: LocalResearchRecord[]
) {
  void _records
  await withOnyxLock(root, "outbox", () => rewriteOutboxUnlocked(root, []))
}

export async function rewriteOutboxUnlocked(
  root: string,
  _records: LocalResearchRecord[]
) {
  void _records
  await unlink(await outboxPath(root)).catch(() => {})
  await rm(join(await onyxStateDir(root), "outbox.d"), {
    recursive: true,
    force: true,
  }).catch(() => {})
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
