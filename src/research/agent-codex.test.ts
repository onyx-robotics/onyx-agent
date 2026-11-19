import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NO_TOOLS, readOnlyTools, runAgent, workerTools, type AgentRun } from "./agents"
import { READ_NOTE } from "./agent-codex"

/**
 * A `codex` first on PATH: it keeps its arguments, prints `events` (JSONL, as `codex exec --json`
 * does) and, as the gate would, keeps `denied` and counts `allowed` beside the turn's rules.
 */
function fakeCodex(events: object[], gate: { denied?: string[]; allowed?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "onyx-codex-"))
  const bin = join(dir, "codex")
  const rules = join(dir, "agent.log.gate.json")
  const lines = events.map((e) => JSON.stringify(e)).join("\n")
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
${(gate.denied ?? []).map((c) => `echo '${JSON.stringify({ tool: "Bash", command: c })}' >> "${rules}.denied"`).join("\n")}
${Array.from({ length: gate.allowed ?? 0 }, () => `echo 1 >> "${rules}.allowed"`).join("\n")}
cat <<'EOF_EVENTS'
${lines}
EOF_EVENTS
`
  )
  chmodSync(bin, 0o755)
  process.env.PATH = `${dir}:${process.env.PATH}`
  const run: AgentRun = {
    agent: "codex",
    prompt: "hi",
    cwd: dir,
    env: { ONYX_RESEARCH_RUN: "/runs/r" },
    log: join(dir, "agent.log"),
    tools: workerTools(),
  }
  const args = () => readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n")
  return { run, args, rules }
}

/** the args after this one, as the lines the fake wrote (the prompt has newlines of its own) */
const after = (a: string[], arg: string) => a.slice(a.indexOf(arg) + 1).join("\n")

const started = { type: "thread.started", thread_id: "t1" }
const said = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } })
const done = { type: "turn.completed", usage: {} }
const ran = (type: string) => ({ type: "item.completed", item: { type, status: "completed" } })

test("a Codex turn reports its thread, what it said last, and the commands its gate refused", async () => {
  const { run } = fakeCodex(
    [started, said("thinking"), ran("command_execution"), said("done"), done],
    {
      denied: ["python x.py"],
      allowed: 1,
    }
  )
  expect(await runAgent(run)).toEqual({
    session: "t1",
    text: "done",
    ok: true,
    aborted: false,
    denied: ["python x.py"],
  })
})

test("a worker's turn: its gate as the hook, edits only in its directories, no sandbox to keep it from committing", async () => {
  const { run, args, rules } = fakeCodex([started, done])
  await runAgent({ ...run, addDirs: ["/w", "/exp"] })
  const a = args()
  expect(a.slice(0, 2)).toEqual(["exec", "--json"])
  expect(a).toContain("--dangerously-bypass-hook-trust")
  expect(a).toContain(`approval_policy="never"`)
  // Codex's sandbox keeps a worktree's git metadata read only: the gate holds a worker instead
  expect(a).toContain(`sandbox_mode="danger-full-access"`)
  expect(a.join(" ")).not.toContain("writable_roots")
  const hook = a.find((x) => x.startsWith("hooks.PreToolUse="))!
  expect(hook).toContain(`'research' 'gate' '${rules}'`)
  // the rules it's held to are the agent's own, and where it may edit, where it works first
  expect(JSON.parse(readFileSync(rules, "utf8"))).toEqual({
    ...workerTools(),
    writable: [run.cwd, "/w", "/exp"],
  })
  // no model: the user's Codex default; the prompt last, after --
  expect(a).not.toContain("-m")
  expect(after(a, "--")).toBe(`${READ_NOTE}\n\nhi`)
})

test("a fork and a resume of a session, by id, on the config's model", async () => {
  const { run, args } = fakeCodex([started, done])
  await runAgent({ ...run, resume: "base", fork: true, model: "gpt-x" })
  expect(after(args(), "fork")).toBe(`base\n--\n${READ_NOTE}\n\nhi`)
  expect(args()).toContain("gpt-x")
  await runAgent({ ...run, resume: "w1" })
  expect(after(args(), "resume")).toBe(`w1\n--\n${READ_NOTE}\n\nhi`)
})

test("a ghost has no shell and can't write; a read-only agent keeps the network for onyx research", async () => {
  const { run, args } = fakeCodex([started, done])
  await runAgent({ ...run, tools: NO_TOOLS })
  expect(args()).toContain(`sandbox_mode="read-only"`)
  // nothing to read with: told nothing about reading
  expect(args().at(-1)).toBe("hi")
  expect(args().join(" ")).toContain("--disable shell_tool --disable unified_exec")
  await runAgent({ ...run, tools: readOnlyTools(["onyx research *"]) })
  expect(args()).toContain(`sandbox_mode="workspace-write"`)
  expect(args()).toContain("sandbox_workspace_write.network_access=true")
  expect(args()).toContain(`sandbox_workspace_write.writable_roots=["/runs/r"]`)
  expect(args()).not.toContain("shell_tool")
})

test("a failed turn says why", async () => {
  const { run } = fakeCodex([
    started,
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "turn.failed", error: { message: "401 Unauthorized" } },
  ])
  const r = await runAgent(run)
  expect([r.session, r.ok, r.text]).toEqual(["t1", false, "401 Unauthorized"])
})

// a hook Codex didn't run would let anything through: a turn where more ran than the gate let
// through isn't trusted
test("a turn whose commands didn't all pass the gate fails", async () => {
  const { run } = fakeCodex(
    [started, ran("command_execution"), ran("file_change"), said("done"), done],
    {
      allowed: 1,
    }
  )
  const r = await runAgent(run)
  expect(r.ok).toBe(false)
  expect(r.text).toContain("Codex didn't run its hook")
})

test("an earlier turn's refusals aren't this one's", async () => {
  const { run, rules } = fakeCodex([started, done])
  writeFileSync(`${rules}.denied`, '{"command":"old"}\n')
  expect((await runAgent(run)).denied).toEqual([])
})
