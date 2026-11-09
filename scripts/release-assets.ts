/**
 * What a GitHub release carries beside the onyx binaries, written into dist/ after
 * `bun run compile -- --all` (release.yml does both):
 *
 *   bun scripts/release-assets.ts
 *
 * - skills.tar.gz: skills/, each skill's folder at the top (onyx/, onyx-research-setup/), so it
 *   unpacks straight into a skills directory such as ~/.claude/skills
 * - install.sh: the one-line installer (scripts/install.sh), which installs the others from the
 *   same release
 * - SHA256SUMS: every asset's checksum, the binaries' too, as sha256sum writes them
 */
import { createHash } from "node:crypto"
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

/** the skills' folders, as skills.tar.gz holds them */
export const SKILLS = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex")

/** Writes skills.tar.gz, install.sh and SHA256SUMS into `dist`, beside its binaries (onyx-*). */
export function releaseAssets(dist: string): string[] {
  const binaries = readdirSync(dist).filter((f) => f.startsWith("onyx-"))
  if (binaries.length === 0)
    throw new Error(`no binaries (onyx-*) in ${dist}: run bun run compile -- --all first`)

  // the files alone: no extended attributes, nor macOS's ._ files for them
  const tar = Bun.spawnSync(
    [
      "tar",
      "--no-xattrs",
      "-czf",
      join(dist, "skills.tar.gz"),
      "-C",
      join(ROOT, "skills"),
      ...SKILLS,
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stderr: "pipe" }
  )
  if (tar.exitCode !== 0) throw new Error(`tar couldn't pack the skills: ${tar.stderr}`)
  copyFileSync(join(ROOT, "scripts/install.sh"), join(dist, "install.sh"))

  const assets = [...binaries, "skills.tar.gz", "install.sh"].sort()
  writeFileSync(
    join(dist, "SHA256SUMS"),
    assets.map((f) => `${sha256(join(dist, f))}  ${f}\n`).join("")
  )
  return [...assets, "SHA256SUMS"]
}

if (import.meta.main) for (const f of releaseAssets(join(ROOT, "dist"))) console.log(`dist/${f}`)
