import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ApiError, callApi } from "./api"
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

type Seen = { url: string; sessionHeader: string | null; bearer: string | null }

function errorResponse(code: string, status: number) {
  return Response.json(
    { error: { code, message: `code ${code}` } },
    { status }
  )
}

function installFetch(
  apiResponder: (seen: Seen, attempt: number) => Response
) {
  const seen: Seen[] = []
  let tokenRequests = 0
  let apiAttempts = 0
  globalThis.fetch = mock(async (input: string | URL | Request, init) => {
    const url = String(input)
    if (url === profile.oauth.tokenEndpoint) {
      tokenRequests += 1
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 900,
      })
    }
    const headers = new Headers(init?.headers)
    const entry = {
      url,
      sessionHeader: headers.get("x-onyx-cli-session-id"),
      bearer: headers.get("authorization"),
    }
    seen.push(entry)
    apiAttempts += 1
    return apiResponder(entry, apiAttempts)
  }) as unknown as typeof fetch
  return {
    seen,
    get tokenRequests() {
      return tokenRequests
    },
  }
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
  test("always sends the bound session id and refreshes once on an invalid token", async () => {
    const fetches = installFetch((seen, attempt) =>
      attempt === 1
        ? errorResponse("cli_token_invalid", 401)
        : Response.json({ data: { ok: seen.bearer } })
    )
    const payload = (await callApi("GET", "/api/v1/research/projects")) as {
      data: { ok: string }
    }
    expect(payload.data.ok).toBe("Bearer rotated-access")
    expect(fetches.tokenRequests).toBe(1)
    expect(fetches.seen.map((entry) => entry.sessionHeader)).toEqual([
      profile.cliSessionId,
      profile.cliSessionId,
    ])
  })

  test("keeps the stored login after a generic 401 that a refresh cannot fix", async () => {
    const fetches = installFetch(() => errorResponse("unauthorized", 401))
    await expect(callApi("GET", "/api/v1/research/projects")).rejects.toEqual(
      expect.any(ApiError)
    )
    expect(fetches.tokenRequests).toBe(1)
    expect(await readCredential(profile.credentialId, "file")).not.toBeNull()
  })

  test("removes the credential only when the server says the session was revoked or is invalid", async () => {
    let fetches = installFetch(() => errorResponse("cli_session_revoked", 401))
    await expect(callApi("GET", "/api/v1/research/projects")).rejects.toThrow(
      "revoked from Settings"
    )
    expect(fetches.tokenRequests).toBe(0)
    expect(await readCredential(profile.credentialId, "file")).toBeNull()

    await writeCredential(
      profile.credentialId,
      {
        accessToken: "current-access",
        refreshToken: "current-refresh",
        expiresAt: Date.now() + 600_000,
      },
      "file"
    )
    fetches = installFetch(() => errorResponse("cli_session_invalid", 401))
    await expect(callApi("GET", "/api/v1/research/projects")).rejects.toThrow(
      "no longer valid"
    )
    expect(fetches.tokenRequests).toBe(0)
    expect(await readCredential(profile.credentialId, "file")).toBeNull()
  })

  test("explains a missing session id without deleting anything", async () => {
    const fetches = installFetch(() =>
      errorResponse("cli_session_required", 401)
    )
    await expect(callApi("GET", "/api/v1/research/projects")).rejects.toThrow(
      "missing its CLI session ID"
    )
    expect(fetches.tokenRequests).toBe(0)
    expect(await readCredential(profile.credentialId, "file")).not.toBeNull()
  })

  test("retries an identity-provider outage and preserves the login", async () => {
    const fetches = installFetch(() =>
      errorResponse("cli_auth_temporarily_unavailable", 503)
    )
    await expect(callApi("GET", "/api/v1/research/projects")).rejects.toThrow(
      "identity provider"
    )
    expect(fetches.seen).toHaveLength(3)
    expect(fetches.tokenRequests).toBe(0)
    expect(await readCredential(profile.credentialId, "file")).not.toBeNull()
  })

  test("uses ONYX_API_KEY verbatim with no session header or refresh", async () => {
    process.env.ONYX_API_KEY = "onyx_manual"
    const fetches = installFetch((seen) =>
      Response.json({ data: { bearer: seen.bearer } })
    )
    const payload = (await callApi("GET", "/api/v1/research/projects")) as {
      data: { bearer: string }
    }
    expect(payload.data.bearer).toBe("Bearer onyx_manual")
    expect(fetches.seen[0]?.sessionHeader).toBeNull()
  })
})
