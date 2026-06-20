import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { commandResearchShouldStop } from "./commands/research"
import { writeState } from "./lib/outbox"
import { runProcess } from "./lib/process"

afterEach(() => {
  process.exitCode = undefined
})

describe("research should-stop", () => {
  test("stops when worker shutdown cushion deadline is reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-should-stop-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          endTimeMs: Date.now() + 60_000,
          maxIterations: 10,
          status: "running",
        },
      },
    })

    const previousCwd = process.cwd()
    const previousDeadline = process.env.ONYX_RESEARCH_DEADLINE_AT
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      lines.push(items.join(" "))
    }
    try {
      process.chdir(root)
      process.env.ONYX_RESEARCH_DEADLINE_AT = new Date(
        Date.now() - 1000
      ).toISOString()
      await commandResearchShouldStop({
        positional: ["research", "should-stop"],
        options: { session: "session_123", json: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
      if (previousDeadline === undefined) {
        delete process.env.ONYX_RESEARCH_DEADLINE_AT
      } else {
        process.env.ONYX_RESEARCH_DEADLINE_AT = previousDeadline
      }
    }

    const payload = JSON.parse(lines.join("\n")) as {
      shouldStop: boolean
      reasons: string[]
    }
    expect(process.exitCode).toBe(0)
    expect(payload.shouldStop).toBe(true)
    expect(payload.reasons).toContain("worker shutdown cushion reached")
  })
})
