import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Io } from "../io"
import { run } from "../run"

const ME = {
  org: { id: "o", name: "Acme", slug: "acme" },
  via: "personal_token",
  actor: null,
  role: "member",
  scopes: ["read"],
}

/** `onyx login` over a fetch that answers `me` and records where requests went. */
async function login(argv: string[], env: Record<string, string> = {}) {
  const seen: string[] = []
  const io: Io = {
    stdout: () => {},
    stderr: () => {},
    stdin: async function* () {},
    isTTY: false,
    env: { ONYX_CONFIG: join(mkdtempSync(join(tmpdir(), "onyx-login-")), "config.json"), ...env },
    fetch: (async (input: RequestInfo | URL) => {
      seen.push(String(input instanceof Request ? input.url : input))
      return Response.json(ME)
    }) as typeof fetch,
    prompt: async () => null,
    sleep: async () => {},
  }
  const code = await run(["login", ...argv], io)
  return { code, origins: seen.map((u) => new URL(u).origin) }
}

test("login signs in to Onyx's own server unless --url, ONYX_URL or a profile names another", async () => {
  expect(await login(["--token", "onyx_pat_x"])).toEqual({
    code: 0,
    origins: ["https://app.onyxresearch.ai"],
  })
  expect(await login(["--token", "onyx_pat_x", "--url", "http://localhost:3000"])).toEqual({
    code: 0,
    origins: ["http://localhost:3000"],
  })
  expect(await login(["--token", "onyx_pat_x"], { ONYX_URL: "https://onyx.example.com" })).toEqual({
    code: 0,
    origins: ["https://onyx.example.com"],
  })
})
