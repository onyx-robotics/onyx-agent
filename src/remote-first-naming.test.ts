import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

const sourceRoot = dirname(fileURLToPath(import.meta.url))

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.isFile() && path.endsWith(".ts") ? [path] : []
    })
  )
  return files.flat()
}

describe("remote-first internal naming", () => {
  test("does not reintroduce legacy research sync modules or exports", async () => {
    const forbidden = [
      "lib/outbox",
      "./outbox",
      "commands/sync",
      "lib/sync",
      "research-db",
      "appendOutbox",
      "readOutbox",
      "rewriteOutbox",
      "outboxPath",
      "outboxSpoolDir",
      "flushOutbox",
      "researchDbPath",
      "ResearchSyncEvent",
      "pendingResearchSync",
      "markResearchSync",
      "oldestPendingResearchSync",
      "researchSyncConflict",
    ]
    const violations: string[] = []
    for (const file of await sourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file)
      if (name === "remote-first-naming.test.ts") continue
      const text = await readFile(file, "utf8")
      for (const term of forbidden) {
        if (text.includes(term)) violations.push(`${name}: ${term}`)
      }
    }
    expect(violations).toEqual([])
  })
})
