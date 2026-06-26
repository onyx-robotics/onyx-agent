import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { ONYX_SKILL_MARKDOWN } from "./skill-content"

export const ONYX_SKILL_NAME = "onyx"

export type ManagedSkillInstallTarget = {
  agent: "claude" | "codex" | "codex-home" | "opencode" | "custom"
  label: string
  root: string
  target: string
}

export function defaultSkillInstallRoot() {
  return claudeSkillInstallRoot()
}

function userHomeDir() {
  return process.env.HOME?.trim() || homedir()
}

export function claudeSkillInstallRoot() {
  return join(userHomeDir(), ".claude", "skills")
}

export function codexUserSkillInstallRoot() {
  return join(userHomeDir(), ".agents", "skills")
}

export function codexHomeSkillInstallRoot() {
  return join(
    process.env.CODEX_HOME?.trim() || join(userHomeDir(), ".codex"),
    "skills"
  )
}

export function opencodeSkillInstallRoot() {
  return join(userHomeDir(), ".config", "opencode", "skills")
}

export function skillInstallTarget(root = defaultSkillInstallRoot()) {
  return join(root, ONYX_SKILL_NAME, "SKILL.md")
}

function uniqueInstallTargets(
  targets: ManagedSkillInstallTarget[]
): ManagedSkillInstallTarget[] {
  const seen = new Set<string>()
  const unique: ManagedSkillInstallTarget[] = []
  for (const target of targets) {
    if (seen.has(target.target)) {
      continue
    }
    seen.add(target.target)
    unique.push(target)
  }
  return unique
}

export function defaultSkillInstallTargets(): ManagedSkillInstallTarget[] {
  return uniqueInstallTargets([
    {
      agent: "claude",
      label: "Claude",
      root: claudeSkillInstallRoot(),
      target: skillInstallTarget(claudeSkillInstallRoot()),
    },
    {
      agent: "codex",
      label: "Codex",
      root: codexUserSkillInstallRoot(),
      target: skillInstallTarget(codexUserSkillInstallRoot()),
    },
    {
      agent: "codex-home",
      label: "Codex (CODEX_HOME)",
      root: codexHomeSkillInstallRoot(),
      target: skillInstallTarget(codexHomeSkillInstallRoot()),
    },
    {
      agent: "opencode",
      label: "OpenCode",
      root: opencodeSkillInstallRoot(),
      target: skillInstallTarget(opencodeSkillInstallRoot()),
    },
  ])
}

function customSkillInstallTarget(root: string): ManagedSkillInstallTarget {
  return {
    agent: "custom",
    label: "custom",
    root,
    target: skillInstallTarget(root),
  }
}

export function packagedSkillPath() {
  return fileURLToPath(new URL("../../skills/onyx/SKILL.md", import.meta.url))
}

export async function readPackagedSkill() {
  try {
    return await readFile(packagedSkillPath(), "utf8")
  } catch {
    return ONYX_SKILL_MARKDOWN
  }
}

async function replaceSkillTarget(target: string) {
  try {
    const stat = await lstat(target)
    if (stat.isDirectory()) {
      await rm(target, { recursive: true, force: true })
      return
    }
  } catch {
    // Missing targets are fine; the caller is about to create one.
  }
  await rm(target, { force: true })
}

async function writeReleaseSkillTarget(
  target: ManagedSkillInstallTarget,
  quiet: boolean,
  message: string
) {
  await mkdir(dirname(target.target), { recursive: true })
  await replaceSkillTarget(target.target)
  await writeFile(target.target, await readPackagedSkill(), "utf8")
  if (!quiet) {
    const suffix = target.label === "custom" ? "" : ` for ${target.label}`
    console.log(`${message}${suffix} to ${target.target}`)
  }
  return target.target
}

export async function installOnyxSkill({
  dir,
  quiet = false,
}: {
  dir?: string
  quiet?: boolean
} = {}) {
  const targets = dir
    ? [customSkillInstallTarget(dir)]
    : defaultSkillInstallTargets()
  const installed: string[] = []
  for (const target of targets) {
    installed.push(
      await writeReleaseSkillTarget(target, quiet, "Installed Onyx agent skill")
    )
  }
  return installed
}

export async function installReleaseSkill({
  dir,
  quiet = false,
}: {
  dir?: string
  quiet?: boolean
} = {}) {
  const targets = dir
    ? [customSkillInstallTarget(dir)]
    : defaultSkillInstallTargets()
  const installed: string[] = []
  for (const target of targets) {
    installed.push(
      await writeReleaseSkillTarget(
        target,
        quiet,
        "Installed release Onyx agent skill"
      )
    )
  }
  return installed
}

export async function installDeveloperSkill({
  source,
  dir,
  quiet = false,
}: {
  source: string
  dir?: string
  quiet?: boolean
}) {
  const targets = dir
    ? [customSkillInstallTarget(dir)]
    : defaultSkillInstallTargets()
  const installed: Array<{ target: string; linked: boolean }> = []
  for (const target of targets) {
    await mkdir(dirname(target.target), { recursive: true })
    await replaceSkillTarget(target.target)
    const suffix = target.label === "custom" ? "" : ` for ${target.label}`
    try {
      await symlink(source, target.target)
      if (!quiet) {
        console.log(
          `Linked developer Onyx agent skill${suffix} to ${target.target}`
        )
      }
      installed.push({ target: target.target, linked: true })
      continue
    } catch {
      await writeFile(target.target, await readFile(source, "utf8"), "utf8")
      if (!quiet) {
        console.warn(
          `Copied developer Onyx agent skill${suffix} to ${target.target}; rerun \`onyx developer sync-skill\` after editing the source skill.`
        )
      }
      installed.push({ target: target.target, linked: false })
    }
  }
  return installed
}

export async function displaySkillPath() {
  try {
    await readFile(packagedSkillPath(), "utf8")
    return packagedSkillPath()
  } catch {
    return "embedded:onyx"
  }
}
