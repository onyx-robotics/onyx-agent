/**
 * Checks a smoke run (setup.sh) after it ends: what went wrong, as findings the nightly's triage
 * turns into issues (.github/workflows/nightly-research.yml). A `hard` finding is a bug by itself
 * (a command failed, nothing was measured); a `soft` one is something odd in the logs, for the
 * triage agent to judge. Each has a fingerprint that stays the same night to night, so an issue
 * already open for it isn't opened again.
 *
 *   bun scripts/smoke-check.ts <config> <out dir> setup=<exit> run=<exit> [log=<supervisor log>]
 *
 * Writes <out dir>/findings.json and <out dir>/summary.md; exits 1 when any finding is hard.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { loadConfig } from "../src/research/config"
import type { RunState } from "../src/research/state"
import { runDirFor } from "../src/research/supervisor"

export interface Finding {
  severity: "hard" | "soft"
  fingerprint: string
  title: string
  detail: string
}

/** a log line with its ids, numbers and times taken out: the same problem reads the same */
export const normalize = (line: string) =>
  line
    .replace(/^\d\d:\d\d:\d\d\s+/, "")
    .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)

/** supervisor lines that say something went wrong (supervisor.ts's this.log) */
const TROUBLE =
  /failed: |rejected|couldn't|^sync: |renewing the run key|closing the queue|the last sync|queueing its next turn: |cancelling queued turns|board\.json: |Error|error:|Traceback|panic|unhandled/i

/** what the run's own experiments fail with on purpose: an agent's code being wrong isn't onyx's bug */
const EXPECTED = /^experiment \S+ failed \{/

const tail = (s: string, n = 3000) => (s.length > n ? `…${s.slice(-n)}` : s)

export function check(opts: {
  agent: string
  setupExit: number
  runExit: number
  log: string
  state: RunState | null
  agentLogs: Record<string, string>
}): Finding[] {
  const { agent, setupExit, runExit, log, state } = opts
  const out: Finding[] = []
  const hard = (key: string, title: string, detail: string) =>
    out.push({ severity: "hard", fingerprint: `${agent}:${key}`, title, detail })
  const soft = (key: string, title: string, detail: string) =>
    out.push({ severity: "soft", fingerprint: `${agent}:${key}`, title, detail })

  if (setupExit !== 0) {
    hard(
      "setup-failed",
      `onyx research setup exits ${setupExit} (${agent})`,
      `The base agent's setup failed. Its output:\n\n${tail(log)}`
    )
    return out
  }
  if (runExit === 124)
    hard(
      "run-hung",
      `onyx research run doesn't stop after its minutes are up (${agent})`,
      `The run outlived CI's limit and was killed. The end of its output:\n\n${tail(log)}`
    )
  else if (runExit !== 0)
    hard(
      "run-failed",
      `onyx research run exits ${runExit} (${agent})`,
      `The end of its output:\n\n${tail(log)}`
    )
  if (!state) {
    hard("no-state", `the run left no state.json (${agent})`, tail(log))
    return out
  }

  const workers = Object.values(state.workers ?? {})
  const results = Object.values(state.results ?? {})
  if (!workers.length)
    hard(
      "no-workers",
      `the var-op never started a worker (${agent})`,
      `varop.log's end:\n\n${tail(opts.agentLogs["logs/varop.log"] ?? "(no varop.log)")}`
    )
  else if (!results.length)
    hard(
      "no-experiments",
      `no worker's experiment reached the bench (${agent})`,
      workers
        .map(
          (w) =>
            `- worker ${w.task}: ${w.phase}, ${w.ended?.outcome ?? "not ended"} ${w.ended?.reason ?? ""}`
        )
        .join("\n")
    )
  else if (!results.some((r) => r.status === "succeeded" && Object.keys(r.metrics).length))
    hard(
      "no-measurement",
      `no experiment came back with metrics (${agent})`,
      results.map((r) => `- ${r.id}: ${r.status}\n\n${tail(r.logTail ?? "", 600)}`).join("\n")
    )

  const notDone = workers.filter((w) => w.phase !== "done")
  if (notDone.length && runExit === 0)
    hard(
      "worker-left-running",
      `the run ended with workers not done (${agent})`,
      notDone.map((w) => `- worker ${w.task}: ${w.phase}`).join("\n")
    )

  for (const w of workers) {
    const reason = w.ended?.reason ?? ""
    if (/didn't run its hook/.test(reason))
      hard("gate-bypassed", `Codex ran tool calls the gate never saw (${agent})`, reason)
    else if (w.ended && w.ended.outcome !== "succeeded" && reason)
      soft(
        `worker-ended:${normalize(reason).slice(0, 60)}`,
        `a worker ended ${w.ended.outcome} (${agent})`,
        reason
      )
    for (const c of w.denied ?? [])
      soft(
        `denied:${normalize(c).split(" ").slice(0, 3).join(" ")}`,
        `the gate refused a worker's command (${agent})`,
        `\`${c}\``
      )
  }
  for (const c of state.varop?.refused ?? [])
    soft(
      `varop-denied:${normalize(c).split(" ").slice(0, 3).join(" ")}`,
      `the gate refused a var-op command (${agent})`,
      `\`${c}\``
    )

  const seen = new Set<string>()
  for (const line of log.split("\n")) {
    const l = line.trim().replace(/^\d\d:\d\d:\d\d\s+/, "")
    if (!TROUBLE.test(l) || EXPECTED.test(l)) continue
    const key = normalize(l)
    if (seen.has(key)) continue
    seen.add(key)
    soft(`log:${key.slice(0, 80)}`, `the supervisor logged trouble (${agent})`, l)
  }
  for (const [path, text] of Object.entries(opts.agentLogs)) {
    const errs = [...text.matchAll(/^stderr: (.+)$/gm)].map((m) => m[1]!).filter((e) => e.trim())
    for (const e of new Set(errs.map(normalize)))
      soft(
        `stderr:${path.replace(/workers\/[^/]+/, "workers/<task>")}:${e.slice(0, 60)}`,
        `an agent's CLI wrote to stderr (${agent}, ${path})`,
        e
      )
  }
  return out
}

function agentLogs(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const read = (rel: string) => {
    const p = join(dir, rel)
    if (existsSync(p)) out[rel] = readFileSync(p, "utf8")
  }
  read("logs/base.log")
  read("logs/varop.log")
  const workers = join(dir, "workers")
  if (existsSync(workers))
    for (const t of readdirSync(workers)) read(join("workers", t, "agent.log"))
  return out
}

if (import.meta.main) {
  const [cfgPath, outDir, ...rest] = process.argv.slice(2)
  if (!cfgPath || !outDir) {
    console.error(
      "usage: bun scripts/smoke-check.ts <config> <out dir> setup=<exit> run=<exit> [log=<file>]"
    )
    process.exit(2)
  }
  const arg = (k: string) => rest.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1)
  const cfg = loadConfig(cfgPath)
  const run = runDirFor(cfg)
  const logPath = arg("log")
  const findings = check({
    agent: cfg.agent,
    setupExit: Number(arg("setup") ?? 0),
    runExit: Number(arg("run") ?? 0),
    log: logPath && existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
    state: existsSync(run.path("state.json")) ? run.read<RunState>("state.json") : null,
    agentLogs: agentLogs(run.dir),
  })
  const state = existsSync(run.path("state.json")) ? run.read<RunState>("state.json") : null
  const results = Object.values(state?.results ?? {})
  const best = Math.max(0, ...results.map((r) => r.metrics["smoke.speedup"] ?? 0))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, "findings.json"),
    JSON.stringify({ agent: cfg.agent, runDir: run.dir, findings }, null, 2)
  )
  const summary = [
    `### ${cfg.agent}: ${findings.some((f) => f.severity === "hard") ? "❌" : "✅"} ${cfg.name}`,
    "",
    `${Object.keys(state?.workers ?? {}).length} workers, ${results.length} experiments (${results.filter((r) => r.status === "succeeded").length} succeeded), best speedup ${best.toFixed(2)}x`,
    "",
    ...(findings.length
      ? findings.map((f) => `- **${f.severity}** \`${f.fingerprint}\`: ${f.title}`)
      : ["No findings."]),
    "",
  ].join("\n")
  writeFileSync(join(outDir, "summary.md"), summary)
  console.log(summary)
  process.exit(findings.some((f) => f.severity === "hard") ? 1 : 0)
}
