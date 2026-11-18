import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { SKILLS } from "../../skills"

import { installSkills } from "./setup"

const SKILLS_DIR = join(import.meta.dir, "../../../skills")

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

describe("onyx setup", () => {
  test("the program carries every file in skills/, as it is", () => {
    const onDisk = files(SKILLS_DIR).map((p) => relative(SKILLS_DIR, p))
    expect(Object.keys(SKILLS).sort()).toEqual(onDisk.sort())
    for (const p of onDisk) expect(SKILLS[p]).toBe(readFileSync(join(SKILLS_DIR, p), "utf8"))
  })

  test("installSkills writes them under a folder, and again over an earlier copy", () => {
    const ALL = [
      "onyx",
      "onyx-research-setup",
      "onyx-research-base",
      "onyx-research-varop",
      "onyx-research-worker",
    ]
    const dir = mkdtempSync(join(tmpdir(), "onyx-skills-"))
    expect(installSkills(dir)).toEqual(ALL)
    expect(installSkills(dir)).toEqual(ALL)
    for (const p of Object.keys(SKILLS)) expect(readFileSync(join(dir, p), "utf8")).toBe(SKILLS[p]!)
  })
})
