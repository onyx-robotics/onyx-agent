import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runAgent } from "./agents"

/** A `claude` first on PATH that runs `body` (sh), and the run options to use it. */
function fakeClaude(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "onyx-agents-"))
  const bin = join(dir, "claude")
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  process.env.PATH = `${dir}:${process.env.PATH}`
  return { prompt: "hi", model: "sonnet", cwd: dir, env: {}, log: join(dir, "agent.log") }
}

test("an agent's turn reports its session, what it said and its cost", async () => {
  const run = fakeClaude(
    `echo '{"session_id":"s1","result":"done","total_cost_usd":0.5,"is_error":false}'`
  )
  const r = await runAgent(run)
  expect(r).toEqual({ session: "s1", text: "done", costUsd: 0.5, ok: true, aborted: false })
})

// the agent's own command (here sleep) outlives it and holds its output open, as a worker's long
// computation would: the turn still ends soon after the stop
test("a stop cuts an agent's turn short, and says it was stopped", async () => {
  const run = fakeClaude("sleep 30")
  const halt = new AbortController()
  const t0 = Date.now()
  setTimeout(() => halt.abort(), 200)
  const r = await runAgent({ ...run, signal: halt.signal })
  expect(Date.now() - t0).toBeLessThan(6_000)
  expect(r.aborted).toBe(true)
  expect(r.ok).toBe(false)
}, 15_000)

test("a turn started after a stop doesn't run", async () => {
  const run = fakeClaude("sleep 30")
  const halt = new AbortController()
  halt.abort()
  const r = await runAgent({ ...run, signal: halt.signal })
  expect(r.aborted).toBe(true)
})
