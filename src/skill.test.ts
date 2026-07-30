import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

import {
  commandAgent,
  defaultSkillInstallTargets,
  installDeveloperSkill,
  skillInstallTarget,
} from "./onyx"
import { ONYX_SKILL_MARKDOWN } from "./lib/skill-content"

async function withManagedSkillHome<T>(fn: (root: string) => Promise<T>) {
  const previousHome = process.env.HOME
  const previousCodexHome = process.env.CODEX_HOME
  const root = await mkdtemp(join(tmpdir(), "onyx-skill-home-"))
  process.env.HOME = root
  process.env.CODEX_HOME = join(root, "custom-codex")
  try {
    return await fn(root)
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
}

describe("managed skill installs", () => {
  test("embedded release skill matches canonical skill markdown", async () => {
    const source = fileURLToPath(
      new URL("../skills/onyx/SKILL.md", import.meta.url)
    )
    expect(ONYX_SKILL_MARKDOWN).toBe(await readFile(source, "utf8"))
  })

  test("agent install-skill writes Claude, Codex, and OpenCode managed targets", async () => {
    await withManagedSkillHome(async () => {
      await commandAgent({
        positional: ["agent", "install-skill"],
        options: { quiet: "true" },
      })

      const targets = defaultSkillInstallTargets()
      expect(targets.map((target) => target.agent)).toEqual([
        "claude",
        "codex",
        "codex-home",
        "opencode",
      ])
      for (const target of targets) {
        expect(await readFile(target.target, "utf8")).toContain("name: onyx")
      }
    })
  })

  test("developer skill install symlinks Claude, Codex, and OpenCode managed targets", async () => {
    await withManagedSkillHome(async (root) => {
      const source = join(root, "checkout", "skills", "onyx", "SKILL.md")
      await mkdir(join(root, "checkout", "skills", "onyx"), {
        recursive: true,
      })
      await writeFile(source, "dev skill\n")

      const installed = await installDeveloperSkill({
        source,
        quiet: true,
      })

      const targets = defaultSkillInstallTargets()
      expect(installed.map((target) => target.target)).toEqual(
        targets.map((target) => target.target)
      )
      for (const target of targets) {
        expect((await lstat(target.target)).isSymbolicLink()).toBe(true)
        expect(await readlink(target.target)).toBe(source)
      }
    })
  })

  test("explicit install directory remains a single custom target", async () => {
    await withManagedSkillHome(async (root) => {
      const customRoot = join(root, "custom-skills")
      await commandAgent({
        positional: ["agent", "install-skill"],
        options: { dir: customRoot, quiet: "true" },
      })

      expect(await readFile(skillInstallTarget(customRoot), "utf8")).toContain(
        "name: onyx"
      )
      for (const target of defaultSkillInstallTargets()) {
        await expect(readFile(target.target, "utf8")).rejects.toThrow()
      }
    })
  })
})
