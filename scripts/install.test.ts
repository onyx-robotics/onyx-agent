/**
 * The one-line installer (install.sh) against releases laid out by release-assets.ts and served
 * the way GitHub serves them: `<repo>/latest` redirects to the newest release's page,
 * `<repo>/tag/<tag>`, and its assets are at `<repo>/download/<tag>/<asset>`. The binary is a
 * stand-in for this machine's, a script that prints its version. Each install has its own HOME.
 */
import { afterAll, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { releaseAssets, SKILLS } from "./release-assets"

const ROOT = join(import.meta.dir, "..")
const TEMP = mkdtempSync(join(tmpdir(), "onyx-install-"))

/** a release as release.yml attaches it, with a stand-in binary for this machine */
function release(version: string) {
  const dist = mkdtempSync(join(TEMP, "release-"))
  const bin = join(dist, `onyx-${process.platform}-${process.arch}`)
  writeFileSync(bin, `#!/bin/sh\necho "onyx ${version}"\n`)
  chmodSync(bin, 0o755)
  releaseAssets(dist)
  return dist
}

// the binary's checksum, changed: SHA256SUMS no longer names the binary served
const tampered = release("0.2.2")
const sums = join(tampered, "SHA256SUMS")
writeFileSync(
  sums,
  readFileSync(sums, "utf8").replace(/^[0-9a-f]{64}(?= {2}onyx-)/m, "0".repeat(64))
)

/** each repository's releases by tag, the latest first */
const repos: Record<string, Record<string, string>> = {
  onyx: { "v0.2.2": release("0.2.2"), "v0.2.1": release("0.2.1") },
  tampered: { "v0.2.2": tampered },
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url)
    const [, repo = "", page = "", tag = "", asset = ""] = url.pathname.split("/")
    const tags = repos[repo] ?? {}
    const latest = Object.keys(tags)[0]
    if (page === "latest" && latest) return Response.redirect(`${url.origin}/${repo}/tag/${latest}`)
    const dist = tags[tag]
    if (page === "tag" && dist) return new Response("the release's page")
    if (page === "download" && dist && existsSync(join(dist, asset)))
      return new Response(Bun.file(join(dist, asset)))
    return new Response("Not Found", { status: 404 })
  },
})

afterAll(() => {
  server.stop(true)
  rmSync(TEMP, { recursive: true, force: true })
})

/** `sh install.sh` from `repo`'s releases, in `home` (its ~/.local/bin on the PATH) */
async function install(home: string, repo: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(["sh", join(ROOT, "scripts/install.sh")], {
    cwd: home,
    env: {
      HOME: home,
      PATH: `${join(home, ".local/bin")}:${process.env.PATH}`,
      TMPDIR: tmpdir(),
      ONYX_RELEASES_URL: `http://127.0.0.1:${server.port}/${repo}`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}

/** what the installed onyx prints */
async function installed(home: string) {
  const p = Bun.spawn([join(home, ".local/bin/onyx")], { stdout: "pipe" })
  return (await new Response(p.stdout).text()).trim()
}

const newHome = () => mkdtempSync(join(TEMP, "home-"))

test("installs the latest release's onyx, and its skills beside the skills already there", async () => {
  const home = newHome()
  const skills = join(home, ".claude/skills")
  mkdirSync(join(skills, "mine"), { recursive: true })
  writeFileSync(join(skills, "mine/SKILL.md"), "my own\n")

  const r = await install(home, "onyx")

  expect(r.code).toBe(0)
  expect(await installed(home)).toBe("onyx 0.2.2")
  expect(readdirSync(skills).sort()).toEqual(["mine", ...SKILLS].sort())
  for (const s of SKILLS)
    expect(readFileSync(join(skills, s, "SKILL.md"), "utf8")).toBe(
      readFileSync(join(ROOT, "skills", s, "SKILL.md"), "utf8")
    )
  expect(readFileSync(join(skills, "mine/SKILL.md"), "utf8")).toBe("my own\n")
})

test("a binary that doesn't match SHA256SUMS installs nothing", async () => {
  const home = newHome()

  const r = await install(home, "tampered")

  expect(r.code).not.toBe(0)
  expect(r.err).toContain("doesn't match its checksum")
  expect(existsSync(join(home, ".local"))).toBe(false)
  expect(existsSync(join(home, ".claude"))).toBe(false)
})

test("ONYX_VERSION installs that release, not the latest", async () => {
  const home = newHome()

  const r = await install(home, "onyx", { ONYX_VERSION: "0.2.1" })

  expect(r.code).toBe(0)
  expect(await installed(home)).toBe("onyx 0.2.1")
})
