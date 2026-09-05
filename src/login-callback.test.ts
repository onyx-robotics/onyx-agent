import { afterEach, describe, expect, test } from "bun:test"

import {
  BROWSER_OPEN_TIMEOUT_MS,
  createLoopbackCallback,
  openBrowser,
} from "./lib/login"

const callbacks: Array<Awaited<ReturnType<typeof createLoopbackCallback>>> = []

afterEach(async () => {
  await Promise.all(callbacks.splice(0).map((callback) => callback.close()))
})

describe("OAuth loopback callback", () => {
  test("uses a dynamic loopback port and returns only the authorization code", async () => {
    const callback = await createLoopbackCallback({
      state: "expected-state",
      timeoutMs: 2_000,
      lingerMs: 0,
    })
    callbacks.push(callback)
    expect(callback.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/
    )

    const response = await fetch(
      `${callback.redirectUri}?code=authorization-code&state=expected-state`
    )
    expect(response.status).toBe(200)
    expect(await callback.waitForCode()).toBe("authorization-code")
  })

  test("ignores invalid-state requests and continues waiting", async () => {
    const callback = await createLoopbackCallback({
      state: "expected-state",
      timeoutMs: 2_000,
      lingerMs: 0,
    })
    callbacks.push(callback)
    expect(
      (await fetch(`${callback.redirectUri}?code=attacker&state=wrong-state`))
        .status
    ).toBe(400)
    await fetch(`${callback.redirectUri}?code=real-code&state=expected-state`)
    expect(await callback.waitForCode()).toBe("real-code")
  })

  test("surfaces OAuth denial without accepting a code", async () => {
    const callback = await createLoopbackCallback({
      state: "expected-state",
      timeoutMs: 2_000,
      lingerMs: 0,
    })
    callbacks.push(callback)
    const rejection = callback.waitForCode().then(
      () => {
        throw new Error("Expected the callback to reject")
      },
      (error: unknown) => error
    )
    expect(
      (
        await fetch(
          `${callback.redirectUri}?error=access_denied&error_description=Denied&state=expected-state`
        )
      ).status
    ).toBe(400)
    const error = await rejection
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Denied")
  })

  test("rejects callback replay after consuming the one-time code", async () => {
    const callback = await createLoopbackCallback({
      state: "expected-state",
      timeoutMs: 2_000,
      lingerMs: 250,
    })
    callbacks.push(callback)
    const url = `${callback.redirectUri}?code=one-time-code&state=expected-state`
    expect((await fetch(url)).status).toBe(200)
    expect((await fetch(url)).status).toBe(409)
    expect(await callback.waitForCode()).toBe("one-time-code")
  })
})

describe("browser opener", () => {
  test("uses the native macOS and Linux openers with a bounded wait", async () => {
    const calls: Array<{
      command: string
      args: string[]
      timeoutMs: number | undefined
    }> = []
    const run: NonNullable<
      NonNullable<Parameters<typeof openBrowser>[1]>["run"]
    > = async (command, args, options) => {
      calls.push({ command, args, timeoutMs: options?.timeoutMs })
      return { code: 0, stdout: "", stderr: "", timedOut: false }
    }

    expect(
      await openBrowser("https://example.test/login", {
        platform: "darwin",
        run,
      })
    ).toBe(true)
    expect(
      await openBrowser("https://example.test/login", {
        platform: "linux",
        run,
      })
    ).toBe(true)
    expect(calls).toEqual([
      {
        command: "open",
        args: ["https://example.test/login"],
        timeoutMs: BROWSER_OPEN_TIMEOUT_MS,
      },
      {
        command: "xdg-open",
        args: ["https://example.test/login"],
        timeoutMs: BROWSER_OPEN_TIMEOUT_MS,
      },
    ])
  })

  test("falls back when the opener times out or is unavailable", async () => {
    expect(
      await openBrowser("https://example.test/login", {
        platform: "linux",
        run: async () => ({
          code: null,
          stdout: "",
          stderr: "",
          timedOut: true,
        }),
      })
    ).toBe(false)
    expect(
      await openBrowser("https://example.test/login", {
        platform: "darwin",
        run: async () => {
          throw new Error("open is unavailable")
        },
      })
    ).toBe(false)
  })
})
