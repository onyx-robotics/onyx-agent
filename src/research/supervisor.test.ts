import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { RunDir } from "./state"
import { plotLink, writeShim } from "./supervisor"

test("agents' onyx is this onyx, for its research commands only", () => {
  // a directory with a quote in it: the shim's command line survives the shell
  const run = new RunDir(join(mkdtempSync(join(tmpdir(), "onyx-it's-")), "run"))
  writeShim(run, [process.execPath, "--no-env-file", join(import.meta.dir, "../cli/main.ts")])
  const env = { ...process.env, PATH: `${run.path("bin")}:${process.env.PATH}` }
  const onyx = (...args: string[]) => {
    const p = Bun.spawnSync(["onyx", ...args], { env, stdout: "pipe", stderr: "pipe" })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }

  const help = onyx("research", "help")
  expect(help.code).toBe(0)
  expect(help.out).toContain("onyx research propose")

  const other = onyx("whoami")
  expect(other.code).toBe(2)
  expect(other.out).toBe("")
  expect(other.err).toContain("only onyx research")
})

test("a run's plot is its campaign's, on the app its key is for, once it's set up", () => {
  const run = new RunDir(join(mkdtempSync(join(tmpdir(), "onyx-plot-")), "run"))
  expect(plotLink(run)).toBeNull()
  run.write("run-key.json", { url: "https://app.example/", token: "k", expiresAt: 0, agentId: "a" })
  expect(plotLink(run)).toBeNull()
  run.write("state.json", { campaign: "01a1e5eb-3b4e-7004-af33-f2325141753f" })
  expect(plotLink(run)).toBe("https://app.example/items/01a1e5eb-3b4e-7004-af33-f2325141753f/plot")
})
