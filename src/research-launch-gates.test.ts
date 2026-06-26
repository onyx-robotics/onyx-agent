import { describe, expect, test } from "bun:test"

import {
  canLaunchWorkerBeforeDeadline,
  minimumUsefulLaunchMs,
} from "./commands/research"

describe("research supervisor launch gates", () => {
  test("requires five useful minutes for built-in agents", () => {
    const now = Date.now()
    const shutdownCushionMs = 60_000

    expect(minimumUsefulLaunchMs("codex")).toBe(5 * 60_000)
    expect(
      canLaunchWorkerBeforeDeadline({
        now,
        endTimeMs: now + shutdownCushionMs + 5 * 60_000,
        shutdownCushionMs,
        agentKind: "codex",
      })
    ).toBe(true)
    expect(
      canLaunchWorkerBeforeDeadline({
        now,
        endTimeMs: now + shutdownCushionMs + 5 * 60_000 - 1,
        shutdownCushionMs,
        agentKind: "claude",
      })
    ).toBe(false)
  })

  test("requires thirty useful seconds for custom workers", () => {
    const now = Date.now()
    const shutdownCushionMs = 15_000

    expect(minimumUsefulLaunchMs("custom")).toBe(30_000)
    expect(
      canLaunchWorkerBeforeDeadline({
        now,
        endTimeMs: now + shutdownCushionMs + 30_000,
        shutdownCushionMs,
        agentKind: "custom",
      })
    ).toBe(true)
    expect(
      canLaunchWorkerBeforeDeadline({
        now,
        endTimeMs: now + shutdownCushionMs + 29_999,
        shutdownCushionMs,
        agentKind: "custom",
      })
    ).toBe(false)
  })
})
