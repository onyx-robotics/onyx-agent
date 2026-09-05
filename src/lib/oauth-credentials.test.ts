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
import { clearCachedAccessTokensForTests } from "./credential-access-cache"
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
  clearCachedAccessTokensForTests()
  runtimeRoot = await mkdtemp(join(tmpdir(), "onyx-refresh-test-"))
  process.env.ONYX_HOME = runtimeRoot
  process.env.ONYX_TEST_CREDENTIAL_STORE = "file"
})

afterEach(async () => {
  clearCachedAccessTokensForTests()
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

  test("keeps a newer durable credential after stale invalid_grant", async () => {
    await writeCredential(
      profile.credentialId,
      { accessToken: "old", refreshToken: "old-refresh", expiresAt: 0 },
      "file"
    )
    globalThis.fetch = mock(async () => {
      await writeCredential(
        profile.credentialId,
        {
          accessToken: "newer-access",
          refreshToken: "newer-refresh",
          expiresAt: Date.now() + 900_000,
        },
        "file"
      )
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    }) as unknown as typeof fetch

    expect(await accessTokenForProfile({ name: "team", profile })).toBe(
      "newer-access"
    )
    expect(await readCredential(profile.credentialId, "file")).toMatchObject({
      refreshToken: "newer-refresh",
    })
  })

  test("finds a newer file generation after another process changed the profile store", async () => {
    const keyringProfile: CliProfile = {
      ...profile,
      credentialStore: "keyring",
    }
    await writeConfig({
      ...emptyConfig(),
      profiles: { team: keyringProfile },
      currentProfile: "team",
    })
    setKeyringEntryFactoryForTests(() => ({
      getPassword: async () =>
        JSON.stringify({
          accessToken: "old",
          refreshToken: "old-refresh",
          expiresAt: 0,
        }),
      setPassword: async () => undefined,
      deleteCredential: async () => true,
    }))
    globalThis.fetch = mock(async () => {
      const fileProfile: CliProfile = {
        ...keyringProfile,
        credentialStore: "file",
        updatedAt: "2026-09-05T13:00:00.000Z",
      }
      await writeCredential(
        profile.credentialId,
        {
          accessToken: "newer-file-access",
          refreshToken: "newer-file-refresh",
          expiresAt: Date.now() + 900_000,
        },
        "file"
      )
      await writeConfig({
        ...emptyConfig(),
        profiles: { team: fileProfile },
        currentProfile: "team",
      })
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    }) as unknown as typeof fetch

    expect(
      await accessTokenForProfile({ name: "team", profile: keyringProfile })
    ).toBe("newer-file-access")
    expect(await readCredential(profile.credentialId, "file")).toMatchObject({
      refreshToken: "newer-file-refresh",
    })
  })

  test("reuses a cached access token without repeated keyring reads", async () => {
    const keyringProfile: CliProfile = {
      ...profile,
      credentialStore: "keyring",
    }
    const stored = JSON.stringify({
      accessToken: "cached-access",
      refreshToken: "cached-refresh",
      expiresAt: Date.now() + 900_000,
    })
    let reads = 0
    setKeyringEntryFactoryForTests(() => ({
      getPassword: async () => {
        reads += 1
        return stored
      },
      setPassword: async () => undefined,
      deleteCredential: async () => true,
    }))

    expect(
      await accessTokenForProfile({ name: "team", profile: keyringProfile })
    ).toBe("cached-access")
    expect(
      await accessTokenForProfile({ name: "team", profile: keyringProfile })
    ).toBe("cached-access")
    expect(reads).toBe(1)
  })

  test("re-reads the keyring after the 60-second cache window", async () => {
    const keyringProfile: CliProfile = {
      ...profile,
      credentialStore: "keyring",
    }
    let now = 1_800_000_000_000
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    let reads = 0
    setKeyringEntryFactoryForTests(() => ({
      getPassword: async () => {
        reads += 1
        return JSON.stringify({
          accessToken: `access-${reads}`,
          refreshToken: "refresh",
          expiresAt: now + 900_000,
        })
      },
      setPassword: async () => undefined,
      deleteCredential: async () => true,
    }))
    try {
      expect(
        await accessTokenForProfile({ name: "team", profile: keyringProfile })
      ).toBe("access-1")
      now += 60_001
      expect(
        await accessTokenForProfile({ name: "team", profile: keyringProfile })
      ).toBe("access-2")
      expect(reads).toBe(2)
    } finally {
      clock.mockRestore()
    }
  })

  test("profile store identity changes bypass an older cache entry", async () => {
    const firstProfile: CliProfile = { ...profile, credentialStore: "keyring" }
    let accessToken = "first-access"
    let reads = 0
    setKeyringEntryFactoryForTests(() => ({
      getPassword: async () => {
        reads += 1
        return JSON.stringify({
          accessToken,
          refreshToken: "refresh",
          expiresAt: Date.now() + 900_000,
        })
      },
      setPassword: async () => undefined,
      deleteCredential: async () => true,
    }))
    expect(
      await accessTokenForProfile({ name: "team", profile: firstProfile })
    ).toBe("first-access")
    accessToken = "updated-access"
    expect(
      await accessTokenForProfile({
        name: "team",
        profile: { ...firstProfile, updatedAt: "2026-09-05T13:00:00.000Z" },
      })
    ).toBe("updated-access")
    expect(reads).toBe(2)
  })

  test("forced refresh bypasses the cache and re-reads under the lock", async () => {
    const keyringProfile: CliProfile = {
      ...profile,
      credentialStore: "keyring",
    }
    let stored = JSON.stringify({
      accessToken: "cached-access",
      refreshToken: "cached-refresh",
      expiresAt: Date.now() + 900_000,
    })
    let reads = 0
    setKeyringEntryFactoryForTests(() => ({
      getPassword: async () => {
        reads += 1
        return stored
      },
      setPassword: async (value) => {
        stored = value
      },
      deleteCredential: async () => true,
    }))
    globalThis.fetch = mock(async () =>
      Response.json({
        access_token: "forced-access",
        refresh_token: "forced-refresh",
        expires_in: 900,
      })
    ) as unknown as typeof fetch

    await accessTokenForProfile({ name: "team", profile: keyringProfile })
    expect(
      await accessTokenForProfile({
        name: "team",
        profile: keyringProfile,
        forceRefresh: true,
      })
    ).toBe("forced-access")
    expect(reads).toBe(3)
  })

  test("credential writes invalidate the process cache", async () => {
    await writeCredential(
      profile.credentialId,
      {
        accessToken: "first-access",
        refreshToken: "first-refresh",
        expiresAt: Date.now() + 900_000,
      },
      "file"
    )
    expect(await accessTokenForProfile({ name: "team", profile })).toBe(
      "first-access"
    )
    await writeCredential(
      profile.credentialId,
      {
        accessToken: "second-access",
        refreshToken: "second-refresh",
        expiresAt: Date.now() + 900_000,
      },
      "file"
    )
    expect(await accessTokenForProfile({ name: "team", profile })).toBe(
      "second-access"
    )
  })

  test("keeps a rotated refresh token when the keyring write fails", async () => {
    const keyringProfile: CliProfile = {
      ...profile,
      credentialStore: "keyring",
    }
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
    let writes = 0
    setKeyringEntryFactoryForTests(() => ({
      getPassword: async () => stored,
      setPassword: async () => {
        writes += 1
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
    expect(writes).toBe(1)
  })
})
