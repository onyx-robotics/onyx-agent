import { afterEach, describe, expect, test } from "bun:test"

import { createLoopbackCallback } from "./lib/login"

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
    const result = callback.waitForCode()
    await fetch(
      `${callback.redirectUri}?error=access_denied&error_description=Denied&state=expected-state`
    )
    await expect(result).rejects.toThrow("Denied")
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
