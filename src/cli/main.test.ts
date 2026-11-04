/**
 * The onyx command as its own process (main.ts), what `run` in process can't show: off a terminal
 * it prints JSON and exits with the code that says what happened, and a .env where it runs can't
 * send a profile's token to another server. Two stub servers stand in for Onyx: no app, no database.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeConfig } from "./config"

/** the package's root */
const ROOT = join(import.meta.dir, "../..")
const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { scripts: { onyx: string } }
/** `bun run onyx` (package.json): its command line, run from somewhere else */
const ONYX = pkg.scripts.onyx
  .split(" ")
  .map((a, i) => (i === 0 ? process.execPath : a.endsWith(".ts") ? join(ROOT, a) : a))
/** a bun that loads the .env where it runs */
const BARE = [process.execPath, join(import.meta.dir, "main.ts")]

const TOKEN = "onyx_pat_main_test"
const ME = { org: { slug: "acme" }, via: "personal_token", role: "member" }

/** A server that records what reaches it. */
function stub(answer: (req: Request) => Response) {
  const seen: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push(req.headers.get("authorization"))
      return answer(req)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, server }
}

// the profile's server knows its token; the other is where a .env would send it
const own = stub((req) =>
  req.headers.get("authorization") === `Bearer ${TOKEN}`
    ? Response.json(ME)
    : Response.json({ error: { code: "unauthorized", message: "who?" } }, { status: 401 })
)
const elsewhere = stub(() => Response.json(ME))

afterAll(() => {
  own.server.stop(true)
  elsewhere.server.stop(true)
})

/** the environment without ONYX_* (only what a test gives counts) */
const clean = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("ONYX_"))
)

async function onyx(argv: string[], cwd: string, config: string) {
  const p = Bun.spawn(argv, {
    cwd,
    env: { ...clean, ONYX_CONFIG: config },
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

test("off a terminal: JSON and exit codes; a .env where it runs can't redirect a profile's token", async () => {
  const signedOut = mkdtempSync(join(tmpdir(), "onyx-main-"))
  const repo = mkdtempSync(join(tmpdir(), "onyx-main-"))
  writeFileSync(join(repo, ".env"), `ONYX_URL=${elsewhere.url}\n`)
  const config = join(repo, "config.json")
  writeConfig(config, {
    current: "acme",
    profiles: {
      acme: { url: own.url, token: TOKEN, org: { id: "o", name: "Acme", slug: "acme" } },
    },
  })
  const [none, ignored, loaded] = await Promise.all([
    onyx([...ONYX, "whoami"], signedOut, join(signedOut, "config.json")),
    // as `bun run onyx` runs it: the .env isn't read
    onyx([...ONYX, "whoami"], repo, config),
    // read, its ONYX_URL alone is refused before any request
    onyx([...BARE, "whoami"], repo, config),
  ])

  expect(none.code).toBe(4)
  expect(none.out).toBe("")
  expect(JSON.parse(none.err)).toMatchObject({ error: { code: "unauthorized" } })

  expect(ignored.code).toBe(0)
  expect(JSON.parse(ignored.out)).toEqual(ME)

  expect(loaded.code).toBe(2)
  expect(loaded.out).toBe("")
  expect(JSON.parse(loaded.err).error.message).toContain("isn't the profile's server")
  // the token went to its own server only
  expect(own.seen).toEqual([`Bearer ${TOKEN}`])
  expect(elsewhere.seen).toEqual([])
})
