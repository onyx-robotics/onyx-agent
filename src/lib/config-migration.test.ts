import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  apiBaseUrl,
  apiCredential,
  CONFIG_VERSION,
  configDir,
  configPath,
  legacyConfigMessage,
  migrateLegacyConfigForLogin,
  readConfig,
  stageLegacyConfigMigration,
} from "./config"

let runtimeRoot = ""
const originalHome = process.env.ONYX_HOME

beforeEach(async () => {
  runtimeRoot = await mkdtemp()
  process.env.ONYX_HOME = runtimeRoot
  delete process.env.ONYX_API_KEY
  delete process.env.ONYX_API_URL
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = originalHome
  delete process.env.ONYX_API_KEY
  await rm(runtimeRoot, { recursive: true, force: true })
})

async function mkdtemp() {
  const { mkdtemp: make } = await import("node:fs/promises")
  return make(join(tmpdir(), "onyx-config-migration-"))
}

async function writeRawConfig(value: unknown) {
  await mkdir(configDir(), { recursive: true })
  await writeFile(configPath(), JSON.stringify(value))
}

const v1Config = {
  profiles: {
    acme: {
      apiUrl: "https://app.onyxresearch.ai",
      apiKey: "onyx_secret_key",
      apiKeyId: "key_1",
      teamId: "22222222-2222-4222-8222-222222222222",
      teamName: "Acme Robotics",
      userId: "33333333-3333-4333-8333-333333333333",
      worker: { agent: "codex", models: { codex: "gpt-5" } },
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    ci: {
      apiUrl: "https://app.onyxresearch.ai",
      apiKeyEnv: "ONYX_TEAM_API_KEY",
      teamId: "44444444-4444-4444-8444-444444444444",
      teamName: "CI",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  },
  currentProfile: "acme",
  developer: { mode: "release" },
  telemetry: { enabled: false, anonymousId: "anon-1" },
}

describe("legacy config migration", () => {
  test("older configs read as empty with an actionable migration message", async () => {
    await writeRawConfig(v1Config)
    const config = await readConfig()
    expect(config.profiles).toEqual({})
    expect(config.legacyVersion).toBe("unknown")
    expect(config.telemetry).toEqual({ enabled: false, anonymousId: "anon-1" })
    expect(legacyConfigMessage(config)).toContain("Run `onyx login` to migrate")
    await expect(apiCredential()).rejects.toThrow("out of date")
    await expect(apiBaseUrl()).rejects.toThrow("out of date")

    // Automation overrides keep working regardless of the local config format.
    process.env.ONYX_API_KEY = "onyx_manual"
    expect(await apiCredential()).toBe("onyx_manual")
    expect(await apiBaseUrl()).toBe("https://app.onyxresearch.ai")
  })

  test("writes a sanitized 0600 backup, keeps metadata, and rewrites the live config", async () => {
    await writeRawConfig(v1Config)
    const migration = await migrateLegacyConfigForLogin()
    expect(migration.migrated).toBe(true)
    expect(migration.currentProfile).toBe("acme")
    expect(migration.legacyProfiles.acme).toEqual({
      apiUrl: "https://app.onyxresearch.ai",
      teamId: "22222222-2222-4222-8222-222222222222",
      teamName: "Acme Robotics",
      userId: "33333333-3333-4333-8333-333333333333",
      worker: { agent: "codex", models: { codex: "gpt-5" } },
      updatedAt: "2026-06-01T00:00:00.000Z",
    })
    expect(migration.staleCredentials).toEqual([])

    const backupPath = migration.backupPath!
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600)
    const backup = await readFile(backupPath, "utf8")
    expect(backup).not.toContain("onyx_secret_key")
    expect(backup).not.toContain("apiKeyEnv")
    expect(backup).not.toContain("key_1")
    expect(backup).toContain("Acme Robotics")
    expect(backup).toContain("gpt-5")
    expect(JSON.parse(backup).telemetry).toEqual({
      enabled: false,
      anonymousId: "anon-1",
    })

    const live = await readConfig()
    expect(live.version).toBe(CONFIG_VERSION)
    expect(live.legacyVersion).toBeUndefined()
    expect(live.profiles).toEqual({})
    expect(live.telemetry).toEqual({ enabled: false, anonymousId: "anon-1" })
    expect(await readFile(configPath(), "utf8")).not.toContain("onyx_secret")
    expect(
      (await readdir(configDir())).filter((name) => name.includes("backup"))
    ).toHaveLength(1)
  })

  test("reports v2 credential references so login can remove them", async () => {
    await writeRawConfig({
      version: 2,
      profiles: {
        team: {
          apiUrl: "https://app.onyxresearch.ai",
          cliSessionId: "55555555-5555-4555-8555-555555555555",
          credentialId: "11111111-1111-4111-8111-111111111111",
          credentialStore: "file",
          teamId: "22222222-2222-4222-8222-222222222222",
          teamName: "Team",
          updatedAt: "2026-08-23T12:00:00.000Z",
        },
      },
      currentProfile: "team",
      developer: { mode: "release" },
      telemetry: {},
    })
    expect((await readConfig()).legacyVersion).toBe(2)
    const migration = await migrateLegacyConfigForLogin()
    expect(migration.staleCredentials).toEqual([
      {
        credentialId: "11111111-1111-4111-8111-111111111111",
        credentialStore: "file",
        apiUrl: "https://app.onyxresearch.ai",
        cliSessionId: "55555555-5555-4555-8555-555555555555",
      },
    ])
    expect(await readFile(migration.backupPath!, "utf8")).not.toContain(
      "credentialId"
    )
  })

  test("staging reads the legacy file without touching it", async () => {
    await writeRawConfig(v1Config)
    const before = await readFile(configPath(), "utf8")
    const staged = await stageLegacyConfigMigration()
    expect(staged?.currentProfile).toBe("acme")
    expect(Object.keys(staged?.legacyProfiles ?? {}).sort()).toEqual([
      "acme",
      "ci",
    ])
    expect(staged?.telemetry).toEqual({ enabled: false, anonymousId: "anon-1" })
    expect(await readFile(configPath(), "utf8")).toBe(before)
    expect(
      (await readdir(configDir())).filter((name) => name.includes("backup"))
    ).toEqual([])
  })

  test("is a no-op for current configs", async () => {
    await writeRawConfig({
      version: CONFIG_VERSION,
      profiles: {},
      currentProfile: "",
      developer: { mode: "release" },
      telemetry: {},
    })
    expect(await migrateLegacyConfigForLogin()).toEqual({
      migrated: false,
      legacyProfiles: {},
      staleCredentials: [],
      currentProfile: "",
    })
  })
})
