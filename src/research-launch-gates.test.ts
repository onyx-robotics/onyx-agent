import { describe, expect, test } from "bun:test"

import {
  canLaunchWorkerBeforeDeadline,
  minimumUsefulLaunchMs,
  providerBackoffDelayMs,
  providerBackoffReasonForResult,
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

  test("classifies provider failures for supervisor backoff", () => {
    expect(
      providerBackoffReasonForResult({
        status: "failed",
        startupTimedOut: true,
      })
    ).toBe("startup_timeout")
    expect(
      providerBackoffReasonForResult({
        status: "failed",
        error: "429 too many requests; retry after 30 seconds",
      })
    ).toBe("rate_limit")
    expect(
      providerBackoffReasonForResult({
        status: "failed",
        error: "Provider is overloaded and at capacity",
      })
    ).toBe("overloaded")
    expect(
      providerBackoffReasonForResult({
        status: "failed",
        error: "401 unauthorized: invalid api key",
      })
    ).toBe("auth_error")
    expect(
      providerBackoffReasonForResult({
        status: "failed",
        error: "upstream gateway 502 service unavailable",
      })
    ).toBe("provider_degraded")
    expect(
      providerBackoffReasonForResult({
        status: "completed",
        error: "429",
      })
    ).toBeNull()
  })

  test("computes exponential provider backoff with deterministic jitter", () => {
    expect(
      providerBackoffDelayMs({
        baseMs: 30_000,
        attempt: 1,
        random: () => 0,
      })
    ).toBe(30_000)
    expect(
      providerBackoffDelayMs({
        baseMs: 30_000,
        attempt: 3,
        random: () => 0.5,
      })
    ).toBe(135_000)
    expect(
      providerBackoffDelayMs({
        baseMs: 600_000,
        attempt: 6,
        random: () => 1,
      })
    ).toBe(600_000)
  })
})
