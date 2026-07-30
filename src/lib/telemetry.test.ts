import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseArgs } from "./args"
import { DEFAULT_API_URL, emptyConfig, readConfig, writeConfig } from "./config"
import {
  cliCommandName,
  markResearchPreflightFailure,
  maybeShowFirstRunNotice,
  recordCliCommand,
  recordCliTui,
  recordSetupInitialized,
  recordSetupValidation,
  resetNoticeStateForTests,
  setTelemetryClientFactoryForTests,
  telemetryEffectiveState,
  updateTelemetryPreference,
} from "./telemetry"

const ENV_KEYS = [
  "ONYX_HOME",
  "ONYX_DISTRIBUTION",
  "ONYX_POSTHOG_KEY",
  "ONYX_POSTHOG_HOST",
  "ONYX_TELEMETRY_TEST",
  "ONYX_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "CI",
  "ONYX_WORKER_CONTEXT",
  "ONYX_WORKER_ID",
  "ONYX_WORKER_CREDENTIAL",
  "ONYX_SUPERVISOR_RUN_ID",
  "ONYX_AUTOMATION",
  "ONYX_SYNTHETIC_WORKER",
  "ONYX_TESTBED",
  "ONYX_TEST_DATABASE_URL",
  "ONYX_TEST_SUPABASE_URL",
] as const

let runtimeRoot = ""
let originalEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  )
  for (const key of ENV_KEYS) delete process.env[key]
  runtimeRoot = await mkdtemp(join(tmpdir(), "onyx-telemetry-test-"))
  process.env.ONYX_HOME = runtimeRoot
  process.env.ONYX_DISTRIBUTION = "release"
  process.env.ONYX_POSTHOG_KEY = "phc_test_project_token"
  process.env.ONYX_TELEMETRY_TEST = "1"
  await writeConfig({
    ...emptyConfig(),
    profiles: {
      onyx: {
        apiUrl: DEFAULT_API_URL,
        teamId: "11111111-1111-4111-8111-111111111111",
        teamName: "Onyx",
        userId: "22222222-2222-4222-8222-222222222222",
        updatedAt: new Date(0).toISOString(),
      },
    },
    currentProfile: "onyx",
    telemetry: {
      enabled: true,
      anonymousId: "33333333-3333-4333-8333-333333333333",
      noticeShownAt: "2026-07-01T00:00:00.000Z",
    },
  })
  resetNoticeStateForTests()
})

afterEach(async () => {
  setTelemetryClientFactoryForTests(null)
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe("CLI telemetry", () => {
  test("maps only allowlisted command names", () => {
    expect(
      cliCommandName(["setup", "validate", "--project-path", "/secret"])
    ).toBe("setup.validate")
    expect(cliCommandName(["unknown", "private-value"])).toBeNull()
  })

  test("captures one bounded outcome without arguments", async () => {
    const captures: Array<Record<string, unknown>> = []
    setTelemetryClientFactoryForTests(() => ({
      capture(message) {
        captures.push(message as unknown as Record<string, unknown>)
      },
      async shutdown() {},
    }))

    await recordCliCommand({
      argv: ["setup", "validate", "--project-path", "/Users/person/private"],
      args: parseArgs([
        "setup",
        "validate",
        "--project-path",
        "/Users/person/private",
      ]),
      startedAt: Date.now() - 123,
    })

    expect(captures).toHaveLength(1)
    expect(captures[0]?.event).toBe("cli:command_complete")
    expect(JSON.stringify(captures[0])).not.toContain("/Users/person/private")
    expect(captures[0]?.distinctId).toBe("22222222-2222-4222-8222-222222222222")
  })

  test("environment opt-outs and worker context always suppress capture", async () => {
    const config = {
      ...emptyConfig(),
      telemetry: {
        enabled: true,
        anonymousId: "33333333-3333-4333-8333-333333333333",
      },
    }
    process.env.DO_NOT_TRACK = "1"
    expect(telemetryEffectiveState({ config }).enabled).toBe(false)
    delete process.env.DO_NOT_TRACK
    process.env.ONYX_WORKER_CONTEXT = "/tmp/context.json"
    expect(telemetryEffectiveState({ config }).enabled).toBe(false)
  })

  test("runtime environment variables cannot turn a source build into an official telemetry build", async () => {
    const config = await readConfig()
    delete process.env.ONYX_TELEMETRY_TEST
    process.env.ONYX_DISTRIBUTION = "release"
    process.env.ONYX_POSTHOG_KEY = "phc_runtime_injected_token"
    expect(telemetryEffectiveState({ config }).enabled).toBe(false)
  })

  test("suppresses every automation, worker, CI, synthetic, and testbed marker", async () => {
    const config = await readConfig()
    for (const key of [
      "CI",
      "ONYX_AUTOMATION",
      "ONYX_SUPERVISOR_RUN_ID",
      "ONYX_SYNTHETIC_WORKER",
      "ONYX_TESTBED",
      "ONYX_WORKER_CONTEXT",
      "ONYX_WORKER_CREDENTIAL",
      "ONYX_WORKER_ID",
    ] as const) {
      process.env[key] = "1"
      expect(telemetryEffectiveState({ config }).enabled).toBe(false)
      delete process.env[key]
    }
  })

  test("keeps backward-compatible profiles installation-identified without aliasing", async () => {
    const config = await readConfig()
    const profile = config.profiles.onyx!
    await writeConfig({
      ...config,
      profiles: { onyx: { ...profile, userId: undefined } },
    })
    const captures: Array<Record<string, unknown>> = []
    setTelemetryClientFactoryForTests(() => ({
      capture(message) {
        captures.push(message as unknown as Record<string, unknown>)
      },
      async shutdown() {},
    }))

    await recordCliCommand({
      argv: ["status"],
      args: parseArgs(["status"]),
      startedAt: Date.now(),
    })

    expect(captures).toHaveLength(1)
    expect(captures[0]?.distinctId).toBe("33333333-3333-4333-8333-333333333333")
    expect(captures[0]?.event).not.toBe("$create_alias")
    expect(captures[0]?.properties).toMatchObject({
      $process_person_profile: false,
    })
  })

  test("enable and disable preferences are deterministic", async () => {
    await updateTelemetryPreference(false)
    const disabled = await readConfig()
    expect(disabled.telemetry.enabled).toBe(false)
    expect(telemetryEffectiveState({ config: disabled }).enabled).toBe(false)
    await updateTelemetryPreference(true)
    const enabled = await readConfig()
    expect(enabled.telemetry.enabled).toBe(true)
    expect(enabled.telemetry.anonymousId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  test("collects the first eligible command and creates installation identity", async () => {
    const config = await readConfig()
    await writeConfig({
      ...config,
      profiles: {},
      currentProfile: "",
      telemetry: {
        enabled: true,
        noticeShownAt: "2026-07-01T00:00:00.000Z",
      },
    })
    const captures: Array<Record<string, unknown>> = []
    setTelemetryClientFactoryForTests(() => ({
      capture(message) {
        captures.push(message as unknown as Record<string, unknown>)
      },
      async shutdown() {},
    }))
    const args = parseArgs(["status"])
    await recordCliCommand({ argv: ["status"], args, startedAt: Date.now() })
    expect(captures).toHaveLength(1)
    const stored = await readConfig()
    expect(stored.telemetry.anonymousId).toBe(
      captures[0]?.distinctId as string | undefined
    )
    expect(captures[0]?.properties).toMatchObject({
      $process_person_profile: false,
    })
  })

  test("captures bounded TUI, validation, timeout, and interruption outcomes", async () => {
    const captures: Array<Record<string, unknown>> = []
    setTelemetryClientFactoryForTests(() => ({
      capture(message) {
        captures.push(message as unknown as Record<string, unknown>)
      },
      async shutdown() {},
    }))
    const args = parseArgs(["listen"])
    await recordCliTui("started", args)
    await recordCliTui("ended", args, Date.now() - 400)
    await recordSetupValidation({
      args,
      passed: false,
      failedCheckCount: 3,
      warningCheckCount: 2,
    })
    await recordSetupInitialized(args)
    await recordCliCommand({
      argv: ["status"],
      args,
      startedAt: Date.now() - 100,
      error: new Error("request timed out"),
    })
    await recordCliCommand({
      argv: ["status"],
      args,
      startedAt: Date.now() - 100,
      error: new Error("interrupted by SIGINT"),
    })

    expect(captures.map((capture) => capture.event)).toEqual([
      "cli:tui_start",
      "cli:tui_end",
      "setup:validation_complete",
      "setup:setup_initialize",
      "cli:command_complete",
      "cli:command_complete",
    ])
    expect(captures[4]?.properties).toMatchObject({
      outcome: "timeout",
      failure_stage: "interruption",
      reason_code: "timeout",
    })
    expect(captures[5]?.properties).toMatchObject({
      outcome: "interrupted",
      failure_stage: "interruption",
      reason_code: "interrupted",
    })
  })

  test("never waits longer than the shutdown budget", async () => {
    setTelemetryClientFactoryForTests(() => ({
      capture() {},
      shutdown: () => new Promise<void>(() => {}),
    }))
    const startedAt = Date.now()
    await recordCliCommand({
      argv: ["status"],
      args: parseArgs(["status"]),
      startedAt,
    })
    expect(Date.now() - startedAt).toBeLessThan(400)
  })

  test("batches a marked preflight failure within one shutdown budget", async () => {
    const events: string[] = []
    let shutdowns = 0
    setTelemetryClientFactoryForTests(() => ({
      capture(message) {
        events.push(message.event)
      },
      async shutdown() {
        shutdowns += 1
      },
    }))
    const error = new Error("provider preflight failed")
    markResearchPreflightFailure(error)
    await recordCliCommand({
      argv: ["research", "run"],
      args: parseArgs(["research", "run"]),
      startedAt: Date.now() - 100,
      error,
    })
    expect(events).toEqual(["cli:command_complete", "research:preflight_fail"])
    expect(shutdowns).toBe(1)
  })

  test("batches TUI end and command completion within one shutdown budget", async () => {
    const events: string[] = []
    let shutdowns = 0
    setTelemetryClientFactoryForTests(() => ({
      capture(message) {
        events.push(message.event)
      },
      async shutdown() {
        shutdowns += 1
      },
    }))
    await recordCliCommand({
      argv: ["listen"],
      args: parseArgs(["listen"]),
      startedAt: Date.now() - 100,
      tuiStartedAt: Date.now() - 100,
    })
    expect(events).toEqual(["cli:command_complete", "cli:tui_end"])
    expect(shutdowns).toBe(1)
  })

  test("captures nothing and mints no identity before the first-run notice", async () => {
    const config = await readConfig()
    await writeConfig({
      ...config,
      telemetry: { enabled: true },
    })
    const captures: Array<Record<string, unknown>> = []
    setTelemetryClientFactoryForTests(() => ({
      capture(message) {
        captures.push(message as unknown as Record<string, unknown>)
      },
      async shutdown() {},
    }))

    await recordCliCommand({
      argv: ["status"],
      args: parseArgs(["status"]),
      startedAt: Date.now(),
    })

    expect(captures).toHaveLength(0)
    const stored = await readConfig()
    expect(stored.telemetry.anonymousId).toBeUndefined()
    expect(stored.telemetry.noticeShownAt).toBeUndefined()
  })

  test("first-run notice suppresses capture for its own run and enables the next", async () => {
    const config = await readConfig()
    await writeConfig({
      ...config,
      telemetry: { enabled: true },
    })
    const captures: Array<Record<string, unknown>> = []
    setTelemetryClientFactoryForTests(() => ({
      capture(message) {
        captures.push(message as unknown as Record<string, unknown>)
      },
      async shutdown() {},
    }))
    const stderrDescriptor = Object.getOwnPropertyDescriptor(
      process.stderr,
      "isTTY"
    )
    const writes: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    })
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const shown = await maybeShowFirstRunNotice(parseArgs(["status"]))
      expect(shown).toBe(true)
      expect(writes.join("")).toContain("onyx telemetry disable")

      await recordCliCommand({
        argv: ["status"],
        args: parseArgs(["status"]),
        startedAt: Date.now(),
      })
      expect(captures).toHaveLength(0)

      const stored = await readConfig()
      expect(stored.telemetry.noticeShownAt).toBeTruthy()
      expect(stored.telemetry.anonymousId).toBeTruthy()

      resetNoticeStateForTests()
      await recordCliCommand({
        argv: ["status"],
        args: parseArgs(["status"]),
        startedAt: Date.now(),
      })
      expect(captures).toHaveLength(1)

      const secondShow = await maybeShowFirstRunNotice(parseArgs(["status"]))
      expect(secondShow).toBe(false)
    } finally {
      process.stderr.write = originalWrite
      if (stderrDescriptor) {
        Object.defineProperty(process.stderr, "isTTY", stderrDescriptor)
      }
    }
  })

  test("first-run notice never shows for opted-out, suppressed, json, or non-TTY runs", async () => {
    const config = await readConfig()
    await writeConfig({
      ...config,
      telemetry: { enabled: true },
    })
    const stderrDescriptor = Object.getOwnPropertyDescriptor(
      process.stderr,
      "isTTY"
    )
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    })
    try {
      process.env.DO_NOT_TRACK = "1"
      expect(await maybeShowFirstRunNotice(parseArgs(["status"]))).toBe(false)
      delete process.env.DO_NOT_TRACK

      expect(
        await maybeShowFirstRunNotice(parseArgs(["status", "--json"]))
      ).toBe(false)

      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      })
      expect(await maybeShowFirstRunNotice(parseArgs(["status"]))).toBe(false)

      const stored = await readConfig()
      expect(stored.telemetry.noticeShownAt).toBeUndefined()
    } finally {
      if (stderrDescriptor) {
        Object.defineProperty(process.stderr, "isTTY", stderrDescriptor)
      }
    }
  })

  test("explicit enable supersedes the first-run notice", async () => {
    const config = await readConfig()
    await writeConfig({
      ...config,
      telemetry: { enabled: true },
    })
    await updateTelemetryPreference(true)
    const stored = await readConfig()
    expect(stored.telemetry.noticeShownAt).toBeTruthy()
    expect(telemetryEffectiveState({ config: stored }).enabled).toBe(true)
  })

  test("noticeShownAt round-trips through config normalization", async () => {
    const config = await readConfig()
    await writeConfig({
      ...config,
      telemetry: {
        ...config.telemetry,
        noticeShownAt: "2026-07-30T09:00:00.000Z",
      },
    })
    const stored = await readConfig()
    expect(stored.telemetry.noticeShownAt).toBe("2026-07-30T09:00:00.000Z")
  })
})
