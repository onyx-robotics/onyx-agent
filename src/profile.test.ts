import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  profileNameForLoginResult,
  profileNameForTeam,
  resolveRequestedTeam,
  shouldUseDeviceFlow,
} from "./commands/login"
import { commandProfileList, commandProfileUse } from "./commands/profile"
import { parseArgs } from "./lib/args"
import {
  CONFIG_VERSION,
  apiCredential,
  configPath,
  emptyConfig,
  readConfig,
  resetUnsupportedConfigForLogin,
  writeConfig,
  type CliProfile,
} from "./lib/config"
import { writeCredential } from "./lib/credential-store"

let runtimeRoot = ""
const originalHome = process.env.ONYX_HOME
const originalStore = process.env.ONYX_TEST_CREDENTIAL_STORE

function profile(overrides: Partial<CliProfile> = {}): CliProfile {
  return {
    apiUrl: "https://app.onyx.test",
    credentialId: "11111111-1111-4111-8111-111111111111",
    credentialStore: "file",
    teamId: "22222222-2222-4222-8222-222222222222",
    teamName: "Alpha Team",
    userId: "33333333-3333-4333-8333-333333333333",
    updatedAt: "2026-08-23T12:00:00.000Z",
    ...overrides,
  }
}

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "onyx-profile-test-"))
  process.env.ONYX_HOME = runtimeRoot
  process.env.ONYX_TEST_CREDENTIAL_STORE = "file"
  delete process.env.ONYX_API_KEY
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = originalHome
  if (originalStore === undefined) delete process.env.ONYX_TEST_CREDENTIAL_STORE
  else process.env.ONYX_TEST_CREDENTIAL_STORE = originalStore
  delete process.env.ONYX_API_KEY
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe("versioned CLI profiles", () => {
  test("stores only non-secret OAuth metadata in config", async () => {
    await writeConfig({
      ...emptyConfig(),
      profiles: { alpha: profile() },
      currentProfile: "alpha",
    })
    const raw = await readFile(configPath(), "utf8")
    expect(JSON.parse(raw).version).toBe(CONFIG_VERSION)
    expect(raw).toContain("credentialId")
    expect(raw).not.toContain("accessToken")
    expect(raw).not.toContain("refreshToken")
    expect((await stat(configPath())).mode & 0o777).toBe(0o600)
  })

  test("replaces unsupported auth profiles while preserving local preferences", async () => {
    await mkdir(join(runtimeRoot, "config"), { recursive: true })
    await writeFile(
      configPath(),
      JSON.stringify({
        profiles: { old: { apiKey: "onyx_secret" } },
        currentProfile: "old",
        developer: { mode: "release" },
        telemetry: { enabled: false },
      })
    )
    expect(await resetUnsupportedConfigForLogin()).toBe(true)
    expect(await readConfig()).toMatchObject({
      version: CONFIG_VERSION,
      profiles: {},
      currentProfile: "",
      telemetry: { enabled: false },
    })
    expect(await readFile(configPath(), "utf8")).not.toContain("onyx_secret")
  })

  test("resolves an unexpired OAuth access token and honors API key override", async () => {
    const alpha = profile()
    await writeCredential(
      alpha.credentialId,
      {
        accessToken: "oauth-access-token",
        refreshToken: "oauth-refresh-token",
        expiresAt: Date.now() + 600_000,
      },
      "file"
    )
    await writeConfig({
      ...emptyConfig(),
      profiles: { alpha },
      currentProfile: "alpha",
    })
    expect(await apiCredential()).toBe("oauth-access-token")
    process.env.ONYX_API_KEY = "manual-api-key"
    expect(await apiCredential()).toBe("manual-api-key")
  })

  test("lists and switches profiles without exposing credentials", async () => {
    await writeConfig({
      ...emptyConfig(),
      profiles: {
        alpha: profile(),
        beta: profile({
          credentialId: "44444444-4444-4444-8444-444444444444",
          teamId: "55555555-5555-4555-8555-555555555555",
          teamName: "Beta Team",
        }),
      },
      currentProfile: "alpha",
    })
    const log = spyOn(console, "log").mockImplementation(() => undefined)
    await commandProfileList()
    expect(log.mock.calls.flat().join(" ")).toContain("CLI session (file)")
    await commandProfileUse(parseArgs(["profile", "use", "beta"]))
    expect((await readConfig()).currentProfile).toBe("beta")
    log.mockRestore()
  })
})

describe("team profile selection", () => {
  test("selects device login explicitly or for SSH shells", () => {
    const previousSsh = process.env.SSH_CONNECTION
    try {
      expect(shouldUseDeviceFlow(parseArgs(["login", "--device"]))).toBe(true)
      expect(shouldUseDeviceFlow(parseArgs(["login", "--browser"]))).toBe(false)
      process.env.SSH_CONNECTION = "127.0.0.1 1 127.0.0.1 22"
      expect(shouldUseDeviceFlow(parseArgs(["login"]))).toBe(true)
    } finally {
      if (previousSsh === undefined) delete process.env.SSH_CONNECTION
      else process.env.SSH_CONNECTION = previousSsh
    }
  })

  const teams = [
    { id: "one", name: "Alpha Team", role: "admin" as const },
    { id: "two", name: "Beta Team", role: "editor" as const },
  ]

  test("resolves team IDs and unique case-insensitive names", () => {
    expect(resolveRequestedTeam(teams, "two")?.name).toBe("Beta Team")
    expect(resolveRequestedTeam(teams, "alpha team")?.id).toBe("one")
  })

  test("rejects missing and ambiguous team names", () => {
    expect(() => resolveRequestedTeam(teams, "missing")).toThrow("not found")
    expect(() =>
      resolveRequestedTeam(
        [...teams, { ...teams[0]!, id: "three" }],
        "Alpha Team"
      )
    ).toThrow("ambiguous")
  })

  test("reuses a team/API profile and suffixes collisions", () => {
    const config = {
      ...emptyConfig(),
      profiles: { alpha: profile() },
      currentProfile: "alpha",
    }
    expect(profileNameForTeam("Research Group")).toBe("research")
    expect(
      profileNameForLoginResult({
        config,
        apiUrl: profile().apiUrl,
        teamId: profile().teamId,
        teamName: profile().teamName,
      })
    ).toBe("alpha")
    expect(
      profileNameForLoginResult({
        config,
        apiUrl: "https://other.onyx.test",
        teamId: "different",
        teamName: "Alpha Other",
      })
    ).toBe("alpha-2")
  })
})
