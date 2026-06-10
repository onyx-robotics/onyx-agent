import {
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

import { beforeEach, describe, expect, test } from "bun:test"

import {
  ONYX_LAUNCHER_BYPASS,
  commandDeveloper,
  detectDeveloperCheckout,
  runLauncher,
  skillInstallTarget,
} from "./onyx"
import {
  readConfig,
  writeConfig,
  type DeveloperCheckout,
} from "./lib/config"

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
    join(root, "packages", "agent", "skills", "onyx", "SKILL.md"),
    "product dev skill\n"
  )
}

describe("developer mode", () => {
  beforeEach(async () => {
    process.env.XDG_CONFIG_HOME = await mkdtemp(
      join(tmpdir(), "onyx-developer-config-test-")
    )
    delete process.env[ONYX_LAUNCHER_BYPASS]
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
        skillPath: join(standaloneRoot, "skills", "onyx", "SKILL.md"),
      })
      expect(await detectDeveloperCheckout(product)).toMatchObject({
        root: productRoot,
        binPath: join(productRoot, "packages", "agent", "bin", "onyx.js"),
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
            apiKey: "onyx_key",
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
      expect((await lstat(skillInstallTarget(skillRoot))).isSymbolicLink()).toBe(
        false
      )
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
      expect(output).toContain("Skill target:")
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
    const output = await captureLogs(() =>
      runLauncher({
        argv: ["--version"],
        env: { [ONYX_LAUNCHER_BYPASS]: "1" },
        runDev: async () => {
          throw new Error("should not dispatch")
        },
      })
    )

    expect(output).toBe("0.1.3")
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
