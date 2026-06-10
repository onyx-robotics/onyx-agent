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

export function defaultSkillInstallRoot() {
  return join(homedir(), ".claude", "skills")
}

export function skillInstallTarget(root = defaultSkillInstallRoot()) {
  return join(root, ONYX_SKILL_NAME, "SKILL.md")
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

export async function installOnyxSkill({
  dir,
  quiet = false,
}: {
  dir?: string
  quiet?: boolean
} = {}) {
  const root = dir ?? defaultSkillInstallRoot()
  const target = skillInstallTarget(root)
  await mkdir(dirname(target), { recursive: true })
  await replaceSkillTarget(target)
  await writeFile(target, await readPackagedSkill(), "utf8")
  if (!quiet) {
    console.log(`Installed Onyx agent skill to ${target}`)
  }
  return target
}

export async function installReleaseSkill({
  dir,
  quiet = false,
}: {
  dir?: string
  quiet?: boolean
} = {}) {
  const target = skillInstallTarget(dir)
  await mkdir(dirname(target), { recursive: true })
  await replaceSkillTarget(target)
  await writeFile(target, await readPackagedSkill(), "utf8")
  if (!quiet) {
    console.log(`Installed release Onyx agent skill to ${target}`)
  }
  return target
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
  const target = skillInstallTarget(dir)
  await mkdir(dirname(target), { recursive: true })
  await replaceSkillTarget(target)
  try {
    await symlink(source, target)
    if (!quiet) {
      console.log(`Linked developer Onyx agent skill to ${target}`)
    }
    return { target, linked: true }
  } catch {
    await writeFile(target, await readFile(source, "utf8"), "utf8")
    if (!quiet) {
      console.warn(
        `Copied developer Onyx agent skill to ${target}; rerun \`onyx developer sync-skill\` after editing the source skill.`
      )
    }
    return { target, linked: false }
  }
}

export async function displaySkillPath() {
  try {
    await readFile(packagedSkillPath(), "utf8")
    return packagedSkillPath()
  } catch {
    return "embedded:onyx"
  }
}
