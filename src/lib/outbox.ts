import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import {
  localResearchRecordSchema,
  type LocalResearchCampaignExperimentLoggedRecord,
  type LocalResearchRecord,
} from "../protocol"

import { gitDir } from "./git"

export type CliState = {
  projectId?: string
  projectPath?: string
  activeCampaign?: string
  campaigns?: Record<
    string,
    {
      campaignId?: string
      setupId?: string
      projectPath?: string
      baseCommitSha?: string | null
      description?: string | null
      metricName?: string
      metricUnit?: string | null
      metricDirection?: "maximize" | "minimize"
      tools?: string | null
      constraints?: string | null
      reset?: string | null
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
}

export type LastRunRecord = Omit<
  LocalResearchCampaignExperimentLoggedRecord,
  "type" | "schemaVersion" | "createdAt" | "name" | "description"
> & {
  schemaVersion: 1
  createdAt: string
}

export async function onyxStateDir(root: string) {
  const dir = join(await gitDir(root), "onyx")
  await mkdir(dir, { recursive: true })
  return dir
}

export async function outboxPath(root: string) {
  return join(await onyxStateDir(root), "outbox.jsonl")
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
  await writeFile(await outboxPath(root), `${JSON.stringify(validated)}\n`, {
    encoding: "utf8",
    flag: "a",
  })
}

/**
 * Reads queued records. Corrupt or partially-written lines are skipped and
 * counted rather than thrown, so a crash mid-append never wedges the outbox.
 */
export async function readOutbox(
  root: string
): Promise<{ records: LocalResearchRecord[]; corrupt: number }> {
  let text = ""
  try {
    text = await readFile(await outboxPath(root), "utf8")
  } catch {
    return { records: [], corrupt: 0 }
  }

  const records: LocalResearchRecord[] = []
  let corrupt = 0

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

  return { records, corrupt }
}

/** Atomically replaces the outbox with the still-pending records. */
export async function rewriteOutbox(
  root: string,
  records: LocalResearchRecord[]
) {
  const path = await outboxPath(root)
  const body = records.map((record) => JSON.stringify(record)).join("\n")
  const tmp = `${path}.tmp`
  await writeFile(tmp, body ? `${body}\n` : "", "utf8")
  await rename(tmp, path)
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
    }
  } catch {
    return { campaigns: {} }
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
