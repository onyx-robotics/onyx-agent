import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NO_TOOLS, readOnlyTools, runAgent, workerTools } from "./agents"

/** A `claude` first on PATH that runs `body` (sh), and the run options to use it. */
function fakeClaude(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "onyx-agents-"))
  const bin = join(dir, "claude")
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  process.env.PATH = `${dir}:${process.env.PATH}`
  return {
    prompt: "hi",
    model: "sonnet",
    cwd: dir,
    env: {},
    log: join(dir, "agent.log"),
    tools: NO_TOOLS,
  }
}

test("an agent's turn reports its session, what it said, and the commands it had refused", async () => {
  const run = fakeClaude(
    `echo '{"session_id":"s1","result":"done","total_cost_usd":0.5,"is_error":false,"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}]}'`
  )
  const r = await runAgent(run)
  expect(r).toEqual({
    session: "s1",
    text: "done",
    ok: true,
    aborted: false,
    denied: ["git commit -m x"],
  })
})

/** The arguments `claude` was called with, one per line. */
async function argsFor(tools: Parameters<typeof runAgent>[0]["tools"]) {
  const run = fakeClaude(
    `printf '%s\\n' "$@" > "$(dirname "$0")/args"; echo '{"session_id":"s","result":"","is_error":false}'`
  )
  await runAgent({ ...run, tools })
  return readFileSync(join(run.cwd, "args"), "utf8").trimEnd().split("\n")
}

const after = (args: string[], flag: string) => {
  const i = args.indexOf(flag)
  const next = args.findIndex((a, j) => j > i && a.startsWith("--"))
  return args.slice(i + 1, next === -1 ? args.length : next)
}

// a worker edits the code, but its shell runs only onyx research and read-only git: a program, a
// script or a search of its own is refused, so it's an experiment
test("a worker edits code, and runs only onyx research and read-only git", async () => {
  const args = await argsFor(workerTools())
  expect(after(args, "--tools")).toEqual(["Bash", "Read", "Edit", "Write", "Glob", "Grep"])
  expect(after(args, "--allowedTools")).toEqual([
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "Bash(onyx research *)",
    "Bash(git status*)",
    "Bash(git diff*)",
    "Bash(git log*)",
    "Bash(git show*)",
    // helpers that read or print, so `cd x && …`, `… | tail` and `…; echo $?` still pass
    "Bash(cd *)",
    "Bash(ls*)",
    "Bash(cat *)",
    "Bash(head*)",
    "Bash(tail*)",
    "Bash(wc *)",
    "Bash(grep *)",
    "Bash(echo*)",
    "Bash(pwd)",
  ])
  // nothing that runs a program: no python, no interpreter, no wildcard Bash
  expect(after(args, "--allowedTools").some((r) => /python(?! run\.py)|Bash\(\*\)/.test(r))).toBe(
    false
  )
  expect(after(args, "--permission-mode")).toEqual(["dontAsk"])
})

// the base agent and the var-op: no Edit or Write at all, and a shell for only their commands, each
// rule one argument though it has spaces in it
test("a read-only agent can't write, and runs only its own commands", async () => {
  const args = await argsFor(readOnlyTools(["python bench.py --samples 8", "onyx research *"]))
  expect(after(args, "--tools")).toEqual(["Read", "Glob", "Grep", "Bash"])
  expect(after(args, "--allowedTools")).toEqual([
    "Read",
    "Glob",
    "Grep",
    "Bash(python bench.py --samples 8)",
    "Bash(onyx research *)",
  ])
  // acceptEdits would let a shell command that writes a file (a redirect) run unasked
  expect(after(args, "--permission-mode")).toEqual(["dontAsk"])
})

test("a ghost has no tools", async () => {
  const args = await argsFor(NO_TOOLS)
  expect(after(args, "--tools")).toEqual([""])
  expect(args).not.toContain("--allowedTools")
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
