import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { collectLocalResearchStopReasons } from "./research-stop"

describe("collectLocalResearchStopReasons", () => {
  test("reports deadline_reached once the worker research deadline passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-research-stop-"))
    const check = await collectLocalResearchStopReasons({
      root,
      sessionId: "session-1",
      snapshot: null,
      researchDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
    })
    expect(check.shouldStop).toBe(true)
    expect(check.reasonCodes).toContain("deadline_reached")
    expect(check.reasons).toContain("worker shutdown cushion reached")
  })

  test("does not stop before the worker research deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-research-stop-"))
    const check = await collectLocalResearchStopReasons({
      root,
      sessionId: "session-1",
      snapshot: null,
      researchDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(check.shouldStop).toBe(false)
    expect(check.reasonCodes).toEqual([])
  })

  test("ignores the deadline check when the session has no deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-research-stop-"))
    const check = await collectLocalResearchStopReasons({
      root,
      sessionId: "session-1",
      snapshot: null,
      researchDeadlineAt: null,
    })
    expect(check.shouldStop).toBe(false)
  })
})
