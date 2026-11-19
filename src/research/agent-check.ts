/**
 * The coding agents a run's agents can be sessions of, and how to check one's CLI on this machine:
 * installed, and signed in where its CLI can say. `onyx research` checks its config's `agent`, the
 * agent its runs' sessions are of, before it starts.
 */
import { spawnSync } from "node:child_process"

import { DEFAULT_AGENT } from "./agents"

/** A command's exit status and output (stdout and stderr); status null when it couldn't run. */
export type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string }

/** How to check a coding agent's CLI. */
export interface AgentCheck {
  name: string
  install: string
  /** set, any of these means it signs in with an API key: no sign-in to check */
  keyVars: string[]
  /** how to sign in */
  login: string
  /** true or false when its CLI says clearly whether it's signed in; null when it can't tell */
  signedIn?: (run: Exec) => boolean | null
}

export const AGENTS: Record<string, AgentCheck> = {
  claude: {
    name: "Claude Code",
    install: "https://claude.com/claude-code",
    keyVars: ["ANTHROPIC_API_KEY"],
    login: "claude auth login",
    signedIn(run) {
      try {
        const s = JSON.parse(run("claude", ["auth", "status", "--json"]).stdout) as {
          loggedIn?: unknown
        }
        return typeof s.loggedIn === "boolean" ? s.loggedIn : null
      } catch {
        return null
      }
    },
  },
  codex: {
    name: "Codex CLI",
    install: "https://github.com/openai/codex",
    // codex exec reads CODEX_API_KEY; an OPENAI_API_KEY in the environment alone doesn't sign it in
    keyVars: ["CODEX_API_KEY"],
    login: "codex login",
    signedIn(run) {
      const r = run("codex", ["login", "status"])
      if (/not logged in/i.test(r.stdout)) return false
      return r.status === 0 ? true : null
    },
  },
}

export const exec: Exec = (cmd, args) => {
  try {
    // stdin is the user's, so a remote that asks for a passphrase can still ask
    const p = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["inherit", "pipe", "pipe"],
    })
    return { status: p.error ? null : p.status, stdout: `${p.stdout ?? ""}${p.stderr ?? ""}` }
  } catch {
    return { status: null, stdout: "" }
  }
}

/** A coding agent's CLI on this machine: its version line, and what's wrong (null: nothing). */
export function checkAgent(
  agent: string = DEFAULT_AGENT,
  run: Exec = exec,
  env: Record<string, string | undefined> = process.env
): { name: string; version: string | null; problem: string | null } {
  const a = AGENTS[agent] ?? { name: agent, install: "", keyVars: [], login: `${agent}'s login` }
  const v = run(agent, ["--version"])
  if (v.status !== 0)
    return {
      name: a.name,
      version: null,
      problem: `${a.name} isn't installed (the run's agents are ${agent} sessions): install it${a.install ? ` (${a.install})` : ""} and sign in`,
    }
  const version = v.stdout.trim().split("\n")[0] ?? ""
  // only a clear "not signed in" counts: a CLI that can't say lets the run find out
  if (!a.keyVars.some((k) => env[k]) && a.signedIn?.(run) === false)
    return { name: a.name, version, problem: `${a.name} isn't signed in: run ${a.login}` }
  return { name: a.name, version, problem: null }
}
