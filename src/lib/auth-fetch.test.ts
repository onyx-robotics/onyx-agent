import { afterEach, describe, expect, mock, test } from "bun:test"

import { AuthRequestTimeoutError, authFetch } from "./auth-fetch"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function abortablePendingFetch() {
  return mock(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return reject(new Error("missing auth request signal"))
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      })
  ) as unknown as typeof fetch
}

describe("bounded authentication fetch", () => {
  test("times out an unresponsive authentication request", async () => {
    globalThis.fetch = abortablePendingFetch()

    await expect(authFetch("https://auth.example.test", {}, 5)).rejects.toEqual(
      expect.any(AuthRequestTimeoutError)
    )
  })

  test("composes and preserves a caller cancellation signal", async () => {
    globalThis.fetch = abortablePendingFetch()
    const controller = new AbortController()
    const request = authFetch(
      "https://auth.example.test",
      { signal: controller.signal },
      1_000
    )
    controller.abort(new Error("ceremony cancelled"))

    await expect(request).rejects.toThrow("ceremony cancelled")
  })

  test("passes a timeout signal to successful requests", async () => {
    let receivedSignal: AbortSignal | null = null
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedSignal = init?.signal ?? null
        return new Response(null, { status: 204 })
      }
    ) as unknown as typeof fetch

    expect((await authFetch("https://auth.example.test", {}, 100)).status).toBe(
      204
    )
    expect(receivedSignal).not.toBeNull()
    expect(receivedSignal!.aborted).toBe(false)
  })
})
