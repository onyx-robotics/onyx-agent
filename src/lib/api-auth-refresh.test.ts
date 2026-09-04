import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { callApi } from "./api"
import { emptyConfig, writeConfig, type CliProfile } from "./config"
import { readCredential, writeCredential } from "./credential-store"

let runtimeRoot = ""
const originalHome = process.env.ONYX_HOME
const originalStore = process.env.ONYX_TEST_CREDENTIAL_STORE
const originalFetch = globalThis.fetch

const profile: CliProfile = {
  apiUrl: "https://app.example.test",
  cliSessionId: "33333333-3333-4333-8333-333333333333",
  credentialId: "11111111-1111-4111-8111-111111111111",
  credentialStore: "file",
  teamId: "22222222-2222-4222-8222-222222222222",
  teamName: "Team",
  updatedAt: "2026-08-23T12:00:00.000Z",
}

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "onyx-api-auth-test-"))
  process.env.ONYX_HOME = runtimeRoot
  process.env.ONYX_TEST_CREDENTIAL_STORE = "file"
  delete process.env.ONYX_API_KEY
  await writeCredential(
    profile.credentialId,
    {
      accessToken: "current-access",
      refreshToken: "current-refresh",
      expiresAt: Date.now() + 600_000,
    },
    "file"
  )
  await writeConfig({
    ...emptyConfig(),
    profiles: { team: profile },
    currentProfile: "team",
  })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = originalHome
  if (originalStore === undefined) delete process.env.ONYX_TEST_CREDENTIAL_STORE
  else process.env.ONYX_TEST_CREDENTIAL_STORE = originalStore
  delete process.env.ONYX_API_KEY
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe("API authentication recovery", () => {
  test("removes an OAuth credential after refresh cannot resolve a final 401", async () => {
    const receivedCliSessionIds: Array<string | null> = []
    globalThis.fetch = mock(async (input: string | URL | Request, init) => {
      const url = String(input)
      if (
        url.startsWith(profile.apiUrl) &&
        !url.endsWith("/api/v1/cli/auth/config")
      ) {
        receivedCliSessionIds.push(
          new Headers(init?.headers).get("x-onyx-cli-session-id")
        )
      }
      if (url.endsWith("/api/v1/cli/auth/config")) {
        return Response.json({
          data: {
            clientId: "client",
            authorizationEndpoint: "https://auth.example.test/authorize",
            tokenEndpoint: "https://auth.example.test/token",
            deviceAuthorizationEndpoint: "https://auth.example.test/device",
            scopes: ["openid", "offline_access"],
          },
        })
      }
      if (url === "https://auth.example.test/token") {
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 900,
        })
      }
      return Response.json(
        { error: { code: "unauthorized", message: "Unauthorized" } },
        { status: 401 }
      )
    }) as unknown as typeof fetch

    await expect(callApi("GET", "/api/v1/research/projects")).rejects.toThrow(
      "Run `onyx login`"
    )
    expect(await readCredential(profile.credentialId, "file")).toBeNull()
    expect(receivedCliSessionIds).not.toHaveLength(0)
    expect(receivedCliSessionIds).toEqual(
      receivedCliSessionIds.map(() => profile.cliSessionId!)
    )
  })
})
