import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { commandLogin } from "./commands/login"
import { parseArgs } from "./lib/args"
import { configDir, configPath, readConfig } from "./lib/config"
import { readCredential } from "./lib/credential-store"

let runtimeRoot = ""
const originalHome = process.env.ONYX_HOME
const originalStore = process.env.ONYX_TEST_CREDENTIAL_STORE
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout

const apiUrl = "https://app.example.test"
const issuer = "https://auth.example.test"
const NONCE = "server-nonce-".padEnd(43, "x")
const TEAM_ID = "22222222-2222-4222-8222-222222222222"
const SESSION_ID_FROM_SERVER = "77777777-7777-4777-8777-777777777777"

function idTokenWith(claims: Record<string, unknown>) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "RS256" })}.${encode(claims)}.sig`
}

type Recorded = {
  attempts: unknown[]
  devicePolls: Array<Record<string, unknown>>
  teamsBodies: Array<Record<string, unknown>>
  sessionBodies: Array<Record<string, unknown>>
  sessionHeaders: Headers[]
}

function installFetch(
  overrides: { tokenIdToken?: string | null; sessionStatus?: number } = {}
) {
  const recorded: Recorded = {
    attempts: [],
    devicePolls: [],
    teamsBodies: [],
    sessionBodies: [],
    sessionHeaders: [],
  }
  globalThis.fetch = mock(async (input: string | URL | Request, init) => {
    const url = String(input)
    if (url === `${apiUrl}/api/v1/cli/auth/config`) {
      return Response.json({
        data: {
          clientId: "client_cli",
          issuer,
          authorizationEndpoint: `${issuer}/oauth2/authorize`,
          tokenEndpoint: `${issuer}/oauth2/token`,
          deviceAuthorizationEndpoint: `${issuer}/oauth2/device_authorization`,
          jwksUri: `${issuer}/oauth2/jwks`,
          scopes: ["openid", "profile", "email", "offline_access"],
          loopbackRedirectUri: "http://127.0.0.1:*/callback",
        },
      })
    }
    if (url === `${apiUrl}/api/v1/cli/auth/attempts`) {
      const body = JSON.parse(String(init?.body)) as { flow: string }
      recorded.attempts.push(body)
      return Response.json(
        {
          data: {
            attemptId: "55555555-5555-4555-8555-555555555555",
            nonce: NONCE,
            expiresAt: "2026-09-04T12:15:00.000Z",
            ...(body.flow === "device"
              ? {
                  device: {
                    deviceCode: "device-code-secret",
                    userCode: "ABCD-EFGH",
                    verificationUri: `${issuer}/device`,
                    expiresIn: 600,
                    interval: 1,
                  },
                }
              : {}),
          },
        },
        { status: 201 }
      )
    }
    if (
      url ===
      `${apiUrl}/api/v1/cli/auth/attempts/55555555-5555-4555-8555-555555555555/device`
    ) {
      recorded.devicePolls.push(JSON.parse(String(init?.body)))
      if (recorded.devicePolls.length === 1) {
        return Response.json({
          data: { status: "pending", retryAfterSeconds: 1 },
        })
      }
      const idToken =
        overrides.tokenIdToken === undefined
          ? idTokenWith({ sub: "user_1" })
          : overrides.tokenIdToken
      if (!idToken) {
        return Response.json(
          {
            error: {
              code: "cli_login_attempt_invalid",
              message: "ID token is invalid",
            },
          },
          { status: 401 }
        )
      }
      return Response.json({
        data: {
          status: "authorized",
          tokens: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            idToken,
            expiresIn: 900,
          },
        },
      })
    }
    if (url.startsWith(issuer)) {
      throw new Error(`Device login must not call WorkOS directly: ${url}`)
    }
    if (url === `${apiUrl}/api/v1/cli/auth/teams`) {
      if (init?.method !== "POST") throw new Error("teams must be POSTed")
      recorded.teamsBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>
      )
      return Response.json({
        data: [{ id: TEAM_ID, name: "Acme Robotics", role: "admin" }],
      })
    }
    if (url === `${apiUrl}/api/v1/cli/auth/session`) {
      recorded.sessionHeaders.push(new Headers(init?.headers))
      if (init?.method === "DELETE") return Response.json({ data: {} })
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      recorded.sessionBodies.push(body)
      if (overrides.sessionStatus) {
        return Response.json(
          { error: { code: "internal_server_error", message: "boom" } },
          { status: overrides.sessionStatus }
        )
      }
      return Response.json(
        {
          data: {
            id: SESSION_ID_FROM_SERVER,
            userId: "33333333-3333-4333-8333-333333333333",
            teamId: TEAM_ID,
            teamName: "Acme Robotics",
          },
        },
        { status: 201 }
      )
    }
    throw new Error(`Unexpected fetch ${url}`)
  }) as unknown as typeof fetch
  return recorded
}

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "onyx-login-test-"))
  process.env.ONYX_HOME = runtimeRoot
  process.env.ONYX_TEST_CREDENTIAL_STORE = "file"
  delete process.env.ONYX_API_KEY
  delete process.env.ONYX_API_URL
  // Device polling sleeps for the provider interval; run timers immediately.
  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  if (originalHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = originalHome
  if (originalStore === undefined) delete process.env.ONYX_TEST_CREDENTIAL_STORE
  else process.env.ONYX_TEST_CREDENTIAL_STORE = originalStore
  await rm(runtimeRoot, { recursive: true, force: true })
})

const deviceLoginArgs = () =>
  parseArgs(["login", "--device", "--api-url", apiUrl, "--trust-api-url"])

describe("onyx login", () => {
  test("binds a brokered device login and pins issuer metadata in the profile", async () => {
    const recorded = installFetch()
    const logs: string[] = []
    const log = spyOn(console, "log").mockImplementation((...parts) => {
      logs.push(parts.map(String).join(" "))
    })
    try {
      await commandLogin(deviceLoginArgs())
    } finally {
      log.mockRestore()
    }

    expect(recorded.attempts).toEqual([{ flow: "device" }])
    // The CLI shows the user code from Onyx and polls Onyx with the raw device
    // code; it never talks to WorkOS during a device login.
    expect(logs.join("\n")).toContain("ABCD-EFGH")
    expect(recorded.devicePolls).toEqual([
      { deviceCode: "device-code-secret" },
      { deviceCode: "device-code-secret" },
    ])
    // Team discovery carries the same proof as binding.
    expect(recorded.teamsBodies).toEqual([
      {
        attemptId: "55555555-5555-4555-8555-555555555555",
        idToken: idTokenWith({ sub: "user_1" }),
      },
    ])
    expect(recorded.sessionBodies).toHaveLength(1)
    const body = recorded.sessionBodies[0]!
    expect(body).toMatchObject({
      attemptId: "55555555-5555-4555-8555-555555555555",
      idToken: idTokenWith({ sub: "user_1" }),
      teamId: TEAM_ID,
      authFlow: "device",
    })
    expect(typeof body.sessionId).toBe("string")
    expect(recorded.sessionHeaders[0]?.get("authorization")).toBe(
      "Bearer access-1"
    )

    const config = await readConfig()
    expect(config.currentProfile).toBe("acme")
    const profile = config.profiles.acme!
    expect(profile).toMatchObject({
      apiUrl,
      cliSessionId: SESSION_ID_FROM_SERVER,
      credentialStore: "file",
      teamId: TEAM_ID,
      teamName: "Acme Robotics",
      oauth: {
        issuer,
        clientId: "client_cli",
        tokenEndpoint: `${issuer}/oauth2/token`,
        scopes: ["openid", "profile", "email", "offline_access"],
      },
    })
    const stored = await readCredential(profile.credentialId, "file")
    expect(stored).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    })
    expect(JSON.stringify(stored)).not.toContain("idToken")
    expect(await readFile(configPath(), "utf8")).not.toContain("refresh-1")
  })

  test("surfaces a typed device-login failure without writing a profile", async () => {
    const recorded = installFetch({ tokenIdToken: null })
    const log = spyOn(console, "log").mockImplementation(() => undefined)
    try {
      await expect(commandLogin(deviceLoginArgs())).rejects.toThrow(
        "could not verify this device login"
      )
    } finally {
      log.mockRestore()
    }
    expect(recorded.sessionBodies).toHaveLength(0)
    expect((await readConfig()).profiles).toEqual({})
  })

  test("migrates a legacy config, keeps the profile name and worker defaults, and drops secrets", async () => {
    await mkdir(configDir(), { recursive: true })
    await writeFile(
      configPath(),
      JSON.stringify({
        profiles: {
          robots: {
            apiUrl,
            apiKey: "onyx_secret_key",
            teamId: TEAM_ID,
            teamName: "Acme Robotics",
            worker: { agent: "claude", models: { claude: "claude-opus-5" } },
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
        },
        currentProfile: "robots",
        developer: { mode: "release" },
        telemetry: { enabled: false },
      })
    )
    installFetch()
    const warnings: string[] = []
    const log = spyOn(console, "log").mockImplementation(() => undefined)
    const warn = spyOn(console, "warn").mockImplementation((...parts) => {
      warnings.push(parts.map(String).join(" "))
    })
    try {
      await commandLogin(deviceLoginArgs())
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
    expect(warnings.join(" ")).toContain("sanitized backup")
    const config = await readConfig()
    expect(config.currentProfile).toBe("robots")
    expect(config.profiles.robots).toMatchObject({
      cliSessionId: SESSION_ID_FROM_SERVER,
      worker: { agent: "claude", models: { claude: "claude-opus-5" } },
    })
    expect(config.telemetry).toEqual({ enabled: false })
    expect(await readFile(configPath(), "utf8")).not.toContain("onyx_secret_key")
  })

  test("a failed login leaves a legacy config, its keys, and its credentials untouched", async () => {
    await mkdir(configDir(), { recursive: true })
    const legacyRaw = JSON.stringify({
      profiles: {
        robots: {
          apiUrl,
          apiKey: "onyx_secret_key",
          teamId: TEAM_ID,
          teamName: "Acme Robotics",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      },
      currentProfile: "robots",
      developer: { mode: "release" },
      telemetry: { enabled: false },
    })
    await writeFile(configPath(), legacyRaw)
    const recorded = installFetch({ sessionStatus: 503 })
    const log = spyOn(console, "log").mockImplementation(() => undefined)
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      await expect(commandLogin(deviceLoginArgs())).rejects.toBeDefined()
    } finally {
      log.mockRestore()
      warn.mockRestore()
    }
    // The idempotent binding request was retried, then the legacy file was
    // left exactly as it was: no rewrite, no backup, no credential cleanup.
    expect(recorded.sessionBodies.length).toBeGreaterThan(1)
    expect(await readFile(configPath(), "utf8")).toBe(legacyRaw)
    expect(
      (await readdir(configDir())).filter((name) => name.includes("backup"))
    ).toEqual([])
  })
})
