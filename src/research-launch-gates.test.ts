import { describe, expect, test } from "bun:test"

import {
  canLaunchWorkerBeforeDeadline,
  compactProviderErrorSummary,
  minimumUsefulLaunchMs,
  providerBackoffDelayMs,
  providerBackoffReasonForResult,
  waitForStartupSessionSync,
} from "./commands/research"

describe("research supervisor launch gates", () => {
  test("requires five useful minutes for built-in agents", () => {
    const now = Date.now()
    const shutdownCushionMs = 60_000

    expect(minimumUsefulLaunchMs("codex")).toBe(5 * 60_000)
    expect(minimumUsefulLaunchMs("opencode")).toBe(5 * 60_000)
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
        agentKind: "opencode",
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
        error:
          "Claude session limit reached: out_of_credits billing overage rejected",
      })
    ).toBe("quota_exhausted")
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

  test("sanitizes provider error summaries for status output", () => {
    const summary = compactProviderErrorSummary(
      [
        '{"type":"error","message":"rate limit","signature":"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"}',
        "thinking: should not leak",
        "token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      ].join("\n")
    )

    expect(summary).toContain("message: rate limit")
    expect(summary).toContain("[redacted]")
    expect(summary).not.toContain(
      "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"
    )
    expect(summary.length).toBeLessThanOrEqual(500)
  })

  test("startup sync must confirm remote control state before launching", async () => {
    const originalFetch = globalThis.fetch
    const previousApiUrl = process.env.ONYX_API_URL
    const previousApiKey = process.env.ONYX_API_KEY
    let requested = false
    let waited = false
    process.env.ONYX_API_URL = "https://api.onyx.test"
    process.env.ONYX_API_KEY = "test-key"
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    try {
      await expect(
        waitForStartupSessionSync({
          args: { positional: [], options: {} },
          sessionId: "11111111-1111-4111-8111-111111111111",
          timeoutMs: 20,
          syncSupervisor: {
            request(job) {
              requested = job?.reason === "startup"
              return 1
            },
            async waitForIdle() {
              waited = true
              return 0
            },
          },
        })
      ).rejects.toThrow("Startup session sync was not confirmed")
      expect(requested).toBe(true)
      expect(waited).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
      else process.env.ONYX_API_URL = previousApiUrl
      if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
      else process.env.ONYX_API_KEY = previousApiKey
    }
  })
})
