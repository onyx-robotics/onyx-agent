/**
 * What `onyx research setup`, `run` and `greedy` need from this machine, checked before they
 * start: git, the coding agent the run's agents are sessions of (installed and signed in), and
 * `baseBranch` on the remote. Every problem at once, each with its fix, instead of an agent or a
 * clone failing minutes in.
 */
import { checkAgent, exec, type Exec } from "./agent-check"
import type { ResearchConfig } from "./config"

export type { Exec } from "./agent-check"

/** What's missing, as sentences that say how to fix it; empty when all's well. */
export function problems(
  cfg: Pick<ResearchConfig, "remote" | "baseBranch" | "agent">,
  run: Exec = exec,
  env: Record<string, string | undefined> = process.env
): string[] {
  const out: string[] = []
  const hasGit = run("git", ["--version"]).status === 0
  if (!hasGit) out.push("git isn't installed: install it")

  const a = checkAgent(cfg.agent, run, env)
  if (a.problem) out.push(a.problem)

  if (hasGit) {
    const r = run("git", ["ls-remote", "--exit-code", "--heads", cfg.remote, cfg.baseBranch])
    if (r.status === 2)
      out.push(
        `${cfg.remote} has no branch ${cfg.baseBranch} (baseBranch): commit and push it (git push -u ${cfg.remote} ${cfg.baseBranch})`
      )
    else if (r.status !== 0)
      out.push(`can't read ${cfg.remote} (remote): check the URL and that git can reach it`)
  }
  return out
}

/** Throw if this machine isn't ready for a run on this config. */
export function preflight(cfg: Pick<ResearchConfig, "remote" | "baseBranch" | "agent">) {
  const p = problems(cfg)
  if (p.length) throw new Error(`not ready to run:\n${p.map((s) => `  - ${s}`).join("\n")}`)
}
