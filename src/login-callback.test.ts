import { describe, expect, test } from "bun:test"

import { waitForCliLogin } from "./lib/login"

const BASE_PORT = 47310

function callbackUrl(port: number, params: Record<string, string>) {
  const url = new URL(`http://127.0.0.1:${port}/callback`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

const validParams = {
  state: "state-1",
  team_id: "team-1",
  team_name: "Team One",
  api_key: "onyx_secret",
  api_key_id: "key-1",
  api_url: "http://localhost:3000",
}

async function waitForListen(port: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`Callback server on port ${port} never started listening.`)
}

describe("waitForCliLogin callback server", () => {
  test("resolves the login and serves replayed callbacks during the linger window", async () => {
    const port = BASE_PORT
    const login = waitForCliLogin({
      port,
      state: "state-1",
      timeoutMs: 5_000,
      lingerMs: 1_000,
    })
    await waitForListen(port)

    const first = await fetch(callbackUrl(port, validParams))
    expect(first.status).toBe(200)
    expect(await first.text()).toContain("login complete")

    // A browser replay (retry, duplicate submit, refresh) inside the linger
    // window must land on the success page, not a refused connection.
    const replay = await fetch(callbackUrl(port, validParams))
    expect(replay.status).toBe(200)
    expect(await replay.text()).toContain("login complete")

    const result = await login
    expect(result.teamId).toBe("team-1")
    expect(result.apiKey).toBe("onyx_secret")
    expect(result.alreadyConfigured).toBe(false)
  })

  test("rejects with a friendly error when the port is already in use", async () => {
    const port = BASE_PORT + 1
    const holder = waitForCliLogin({
      port,
      state: "holder",
      timeoutMs: 5_000,
      lingerMs: 0,
    })
    await waitForListen(port)

    await expect(
      waitForCliLogin({ port, state: "second", timeoutMs: 5_000, lingerMs: 0 })
    ).rejects.toThrow(/already in use/)

    // Release the holder so the test suite exits cleanly.
    const release = await fetch(
      callbackUrl(port, { ...validParams, state: "holder" })
    )
    expect(release.status).toBe(200)
    await holder
  })

  test("rejects callbacks with a mismatched state", async () => {
    const port = BASE_PORT + 2
    const login = waitForCliLogin({
      port,
      state: "expected",
      timeoutMs: 5_000,
      lingerMs: 0,
    })
    await waitForListen(port)

    const response = await fetch(
      callbackUrl(port, { ...validParams, state: "wrong" })
    )
    expect(response.status).toBe(400)
    await expect(login).rejects.toThrow(/invalid state/)
  })
})
