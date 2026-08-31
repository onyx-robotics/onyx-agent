import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  ONYX_LAUNCHER_BYPASS,
  commandDeveloper,
  defaultSkillInstallTargets,
  detectDeveloperCheckout,
  runLauncher,
  skillInstallTarget,
} from "./onyx"
import { readConfig, writeConfig, type DeveloperCheckout } from "./lib/config"
import { ONYX_WORKER_CONTEXT_SCHEMA_VERSION } from "./lib/version"

function launcherWorkerContext(root: string, workerCliPath: string) {
  return {
    schemaVersion: ONYX_WORKER_CONTEXT_SCHEMA_VERSION,
    campaignId: "campaign-id",
    campaignName: "campaign",
    sessionId: "session-id",
    assignmentId: "assignment-id",
    startingCommitSha: "a".repeat(40),
    hypothesisId: "hypothesis-id",
    hypothesisName: "hypothesis",
    campaign: {
      id: "campaign-id",
      name: "campaign",
      metricName: "error",
      metricUnit: null,
      metricDirection: "minimize",
      baseCommitSha: null,
    },
    assignment: {
      id: "assignment-id",
      startingCommitSha: "a".repeat(40),
      sourceExperimentId: null,
    },
    hypothesis: {
      id: "hypothesis-id",
      name: "hypothesis",
      description: null,
      status: "active",
      plan: {
        focus: "Launcher test",
        statement: "The launcher re-execs the pinned wrapper.",
        startingPoints: [],
        avoidList: [],
        successSignals: [],
        giveUpSignals: [],
      },
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      lastWorkedAt: null,
    },
    workerId: "worker-id",
    workerCredential: `owx_worker_v1_${"0".repeat(32)}`,
    workerCliPath,
    worktreeRoot: root,
    projectPath: "",
    projectRoot: root,
    setupFile: join(root, "onyx/setup.json"),
    validationFile: join(root, "onyx/validation.json"),
    researchSpecFile: join(root, "onyx/onyx.md"),
    researchDeadlineAt: null,
    shutdownDeadlineAt: null,
    shutdownCushionSeconds: null,
  }
}

let configHome: string | null = null
let previousConfigHome: string | undefined
let previousLauncherBypass: string | undefined

async function captureLogs<T>(fn: () => Promise<T>) {
  const previous = console.log
  const logs: string[] = []
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }
  try {
    await fn()
  } finally {
    console.log = previous
  }
  return logs.join("\n")
}

async function writeStandaloneCheckout(root: string) {
  await mkdir(join(root, "bin"), { recursive: true })
  await mkdir(join(root, "skills", "onyx"), { recursive: true })
  await writeFile(join(root, "bin", "onyx.js"), "#!/usr/bin/env bun\n")
  await writeFile(join(root, "bin", "onyx-worker.js"), "#!/usr/bin/env bun\n")
  await writeFile(join(root, "skills", "onyx", "SKILL.md"), "dev skill\n")
}

async function writeProductCheckout(root: string) {
  await mkdir(join(root, "packages", "agent", "bin"), { recursive: true })
  await mkdir(join(root, "packages", "agent", "skills", "onyx"), {
    recursive: true,
  })
  await writeFile(
    join(root, "packages", "agent", "bin", "onyx.js"),
    "#!/usr/bin/env bun\n"
  )
  await writeFile(
    join(root, "packages", "agent", "bin", "onyx-worker.js"),
    "#!/usr/bin/env bun\n"
  )
  await writeFile(
    join(root, "packages", "agent", "skills", "onyx", "SKILL.md"),
    "product dev skill\n"
  )
}

describe("developer mode", () => {
  beforeEach(async () => {
    previousConfigHome = process.env.XDG_CONFIG_HOME
    previousLauncherBypass = process.env[ONYX_LAUNCHER_BYPASS]
    configHome = await mkdtemp(join(tmpdir(), "onyx-developer-config-test-"))
    process.env.XDG_CONFIG_HOME = configHome
    delete process.env[ONYX_LAUNCHER_BYPASS]
  })

  afterEach(async () => {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
    if (previousLauncherBypass === undefined) {
      delete process.env[ONYX_LAUNCHER_BYPASS]
    } else {
      process.env[ONYX_LAUNCHER_BYPASS] = previousLauncherBypass
    }
    if (configHome) await rm(configHome, { recursive: true, force: true })
    configHome = null
  })

  test("detects standalone and product checkouts", async () => {
    const standalone = await mkdtemp(join(tmpdir(), "onyx-agent-dev-"))
    const product = await mkdtemp(join(tmpdir(), "onyx-product-dev-"))
    try {
      await writeStandaloneCheckout(standalone)
      await writeProductCheckout(product)
      const standaloneRoot = await realpath(standalone)
      const productRoot = await realpath(product)

      expect(await detectDeveloperCheckout(standalone)).toMatchObject({
        root: standaloneRoot,
        binPath: join(standaloneRoot, "bin", "onyx.js"),
        workerBinPath: join(standaloneRoot, "bin", "onyx-worker.js"),
        skillPath: join(standaloneRoot, "skills", "onyx", "SKILL.md"),
      })
      expect(await detectDeveloperCheckout(product)).toMatchObject({
        root: productRoot,
        binPath: join(productRoot, "packages", "agent", "bin", "onyx.js"),
        workerBinPath: join(
          productRoot,
          "packages",
          "agent",
          "bin",
          "onyx-worker.js"
        ),
        skillPath: join(
          productRoot,
          "packages",
          "agent",
          "skills",
          "onyx",
          "SKILL.md"
        ),
      })
    } finally {
      await rm(standalone, { recursive: true, force: true })
      await rm(product, { recursive: true, force: true })
    }
  })

  test("rejects paths missing the CLI bin or skill file", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-agent-missing-"))
    try {
      await expect(detectDeveloperCheckout(root)).rejects.toThrow(
        "No Onyx agent checkout found"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("link records resolved checkout paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-agent-link-"))
    try {
      await writeStandaloneCheckout(root)
      const checkoutRoot = await realpath(root)
      await commandDeveloper({
        positional: ["developer", "link", root],
        options: { quiet: "true" },
      })

      const config = await readConfig()
      expect(config.developer.mode).toBe("release")
      expect(config.developer.checkout).toMatchObject({
        root: checkoutRoot,
        binPath: join(checkoutRoot, "bin", "onyx.js"),
        workerBinPath: join(checkoutRoot, "bin", "onyx-worker.js"),
        skillPath: join(checkoutRoot, "skills", "onyx", "SKILL.md"),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("profile config writes preserve developer state when omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-agent-preserve-"))
    try {
      await writeStandaloneCheckout(root)
      const checkout = await detectDeveloperCheckout(root)
      await writeConfig({
        currentProfile: "",
        profiles: {},
        developer: { mode: "dev", checkout },
      })

      await writeConfig({
        currentProfile: "alpha",
        profiles: {
          alpha: {
            apiUrl: "https://app.onyx.test",
            credentialId: "11111111-1111-4111-8111-111111111111",
            credentialStore: "file",
            teamId: "22222222-2222-4222-8222-222222222222",
            teamName: "Alpha Team",
            updatedAt: "2026-06-06T12:00:00.000Z",
          },
        },
      })

      expect((await readConfig()).developer).toEqual({
        mode: "dev",
        checkout,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("use dev requires a linked checkout", async () => {
    await expect(
      commandDeveloper({
        positional: ["developer", "use", "dev"],
        options: { quiet: "true" },
      })
    ).rejects.toThrow("No developer checkout linked")
  })

  test("switches skill files between dev symlink and release copy", async () => {
    const checkoutRoot = await mkdtemp(join(tmpdir(), "onyx-agent-skill-dev-"))
    const skillRoot = await mkdtemp(join(tmpdir(), "onyx-agent-skill-root-"))
    try {
      await writeStandaloneCheckout(checkoutRoot)
      const checkoutRealRoot = await realpath(checkoutRoot)
      await commandDeveloper({
        positional: ["developer", "link", checkoutRoot],
        options: { quiet: "true" },
      })

      await commandDeveloper({
        positional: ["developer", "use", "dev"],
        options: { "skill-dir": skillRoot, quiet: "true" },
      })
      const target = skillInstallTarget(skillRoot)
      expect((await lstat(target)).isSymbolicLink()).toBe(true)
      expect(await readlink(target)).toBe(
        join(checkoutRealRoot, "skills", "onyx", "SKILL.md")
      )
      await writeFile(
        join(checkoutRealRoot, "skills", "onyx", "SKILL.md"),
        "updated dev skill\n"
      )
      expect(await readFile(target, "utf8")).toBe("updated dev skill\n")
      expect((await readConfig()).developer.mode).toBe("dev")

      await commandDeveloper({
        positional: ["developer", "use", "release"],
        options: { "skill-dir": skillRoot, quiet: "true" },
      })
      expect((await lstat(target)).isSymbolicLink()).toBe(false)
      expect(await readFile(target, "utf8")).toContain("name: onyx")
      await writeFile(
        join(checkoutRealRoot, "skills", "onyx", "SKILL.md"),
        "dev skill after release\n"
      )
      expect(await readFile(target, "utf8")).not.toBe(
        "dev skill after release\n"
      )
      expect((await readConfig()).developer.mode).toBe("release")
    } finally {
      await rm(checkoutRoot, { recursive: true, force: true })
      await rm(skillRoot, { recursive: true, force: true })
    }
  })

  test("use dev syncs managed Claude, Codex, and OpenCode skill targets by default", async () => {
    const previousHome = process.env.HOME
    const previousCodexHome = process.env.CODEX_HOME
    const root = await mkdtemp(join(tmpdir(), "onyx-agent-managed-skill-"))
    const checkoutRoot = join(root, "checkout")
    process.env.HOME = join(root, "home")
    process.env.CODEX_HOME = join(root, "codex-home")
    try {
      await writeStandaloneCheckout(checkoutRoot)
      const checkoutRealRoot = await realpath(checkoutRoot)
      await commandDeveloper({
        positional: ["developer", "link", checkoutRoot],
        options: { quiet: "true" },
      })

      await commandDeveloper({
        positional: ["developer", "use", "dev"],
        options: { quiet: "true" },
      })

      const source = join(checkoutRealRoot, "skills", "onyx", "SKILL.md")
      for (const target of defaultSkillInstallTargets()) {
        expect((await lstat(target.target)).isSymbolicLink()).toBe(true)
        expect(await readlink(target.target)).toBe(source)
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test("unlink restores release mode and clears dev state", async () => {
    const checkoutRoot = await mkdtemp(join(tmpdir(), "onyx-agent-unlink-"))
    const skillRoot = await mkdtemp(join(tmpdir(), "onyx-agent-unlink-skill-"))
    try {
      await writeStandaloneCheckout(checkoutRoot)
      await commandDeveloper({
        positional: ["developer", "link", checkoutRoot],
        options: { quiet: "true" },
      })
      await commandDeveloper({
        positional: ["developer", "use", "dev"],
        options: { "skill-dir": skillRoot, quiet: "true" },
      })

      await commandDeveloper({
        positional: ["developer", "unlink"],
        options: { "skill-dir": skillRoot, quiet: "true" },
      })

      const config = await readConfig()
      expect(config.developer).toEqual({ mode: "release" })
      expect(
        (await lstat(skillInstallTarget(skillRoot))).isSymbolicLink()
      ).toBe(false)
    } finally {
      await rm(checkoutRoot, { recursive: true, force: true })
      await rm(skillRoot, { recursive: true, force: true })
    }
  })

  test("status reports mode and linked checkout", async () => {
    const checkoutRoot = await mkdtemp(join(tmpdir(), "onyx-agent-status-"))
    try {
      await writeStandaloneCheckout(checkoutRoot)
      const checkoutRealRoot = await realpath(checkoutRoot)
      await commandDeveloper({
        positional: ["developer", "link", checkoutRoot],
        options: { quiet: "true" },
      })

      const output = await captureLogs(() =>
        commandDeveloper({
          positional: ["developer", "status"],
          options: {},
        })
      )

      expect(output).toContain("Mode: release")
      expect(output).toContain(`Developer checkout: ${checkoutRealRoot}`)
      expect(output).toContain("Skill targets:")
    } finally {
      await rm(checkoutRoot, { recursive: true, force: true })
    }
  })

  test("launcher handles developer commands before dev dispatch", async () => {
    let dispatched = false
    const output = await captureLogs(() =>
      runLauncher({
        argv: ["developer", "status"],
        runDev: async () => {
          dispatched = true
          return 0
        },
      })
    )

    expect(dispatched).toBe(false)
    expect(output).toContain("Mode: release")
  })

  test("launcher dispatches normal commands to linked dev checkout", async () => {
    const checkoutRoot = await mkdtemp(join(tmpdir(), "onyx-agent-dispatch-"))
    try {
      await writeStandaloneCheckout(checkoutRoot)
      const checkout = await detectDeveloperCheckout(checkoutRoot)
      await writeConfig({
        currentProfile: "",
        profiles: {},
        developer: { mode: "dev", checkout },
      })

      const calls: Array<{
        checkout: DeveloperCheckout
        argv: string[]
        env: NodeJS.ProcessEnv
      }> = []
      const code = await runLauncher({
        argv: ["status"],
        env: {},
        runDev: async (linkedCheckout, argv, env) => {
          calls.push({ checkout: linkedCheckout, argv, env })
          return 7
        },
      })

      expect(code).toBe(7)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.checkout).toEqual(checkout)
      expect(calls[0]?.argv).toEqual(["status"])
    } finally {
      await rm(checkoutRoot, { recursive: true, force: true })
    }
  })

  test("launcher bypass runs the local CLI", async () => {
    // Path-based distribution detection only recognizes monorepo checkouts
    // (paths containing /packages/agent/); pin the override so the assertion
    // holds in standalone checkouts such as this repo's own CI.
    const previousDistribution = process.env.ONYX_DISTRIBUTION
    process.env.ONYX_DISTRIBUTION = "source"
    try {
      const output = await captureLogs(() =>
        runLauncher({
          argv: ["--version"],
          env: { [ONYX_LAUNCHER_BYPASS]: "1" },
          runDev: async () => {
            throw new Error("should not dispatch")
          },
        })
      )

      // Version-agnostic: releases bump package.json without editing tests.
      expect(output).toMatch(/onyx \d+\.\d+\.\d+ \(protocol \d+, source/)
    } finally {
      if (previousDistribution === undefined)
        delete process.env.ONYX_DISTRIBUTION
      else process.env.ONYX_DISTRIBUTION = previousDistribution
    }
  })

  test("worker launcher re-execs the pinned wrapper from the runtime context", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-redirect-"))
    try {
      const markerPath = join(root, "marker.txt")
      const wrapperPath = join(root, "onyx-worker")
      await writeFile(
        wrapperPath,
        [
          "#!/bin/sh",
          `printf '%s' "$*" > ${JSON.stringify(markerPath)}`,
          "exit 3",
          "",
        ].join("\n"),
        "utf8"
      )
      await chmod(wrapperPath, 0o755)
      const contextPath = join(root, "context.json")
      await writeFile(
        contextPath,
        JSON.stringify(launcherWorkerContext(root, wrapperPath)),
        "utf8"
      )

      const code = await runLauncher({
        argv: ["exp", "list"],
        env: { ONYX_WORKER_CONTEXT: contextPath },
        entrypoint: "onyx-worker",
        runMain: async () => {
          throw new Error("should not run the local CLI")
        },
        runDev: async () => {
          throw new Error("should not dispatch to dev")
        },
      })

      expect(code).toBe(3)
      expect(await readFile(markerPath, "utf8")).toBe("exp list")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker launcher fails closed when the pinned wrapper is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-no-redirect-"))
    try {
      const contextPath = join(root, "context.json")
      await writeFile(
        contextPath,
        JSON.stringify(
          launcherWorkerContext(root, join(root, "missing-wrapper"))
        ),
        "utf8"
      )
      let ranMain = 0
      await expect(
        runLauncher({
          argv: ["--version"],
          env: { ONYX_WORKER_CONTEXT: contextPath },
          entrypoint: "onyx-worker",
          runMain: async () => {
            ranMain += 1
          },
          runDev: async () => {
            throw new Error("should not dispatch to dev")
          },
        })
      ).rejects.toThrow("missing or not executable")
      expect(ranMain).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker launcher fails closed on unreadable, invalid, or incomplete contexts", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-fail-closed-"))
    try {
      const wrapperPath = join(root, "onyx-worker")
      await writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", "utf8")
      await chmod(wrapperPath, 0o755)
      const runWith = (contextPath: string) =>
        runLauncher({
          argv: ["--version"],
          env: { ONYX_WORKER_CONTEXT: contextPath },
          entrypoint: "onyx-worker",
          runMain: async () => {
            throw new Error("should not run the local CLI")
          },
          runDev: async () => {
            throw new Error("should not dispatch to dev")
          },
        })

      await expect(runWith(join(root, "missing-context.json"))).rejects.toThrow(
        "missing or unreadable"
      )

      const badJsonPath = join(root, "bad.json")
      await writeFile(badJsonPath, "{{{", "utf8")
      await expect(runWith(badJsonPath)).rejects.toThrow("not valid JSON")

      const wrongSchemaPath = join(root, "wrong-schema.json")
      await writeFile(
        wrongSchemaPath,
        JSON.stringify({
          ...launcherWorkerContext(root, wrapperPath),
          schemaVersion: 1,
        }),
        "utf8"
      )
      await expect(runWith(wrongSchemaPath)).rejects.toThrow(
        "unsupported schema"
      )

      const missingCliPath = join(root, "missing-cli.json")
      const noCli = launcherWorkerContext(root, wrapperPath) as Record<
        string,
        unknown
      >
      delete noCli.workerCliPath
      await writeFile(missingCliPath, JSON.stringify(noCli), "utf8")
      await expect(runWith(missingCliPath)).rejects.toThrow("workerCliPath")

      const notExecutablePath = join(root, "not-executable.json")
      const plainFile = join(root, "plain-file")
      await writeFile(plainFile, "not a wrapper", "utf8")
      await chmod(plainFile, 0o644)
      await writeFile(
        notExecutablePath,
        JSON.stringify(launcherWorkerContext(root, plainFile)),
        "utf8"
      )
      await expect(runWith(notExecutablePath)).rejects.toThrow(
        "missing or not executable"
      )

      // Error output must never leak the scoped credential or context body.
      const credential = launcherWorkerContext(root, wrapperPath)
        .workerCredential as string
      for (const path of [badJsonPath, wrongSchemaPath, notExecutablePath]) {
        const error = await runWith(path).catch((cause: Error) => cause)
        expect(String(error)).not.toContain(credential)
        expect(String(error)).not.toContain("owx_worker_v1")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("redirected worker launcher skips re-exec and runs main", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-redirected-"))
    try {
      const contextPath = join(root, "context.json")
      await writeFile(
        contextPath,
        JSON.stringify(
          launcherWorkerContext(root, join(root, "missing-wrapper"))
        ),
        "utf8"
      )
      let ranMain = 0
      const code = await runLauncher({
        argv: ["--version"],
        env: {
          ONYX_WORKER_CONTEXT: contextPath,
          ONYX_WORKER_CLI_REDIRECTED: "1",
        },
        entrypoint: "onyx-worker",
        runMain: async () => {
          ranMain += 1
        },
        runDev: async () => {
          throw new Error("should not dispatch to dev")
        },
      })
      expect(code).toBe(0)
      expect(ranMain).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("launcher reports missing linked dev files", async () => {
    await writeConfig({
      currentProfile: "",
      profiles: {},
      developer: {
        mode: "dev",
        checkout: {
          root: "/missing",
          binPath: "/missing/bin/onyx.js",
          workerBinPath: "/missing/bin/onyx-worker.js",
          skillPath: "/missing/skills/onyx/SKILL.md",
        },
      },
    })

    await expect(
      runLauncher({
        argv: ["status"],
        runDev: async () => 0,
      })
    ).rejects.toThrow("CLI entrypoint is missing")
  })
})
