import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CliProfile } from "./config"
import { readCredential, writeCredential } from "./credential-store"
import { accessTokenForProfile } from "./oauth-credentials"

let runtimeRoot = ""
const originalHome = process.env.ONYX_HOME
const originalStore = process.env.ONYX_TEST_CREDENTIAL_STORE
const originalFetch = globalThis.fetch

const profile: CliProfile = {
  apiUrl: "https://app.example.test",
  credentialId: "11111111-1111-4111-8111-111111111111",
  credentialStore: "file",
  teamId: "22222222-2222-4222-8222-222222222222",
  teamName: "Team",
  updatedAt: "2026-08-23T12:00:00.000Z",
}

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "onyx-refresh-test-"))
  process.env.ONYX_HOME = runtimeRoot
  process.env.ONYX_TEST_CREDENTIAL_STORE = "file"
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = originalHome
  if (originalStore === undefined) delete process.env.ONYX_TEST_CREDENTIAL_STORE
  else process.env.ONYX_TEST_CREDENTIAL_STORE = originalStore
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe("OAuth credential refresh manager", () => {
  test("serializes concurrent refreshes and persists rotated tokens", async () => {
    await writeCredential(
      profile.credentialId,
      { accessToken: "old", refreshToken: "old-refresh", expiresAt: 0 },
      "file"
    )
    let tokenRequests = 0
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/api/v1/cli/auth/config")) {
        return Response.json({
          data: {
            clientId: "client",
            issuer: "https://auth.example.test",
            authorizationEndpoint: "https://auth.example.test/authorize",
            tokenEndpoint: "https://auth.example.test/token",
            deviceAuthorizationEndpoint: "https://auth.example.test/device",
            jwksUri: "https://auth.example.test/jwks",
            scopes: ["openid", "offline_access"],
            loopbackRedirectUri: "http://127.0.0.1:*/callback",
          },
        })
      }
      tokenRequests += 1
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 900,
      })
    }) as unknown as typeof fetch

    expect(
      await Promise.all([
        accessTokenForProfile({ name: "team", profile }),
        accessTokenForProfile({ name: "team", profile }),
      ])
    ).toEqual(["new-access", "new-access"])
    expect(tokenRequests).toBe(1)
    expect(await readCredential(profile.credentialId, "file")).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    })
  })

  test("removes a credential rejected with invalid_grant", async () => {
    await writeCredential(
      profile.credentialId,
      { accessToken: "old", refreshToken: "revoked", expiresAt: 0 },
      "file"
    )
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v1/cli/auth/config")) {
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
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    }) as unknown as typeof fetch

    await expect(
      accessTokenForProfile({ name: "team", profile })
    ).rejects.toThrow("expired or been revoked")
    expect(await readCredential(profile.credentialId, "file")).toBeNull()
  })
})
