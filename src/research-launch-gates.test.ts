import { describe, expect, test } from "bun:test"

import {
  canLaunchWorkerBeforeDeadline,
  classifyDurableWorkerTerminalReason,
  compactProviderErrorSummary,
  durableWorkerReasonIsSiteFatal,
  minimumUsefulLaunchMs,
  providerBackoffDelayMs,
  providerBackoffReasonForResult,
  sessionCommitVisibilityGuidance,
  waitForStartupSessionReady,
} from "./commands/research"
import { ApiError } from "./lib/api"

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
    ).toBeNull()
    expect(
      providerBackoffReasonForResult({
        status: "failed",
        error:
          "Claude session limit reached: out_of_credits billing overage rejected",
      })
    ).toBeNull()
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
    ).toBeNull()
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

  test("keeps terminal reasons distinct and isolates site-fatal failures", () => {
    const base = {
      stoppedByHarness: false,
      cleanupFailed: false,
      attemptDeliveryFailed: false,
      attemptDelivered: false,
      explicitFinishReason: null,
      timedOut: false,
      protocolViolation: false,
      processFailed: true,
      providerFailureClass: "other" as const,
      error: null,
    }

    expect(
      classifyDurableWorkerTerminalReason({
        ...base,
        providerFailureClass: "auth",
      })
    ).toBe("provider_auth")
    expect(
      classifyDurableWorkerTerminalReason({
        ...base,
        providerFailureClass: "rate_limit",
      })
    ).toBe("provider_rate_limited")
    expect(
      classifyDurableWorkerTerminalReason({
        ...base,
        error: "operation not permitted by sandbox",
      })
    ).toBe("worker_sandbox_failed")
    expect(
      classifyDurableWorkerTerminalReason({
        ...base,
        error: "git checkout failed",
      })
    ).toBe("worker_git_failed")
    expect(
      classifyDurableWorkerTerminalReason({
        ...base,
        processFailed: false,
        attemptDeliveryFailed: true,
      })
    ).toBe("worker_report_delivery_failed")
    expect(
      classifyDurableWorkerTerminalReason({
        ...base,
        stoppedByHarness: true,
        processFailed: false,
        stopReasonCodes: ["assignment_canceled"],
      })
    ).toBe("assignment_canceled")
    expect(durableWorkerReasonIsSiteFatal("worker_protocol_mismatch")).toBe(
      true
    )
    expect(durableWorkerReasonIsSiteFatal("provider_rate_limited")).toBe(false)
    expect(durableWorkerReasonIsSiteFatal("worker_git_failed")).toBe(false)
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
    ).toBe(120_000)
    expect(
      providerBackoffDelayMs({
        baseMs: 600_000,
        attempt: 6,
        random: () => 1,
      })
    ).toBe(120_000)
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

  test("startup readiness must confirm remote control state before launching", async () => {
    const originalFetch = globalThis.fetch
    const previousApiUrl = process.env.ONYX_API_URL
    const previousApiKey = process.env.ONYX_API_KEY
    process.env.ONYX_API_URL = "https://api.onyx.test"
    process.env.ONYX_API_KEY = "test-key"
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    try {
      await expect(
        waitForStartupSessionReady({
          args: { positional: [], options: {} },
          sessionId: "11111111-1111-4111-8111-111111111111",
          timeoutMs: 20,
        })
      ).rejects.toThrow("Startup session was not readable")
    } finally {
      globalThis.fetch = originalFetch
      if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
      else process.env.ONYX_API_URL = previousApiUrl
      if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
      else process.env.ONYX_API_KEY = previousApiKey
    }
  })

  test("renders actionable guidance for invisible session commits", () => {
    const error = new ApiError("POST", "/sessions", 409, {
      error: {
        code: "conflict",
        message: "Commit is not visible",
        details: {
          reason: "assignment_commit_not_visible",
          commitSha: "a".repeat(40),
          hypothesisId: "40000000-0000-4000-8000-000000000001",
        },
      },
    })

    expect(sessionCommitVisibilityGuidance(error)).toContain(
      "Push that exact commit"
    )
    expect(sessionCommitVisibilityGuidance(error)).toContain(
      "No research session was created"
    )
  })
})
