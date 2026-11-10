/**
 * A greedy baseline to compare runs against: one agent, one change at a time. Each change is
 * measured on the run's first endpoint, as an experiment is, and kept only if it beats the best
 * so far on the first metric by `--margin` (3%); otherwise the code goes back to the best. Same
 * model, same tools and the same base agent as the run, so what differs is the search.
 *
 *   onyx research greedy <config> [--minutes 15] [--margin 0.03]
 *
 * It runs locally, without the platform: its log and its best commit are in
 * `.onyx-research/<run>/greedy/`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { runAgent, workerTools } from "./agents"
import { loadConfig } from "./config"
import { addWorktree, commitAndPush, ensureClone, git, resolveCommit } from "./git"
import { preflight } from "./preflight"
import { runDirFor } from "./supervisor"

export async function runGreedy(cfgPath: string, argv: string[]) {
  const { values: o } = parseArgs({
    args: argv,
    options: { minutes: { type: "string" }, margin: { type: "string" } },
  })
  const cfg = loadConfig(cfgPath)
  preflight(cfg)
  const run = runDirFor(cfg)
  const state = run.state()
  if (!state.base.session) throw new Error("no base agent yet: run setup first")
  const minutes = Number(o.minutes ?? cfg.minutes)
  const margin = Number(o.margin ?? 0.03)
  const metric = cfg.metrics[0]!
  const ep = cfg.endpoints[0]!
  if (ep.site) throw new Error(`greedy runs its endpoint's driver itself; ${ep.type} is a site's`)
  const better = (a: number, b: number) =>
    metric.better === "higher" ? a > b * (1 + margin) : a < b * (1 - margin)

  const dir = run.path("greedy")
  mkdirSync(dir, { recursive: true })
  const repo = run.path("repo")
  ensureClone(cfg.remote, repo)
  const base = resolveCommit(repo, cfg.baseBranch)
  const worktree = join(dir, "work")
  const branch = `greedy/${Date.now()}`
  addWorktree(repo, worktree, branch, base)
  const log = (msg: string) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`
    console.log(line)
    appendFileSync(join(dir, "greedy.log"), `${line}\n`)
  }

  /** the endpoint's driver on the worktree as it is: its metrics and its log's end */
  const measure = async () => {
    const p = Bun.spawn(["sh", "-c", `${ep.driver} 2>&1`], { cwd: worktree, stdout: "pipe" })
    const timer = setTimeout(() => p.kill(), ep.timeoutS * 1000)
    const out = await new Response(p.stdout).text()
    await p.exited
    clearTimeout(timer)
    const line = out
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("METRICS "))
    const metrics = line ? (JSON.parse(line.slice(8)) as Record<string, number>) : {}
    return { ok: p.exitCode === 0 && metric.key in metrics, metrics, tail: out.slice(-4000) }
  }

  const ref = await measure()
  let best = { commit: base, value: ref.ok ? ref.metrics[metric.key]! : NaN }
  log(`start at ${base.slice(0, 10)}: ${metric.key}=${best.value}`)
  // the clock starts once the reference is measured, as a run's starts after setup
  const deadline = Date.now() + minutes * 60_000
  const history: Record<string, unknown>[] = []
  let session: string | null = null
  let prompt = `You are now running a greedy search on this repository, on your own. Your worktree is ${worktree}, your working directory: work only there, and edit only: ${cfg.editable.join(", ")}.

Each turn, make ONE change you expect to improve ${metric.key} (${metric.better} is better). Run the quick evaluation, exactly as written, from your working directory (\`${cfg.evaluate}\`), and fix what it reports, then end your turn. Your change is then measured on the endpoint (${ep.label}): it's kept if it beats the best so far by ${margin * 100}%, otherwise the code goes back to the best version. You'll be told which, and asked for the next change.

The best so far: ${metric.key}=${best.value}.`
  let n = 0
  while (Date.now() < deadline) {
    const r = await runAgent({
      prompt,
      model: cfg.models.worker,
      cwd: worktree,
      env: {},
      resume: session ?? state.base.session,
      fork: !session,
      addDirs: [worktree],
      log: join(dir, "agent.log"),
      // a run's worker's tools: its change is measured by the endpoint, not by itself
      tools: workerTools(cfg.evaluate),
      // a change in progress at the deadline is still measured, as a run lets its workers finish
      timeoutMs: Math.max(60_000, deadline - Date.now()) + 15 * 60_000,
    })
    session = r.session ?? session
    n++
    const commit = commitAndPush(worktree, branch, `greedy change ${n}`)
    const m = await measure()
    const value = m.metrics[metric.key]
    const keep =
      m.ok && value !== undefined && (Number.isNaN(best.value) || better(value, best.value))
    history.push({ n, commit, ok: m.ok, metrics: m.metrics, kept: keep, at: Date.now() })
    if (keep) best = { commit, value: value! }
    else git(worktree, "reset", "--quiet", "--hard", best.commit)
    log(
      `change ${n} at ${commit.slice(0, 10)}: ${m.ok ? `${metric.key}=${value}` : "invalid"} -> ${keep ? "kept" : "reverted"}`
    )
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify({ minutes, margin, metric: metric.key, best, changes: n, history }, null, 2)
    )
    prompt = `${m.ok ? `Measured: ${JSON.stringify(m.metrics)}.` : "Your change was invalid on the endpoint."} ${keep ? "Kept" : "Reverted: the code is back to the best version"}. Best so far: ${metric.key}=${best.value}.\nThe end of its log:\n${m.tail}\n\nMake your next change.`
  }
  log(`done: ${n} changes, best ${metric.key}=${best.value} at ${best.commit}`)
  // the best commit stays reachable on the remote for scoring
  git(worktree, "push", "--quiet", "--force", "origin", `${best.commit}:refs/heads/${branch}-best`)
}
