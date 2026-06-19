import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
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
      laneId?: string
      laneName?: string
      laneBranch?: string
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
      stopRequested?: boolean
      status?: string
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

export async function statePath(root: string) {
  return join(await onyxStateDir(root), "state.json")
}

export async function lastRunPath(root: string) {
  return join(await onyxStateDir(root), "last-run.json")
}

export function clientRunRef(campaignName: string) {
  return `local/${campaignName}/${randomUUID()}`
}

export async function appendOutbox(root: string, record: LocalResearchRecord) {
  const validated = localResearchRecordSchema.parse(record)
  const dir = await outboxSpoolDir(root)
  const name = `${Date.now()}-${process.pid}-${randomUUID()}.json`
  const path = join(dir, name)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(validated)}\n`, "utf8")
  await rename(tmp, path)
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
  const path = await statePath(root)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export async function readLastRun(root: string): Promise<LastRunRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(await lastRunPath(root), "utf8"))
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

export async function writeLastRun(root: string, record: LastRunRecord) {
  const path = await lastRunPath(root)
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export async function clearLastRun(root: string) {
  try {
    await unlink(await lastRunPath(root))
  } catch {
    // no last run to clear
  }
}
