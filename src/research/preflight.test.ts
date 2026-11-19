import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_AGENT } from "./agents"
import { AGENTS } from "./agent-check"
import { problems, type Exec } from "./preflight"

const cfg = { remote: "git@example.com:you/project.git", baseBranch: "main", agent: "claude" }
const SIGNED_IN = { "claude auth": { status: 0, stdout: '{"loggedIn": true}' } }

/** A machine whose commands answer from this table (by "cmd arg"), anything else exit 0. */
function machine(answers: Record<string, { status: number | null; stdout?: string }>): Exec {
  return (cmd, args) => {
    const key = Object.keys(answers).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k))
    const a = key ? answers[key]! : { status: 0 }
    return { status: a.status, stdout: a.stdout ?? "" }
  }
}

describe("research preflight", () => {
  test("it checks the agent the run starts, which it knows how to check", () => {
    expect(AGENTS[DEFAULT_AGENT]).toBeDefined()
  })

  test("a ready machine has no problems", () => {
    expect(problems(cfg, machine(SIGNED_IN), {})).toEqual([])
  })

  test("every problem at once, each with its fix", () => {
    const p = problems(cfg, machine({ git: { status: null }, claude: { status: null } }), {})
    expect(p).toHaveLength(2)
    expect(p[0]).toContain("git isn't installed")
    expect(p[1]).toContain("Claude Code isn't installed")
  })

  for (const [agent, a] of Object.entries(AGENTS))
    test(`${agent}: missing, then installed`, () => {
      const missing = problems({ ...cfg, agent }, machine({ [agent]: { status: null } }), {})
      expect(missing).toEqual([expect.stringContaining(`${a.name} isn't installed`)])
      expect(missing[0]).toContain(a.install)
      expect(problems({ ...cfg, agent }, machine(SIGNED_IN), {})).toEqual([])
    })

  test("a signed-out agent stops it; an API key, or no clear answer, doesn't", () => {
    const claudeOut = machine({ "claude auth": { status: 1, stdout: '{"loggedIn": false}' } })
    expect(problems(cfg, claudeOut, {})).toEqual([
      "Claude Code isn't signed in: run claude auth login",
    ])
    expect(problems(cfg, claudeOut, { ANTHROPIC_API_KEY: "k" })).toEqual([])
    const old = machine({ "claude auth": { status: 1, stdout: "unknown command" } })
    expect(problems(cfg, old, {})).toEqual([])

    const codexOut = machine({ "codex login": { status: 1, stdout: "Not logged in" } })
    expect(problems({ ...cfg, agent: "codex" }, codexOut, {})).toEqual([
      "Codex CLI isn't signed in: run codex login",
    ])
    expect(problems({ ...cfg, agent: "codex" }, codexOut, { OPENAI_API_KEY: "k" })).toEqual([])
    const odd = machine({ "codex login": { status: 2, stdout: "unrecognized subcommand" } })
    expect(problems({ ...cfg, agent: "codex" }, odd, {})).toEqual([])
  })

  test("an agent it has no entry for is still checked for", () => {
    expect(problems({ ...cfg, agent: "amp" }, machine({ amp: { status: null } }), {})[0]).toContain(
      "amp isn't installed"
    )
  })

  test("the remote must have baseBranch, and be readable", () => {
    const missing = problems(cfg, machine({ ...SIGNED_IN, "git ls-remote": { status: 2 } }), {})
    expect(missing[0]).toContain("has no branch main")
    const unreachable = problems(
      cfg,
      machine({ ...SIGNED_IN, "git ls-remote": { status: 128 } }),
      {}
    )
    expect(unreachable[0]).toContain("can't read")
  })

  test("against a real repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "onyx-preflight-"))
    const g = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" })
    g("init", "-q", "-b", "main")
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x")
    const real: Exec = (cmd, args) =>
      cmd === "git"
        ? (({ status, stdout }) => ({ status, stdout }))(spawnSync(cmd, args, { encoding: "utf8" }))
        : { status: 0, stdout: '{"loggedIn": true}' }
    expect(problems({ ...cfg, remote: dir }, real, {})).toEqual([])
    expect(problems({ ...cfg, remote: dir, baseBranch: "dev" }, real, {})[0]).toContain(
      "has no branch dev"
    )
  })
})
