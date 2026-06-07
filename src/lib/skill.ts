import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { ONYX_SKILL_MARKDOWN } from "./skill-content"

export const ONYX_SKILL_NAME = "onyx"

export function defaultSkillInstallRoot() {
  return join(homedir(), ".onyx", "skills")
}

export function packagedSkillPath() {
  return fileURLToPath(new URL("../../skills/onyx/SKILL.md", import.meta.url))
}

async function readPackagedSkill() {
  try {
    return await readFile(packagedSkillPath(), "utf8")
  } catch {
    return ONYX_SKILL_MARKDOWN
  }
}

export async function installOnyxSkill({
  dir,
  quiet = false,
}: {
  dir?: string
  quiet?: boolean
} = {}) {
  const root = dir ?? defaultSkillInstallRoot()
  const target = join(root, ONYX_SKILL_NAME, "SKILL.md")
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, await readPackagedSkill(), "utf8")
  if (!quiet) {
    console.log(`Installed Onyx agent skill to ${target}`)
  }
  return target
}

export async function displaySkillPath() {
  try {
    await readFile(packagedSkillPath(), "utf8")
    return packagedSkillPath()
  } catch {
    return "embedded:onyx"
  }
}
