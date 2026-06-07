import { readFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  localResearchEventSchema,
  type LocalResearchEvent,
  type LocalResearchEventType,
} from "../protocol"

import { onyxStateDir } from "./outbox"

const TRUNCATE_BYTES = 256 * 1024
const TRUNCATE_KEEP = 500

export async function eventsPath(root: string) {
  return join(await onyxStateDir(root), "events.jsonl")
}

/**
 * Appends a local activity event for `onyx listen`. Strictly best-effort:
 * never throws, so a broken feed can never fail a command.
 */
export async function emitEvent(
  root: string,
  event: {
    type: LocalResearchEventType
    branchName?: string
    commitSha?: string
    message?: string
  }
): Promise<void> {
  try {
    const validated = localResearchEventSchema.parse({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      ...event,
    })
    const path = await eventsPath(root)
    await writeFile(path, `${JSON.stringify(validated)}\n`, {
      encoding: "utf8",
      flag: "a",
    })
    await truncateEvents(root)
  } catch {
    // Activity feed is observational only.
  }
}

/**
 * Reads activity events, skipping corrupt lines. `tail` limits parsing to the
 * last N lines so the listener stays cheap as the feed grows.
 */
export async function readEvents(
  root: string,
  options: { tail?: number } = {}
): Promise<LocalResearchEvent[]> {
  let text = ""
  try {
    text = await readFile(await eventsPath(root), "utf8")
  } catch {
    return []
  }

  let lines = text.split("\n")
  if (options.tail !== undefined) lines = lines.slice(-options.tail - 1)

  const events: LocalResearchEvent[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const result = localResearchEventSchema.safeParse(JSON.parse(trimmed))
      if (result.success) events.push(result.data)
    } catch {
      // skip corrupt line
    }
  }
  return events
}

/** Atomically trims the feed to the most recent events once it grows large. */
export async function truncateEvents(root: string, keep = TRUNCATE_KEEP) {
  const path = await eventsPath(root)
  try {
    const { size } = await stat(path)
    if (size <= TRUNCATE_BYTES) return
    const lines = (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
    if (lines.length <= keep) return
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${lines.slice(-keep).join("\n")}\n`, "utf8")
    await rename(tmp, path)
  } catch {
    // best-effort
  }
}
