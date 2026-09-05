import { afterEach, describe, expect, mock, test } from "bun:test"

import { createServerLoginAttempt, freshnessForFlow } from "./login-freshness"

const originalFetch = globalThis.fetch
const apiUrl = "https://app.example.test"
const NONCE = "n".repeat(43)

function idTokenWith(claims: Record<string, unknown>) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "RS256" })}.${encode(claims)}.sig`
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("server-issued login freshness", () => {
  test("creates an attempt for the requested flow and proves it with the ID token nonce", async () => {
    const bodies: string[] = []
    globalThis.fetch = mock(async (input: string | URL | Request, init) => {
      expect(String(input)).toBe(`${apiUrl}/api/v1/cli/auth/attempts`)
      bodies.push(String(init?.body))
      return Response.json(
        {
          data: {
            attemptId: "55555555-5555-4555-8555-555555555555",
            nonce: NONCE,
            expiresAt: "2026-09-04T12:15:00.000Z",
          },
        },
        { status: 201 }
      )
    }) as unknown as typeof fetch

    const freshness = await freshnessForFlow("browser", { apiUrl })
    expect(JSON.parse(bodies[0]!)).toEqual({ flow: "browser" })
    expect(freshness.nonce).toBe(NONCE)
    expect(freshness.device).toBeUndefined()
    expect(
      freshness.proof({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
        idToken: idTokenWith({ nonce: NONCE }),
      })
    ).toEqual({
      attemptId: "55555555-5555-4555-8555-555555555555",
      idToken: idTokenWith({ nonce: NONCE }),
    })
  })

  test("refuses to bind without an ID token or with another attempt's nonce", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        data: {
          attemptId: "55555555-5555-4555-8555-555555555555",
          nonce: NONCE,
          expiresAt: "2026-09-04T12:15:00.000Z",
        },
      })
    ) as unknown as typeof fetch
    const freshness = await createServerLoginAttempt({
      apiUrl,
      flow: "browser",
    })
    expect(() =>
      freshness.proof({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    ).toThrow("did not return an ID token")
    expect(() =>
      freshness.proof({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
        idToken: idTokenWith({ nonce: "other" }),
      })
    ).toThrow("different login attempt")
  })

  test("explains rate limiting and provider outages", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: "rate_limited", message: "slow down" } },
        { status: 429 }
      )
    ) as unknown as typeof fetch
    await expect(
      createServerLoginAttempt({ apiUrl, flow: "browser" })
    ).rejects.toThrow("Too many login attempts")

    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: "internal_server_error" } },
        { status: 500 }
      )
    ) as unknown as typeof fetch
    await expect(
      createServerLoginAttempt({ apiUrl, flow: "browser" })
    ).rejects.toThrow("Unable to start an Onyx login attempt (500)")
  })

  test("device attempts are brokered: poll Onyx with the device code, no nonce check", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    let polls = 0
    globalThis.fetch = mock(async (input: string | URL | Request, init) => {
      const url = String(input)
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      if (url.endsWith("/api/v1/cli/auth/attempts")) {
        return Response.json(
          {
            data: {
              attemptId: "55555555-5555-4555-8555-555555555555",
              nonce: NONCE,
              expiresAt: "2026-09-04T12:15:00.000Z",
              device: {
                deviceCode: "raw-device-code",
                userCode: "ABCD-EFGH",
                verificationUri: "https://auth.example.test/device",
                expiresIn: 600,
                interval: 1,
              },
            },
          },
          { status: 201 }
        )
      }
      polls += 1
      if (polls === 1) {
        return Response.json({
          data: { status: "pending", retryAfterSeconds: 1 },
        })
      }
      if (polls === 2) {
        return Response.json({ error: { code: "internal" } }, { status: 503 })
      }
      return Response.json({
        data: {
          status: "authorized",
          tokens: {
            accessToken: "a",
            refreshToken: "r",
            idToken: idTokenWith({ sub: "user_1" }),
            expiresIn: 900,
          },
        },
      })
    }) as unknown as typeof fetch
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    try {
      const freshness = await freshnessForFlow("device", { apiUrl })
      expect(freshness.device?.userCode).toBe("ABCD-EFGH")
      const credential = await freshness.device!.poll({ timeoutMs: 60_000 })
      expect(credential.accessToken).toBe("a")
      expect(calls.slice(1).every((call) => call.url.endsWith("/device"))).toBe(
        true
      )
      expect(calls[1]?.body).toEqual({ deviceCode: "raw-device-code" })
      // The device ID token carries no nonce; the server proved the ceremony.
      expect(freshness.proof(credential)).toEqual({
        attemptId: "55555555-5555-4555-8555-555555555555",
        idToken: idTokenWith({ sub: "user_1" }),
      })
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test("device polling turns typed failures into actionable messages", async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/cli/auth/attempts")) {
        return Response.json({
          data: {
            attemptId: "55555555-5555-4555-8555-555555555555",
            nonce: NONCE,
            expiresAt: "2026-09-04T12:15:00.000Z",
            device: {
              deviceCode: "raw-device-code",
              userCode: "ABCD-EFGH",
              verificationUri: "https://auth.example.test/device",
              expiresIn: 600,
              interval: 1,
            },
          },
        })
      }
      return Response.json(
        { error: { code: "cli_authorization_denied", message: "denied" } },
        { status: 403 }
      )
    }) as unknown as typeof fetch
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    try {
      const freshness = await freshnessForFlow("device", { apiUrl })
      await expect(
        freshness.device!.poll({ timeoutMs: 60_000 })
      ).rejects.toThrow("denied in the browser")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test("device polling survives connection failures within the deadline", async () => {
    let polls = 0
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/cli/auth/attempts")) {
        return Response.json({
          data: {
            attemptId: "55555555-5555-4555-8555-555555555555",
            nonce: NONCE,
            expiresAt: "2026-09-04T12:15:00.000Z",
            device: {
              deviceCode: "raw-device-code",
              userCode: "ABCD-EFGH",
              verificationUri: "https://auth.example.test/device",
              expiresIn: 600,
              interval: 1,
            },
          },
        })
      }
      polls += 1
      if (polls === 1) throw new TypeError("fetch failed")
      return Response.json({
        data: {
          status: "authorized",
          tokens: {
            accessToken: "a",
            refreshToken: "r",
            idToken: idTokenWith({ sub: "user_1" }),
            expiresIn: 900,
          },
        },
      })
    }) as unknown as typeof fetch
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    try {
      const freshness = await freshnessForFlow("device", { apiUrl })
      const credential = await freshness.device!.poll({ timeoutMs: 60_000 })
      expect(credential.accessToken).toBe("a")
      expect(polls).toBe(2)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  test("backs off transient device polls and honors a larger Retry-After", async () => {
    let polls = 0
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/cli/auth/attempts")) {
        return Response.json({
          data: {
            attemptId: "55555555-5555-4555-8555-555555555555",
            nonce: NONCE,
            expiresAt: "2026-09-04T12:15:00.000Z",
            device: {
              deviceCode: "raw-device-code",
              userCode: "ABCD-EFGH",
              verificationUri: "https://auth.example.test/device",
              expiresIn: 600,
              interval: 1,
            },
          },
        })
      }
      polls += 1
      if (polls === 1) {
        return Response.json(
          {},
          { status: 429, headers: { "retry-after": "7" } }
        )
      }
      if (polls === 2) throw new TypeError("connection reset")
      if (polls === 3) {
        return Response.json(
          {},
          { status: 503, headers: { "retry-after": "45" } }
        )
      }
      return Response.json({
        data: {
          status: "authorized",
          tokens: {
            accessToken: "a",
            refreshToken: "r",
            idToken: idTokenWith({ sub: "user_1" }),
            expiresIn: 900,
          },
        },
      })
    }) as unknown as typeof fetch
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
      delays.push(delay ?? 0)
      if (typeof callback === "function") callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    try {
      const freshness = await freshnessForFlow("device", { apiUrl })
      expect(
        (await freshness.device!.poll({ timeoutMs: 60_000 })).accessToken
      ).toBe("a")
      expect(delays).toEqual([1_000, 7_000, 14_000, 45_000])
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})
