import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyConfig, readConfig, writeConfig, type CliProfile } from "./config"
import {
  readCredential,
  setKeyringEntryFactoryForTests,
  writeCredential,
} from "./credential-store"
import { accessTokenForProfile } from "./oauth-credentials"

let runtimeRoot = ""
const originalHome = process.env.ONYX_HOME
const originalStore = process.env.ONYX_TEST_CREDENTIAL_STORE
const originalFetch = globalThis.fetch

const profile: CliProfile = {
  apiUrl: "https://app.example.test",
  cliSessionId: "33333333-3333-4333-8333-333333333333",
  credentialId: "11111111-1111-4111-8111-111111111111",
  credentialStore: "file",
  oauth: {
    issuer: "https://auth.example.test",
    clientId: "client",
    tokenEndpoint: "https://auth.example.test/token",
    scopes: ["openid", "offline_access"],
  },
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
  setKeyringEntryFactoryForTests(null)
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
    const urls: string[] = []
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      urls.push(String(input))
      tokenRequests += 1
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 900,
        id_token: "a.b.c",
      })
    }) as unknown as typeof fetch

    expect(
      await Promise.all([
        accessTokenForProfile({ name: "team", profile }),
        accessTokenForProfile({ name: "team", profile }),
      ])
    ).toEqual(["new-access", "new-access"])
    expect(tokenRequests).toBe(1)
    // Refresh goes straight to the endpoint pinned at login; the API server's
    // live configuration is never consulted.
    expect(urls).toEqual([profile.oauth.tokenEndpoint])
    const stored = await readCredential(profile.credentialId, "file")
    expect(stored).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    })
    expect(JSON.stringify(stored)).not.toContain("a.b.c")
  })

  test("keeps the credential when the token endpoint is unavailable", async () => {
    await writeCredential(
      profile.credentialId,
      { accessToken: "old", refreshToken: "old-refresh", expiresAt: 0 },
      "file"
    )
    globalThis.fetch = mock(async () =>
      Response.json({ error: "temporarily_unavailable" }, { status: 503 })
    ) as unknown as typeof fetch

    await expect(
      accessTokenForProfile({ name: "team", profile })
    ).rejects.toThrow("could not refresh")
    expect(await readCredential(profile.credentialId, "file")).not.toBeNull()
  })

  test("removes a credential rejected with invalid_grant", async () => {
    await writeCredential(
      profile.credentialId,
      { accessToken: "old", refreshToken: "revoked", expiresAt: 0 },
      "file"
    )
    globalThis.fetch = mock(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })
    ) as unknown as typeof fetch

    await expect(
      accessTokenForProfile({ name: "team", profile })
    ).rejects.toThrow("expired or been revoked")
    expect(await readCredential(profile.credentialId, "file")).toBeNull()
  })

  test("keeps a rotated refresh token when the keyring write fails", async () => {
    const keyringProfile: CliProfile = { ...profile, credentialStore: "keyring" }
    await writeConfig({
      ...emptyConfig(),
      profiles: { team: keyringProfile },
      currentProfile: "team",
    })
    const stored = JSON.stringify({
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: 0,
    })
    setKeyringEntryFactoryForTests(() => ({
      getPassword: async () => stored,
      setPassword: async () => {
        throw new Error("keyring write denied")
      },
      deleteCredential: async () => true,
    }))
    globalThis.fetch = mock(async () =>
      Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 900,
      })
    ) as unknown as typeof fetch
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      expect(
        await accessTokenForProfile({ name: "team", profile: keyringProfile })
      ).toBe("rotated-access")
    } finally {
      warn.mockRestore()
    }
    // The rotated credential landed in the private file and the profile now
    // points at it, so the next refresh does not present a dead token.
    expect(await readCredential(profile.credentialId, "file")).toMatchObject({
      refreshToken: "rotated-refresh",
    })
    expect((await readConfig()).profiles.team?.credentialStore).toBe("file")
  })
})
