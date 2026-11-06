/**
 * Agents are Claude Code sessions run headless (`claude -p`), with the user's own `claude` login.
 * Every agent but the base is a fork of the base agent's session, so it starts knowing the
 * codebase; a session is resumed by id to carry on (a worker after its experiments end, the
 * var-op when it's woken). Linux and macOS.
 */
import { appendFileSync } from "node:fs"

export interface AgentRun {
  prompt: string
  model: string
  cwd: string
  env: Record<string, string>
  /** carry on this session */
  resume?: string
  /** as a new session, branched from `resume` (that one is left as it was) */
  fork?: boolean
  addDirs?: string[]
  timeoutMs?: number
  /** cuts the turn short, as the timeout would (a supervisor stopping) */
  signal?: AbortSignal
  /** where its output goes, appended */
  log: string
}

export interface AgentResult {
  session: string | null
  text: string
  costUsd: number
  ok: boolean
  /** cut short by `signal`: the turn didn't end, it was stopped */
  aborted: boolean
}

/** the tools an agent has: the codebase, a shell (its own commands and onyx research), nothing else */
const TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]
/** after an agent exits, how long its output is read for (a command it started may hold it open) */
const OUTPUT_GRACE_MS = 3_000

export async function runAgent(a: AgentRun): Promise<AgentResult> {
  const args = [
    "-p",
    a.prompt,
    "--output-format",
    "json",
    "--model",
    a.model,
    "--allowedTools",
    TOOLS.join(" "),
    "--permission-mode",
    "acceptEdits",
  ]
  if (a.resume) args.push("--resume", a.resume)
  if (a.resume && a.fork) args.push("--fork-session")
  for (const d of a.addDirs ?? []) args.push("--add-dir", d)
  appendFileSync(
    a.log,
    `\n==== ${new Date().toISOString()} ${a.resume ? (a.fork ? `fork of ${a.resume}` : `resume ${a.resume}`) : "new"}\n${a.prompt}\n----\n`
  )
  const proc = Bun.spawn(["claude", ...args], {
    cwd: a.cwd,
    env: { ...process.env, ...a.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = a.timeoutMs ? setTimeout(() => proc.kill(), a.timeoutMs) : null
  const stop = () => proc.kill()
  if (a.signal?.aborted) stop()
  else a.signal?.addEventListener("abort", stop, { once: true })
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  // a command the agent started may outlive it and hold its output open: once the agent has
  // exited, what it wrote is there, so don't wait on the command for more
  const [out, err] = await Promise.race([
    output,
    new Promise<[string, string]>((done) => setTimeout(() => done(["", ""]), OUTPUT_GRACE_MS)),
  ])
  if (timer) clearTimeout(timer)
  a.signal?.removeEventListener("abort", stop)
  const aborted = a.signal?.aborted ?? false
  appendFileSync(a.log, `${out}\n${err ? `stderr: ${err}\n` : ""}`)
  try {
    const r = JSON.parse(out) as {
      session_id?: string
      result?: string
      total_cost_usd?: number
      is_error?: boolean
    }
    return {
      session: r.session_id ?? null,
      text: r.result ?? "",
      costUsd: r.total_cost_usd ?? 0,
      ok: !r.is_error && proc.exitCode === 0,
      aborted,
    }
  } catch {
    return { session: null, text: err || out, costUsd: 0, ok: false, aborted }
  }
}
