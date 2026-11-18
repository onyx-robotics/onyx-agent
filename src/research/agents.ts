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
  /** what it may use: always stated (workerTools, readOnlyTools, NO_TOOLS) */
  tools: AgentTools
  /** where its output goes, appended */
  log: string
}

/**
 * What an agent may use: the tools it has at all (`--tools`), the rules that let them run
 * (`--allowedTools`), and what happens to anything else (`--permission-mode`). `dontAsk` refuses
 * whatever no rule allows, so a Bash rule like `onyx research *` is the only shell command such an
 * agent can run. (`acceptEdits` would let any shell command that only writes files run too, a
 * redirect included.)
 */
export interface AgentTools {
  tools: string[]
  allow: string[]
  mode: "dontAsk"
}

export interface AgentResult {
  session: string | null
  text: string
  ok: boolean
  /** cut short by `signal`: the turn didn't end, it was stopped */
  aborted: boolean
  /** the shell commands its tool rules refused in this turn */
  denied: string[]
}

/** the coding agent a run's agents are sessions of (preflight.ts knows how to check each one) */
export const AGENT_CLI = "claude"

/** read-only git: what a worker may look at in its worktree's history */
const GIT_READ = ["git status*", "git diff*", "git log*", "git show*"]
/**
 * Shell helpers that read or print and run no program. Agents wrap their commands in them (`cd x
 * && …`, `… | tail -30`, `…; echo $?`): every part of a compound command needs a rule, so without
 * them the quick evaluation itself would be refused. A part that runs a program is still refused.
 */
const SHELL_READ = ["cd *", "ls*", "cat *", "head*", "tail*", "wc *", "grep *", "echo*", "pwd"]

/**
 * A worker: it reads and edits the code, and its shell runs only `onyx research` and read-only git. Anything else is refused: it can't run
 * a program, a script or a search itself, so every computation is an experiment on an endpoint,
 * where the whole run sees it and it holds no worker slot (in one run, workers ran their searches
 * in their own turns for minutes, and none of it reached the run).
 */
export function workerTools(): AgentTools {
  const files = ["Read", "Edit", "Write", "Glob", "Grep"]
  return {
    tools: ["Bash", ...files],
    allow: [...files, ...["onyx research *", ...GIT_READ, ...SHELL_READ].map((c) => `Bash(${c})`)],
    mode: "dontAsk",
  }
}

/**
 * An agent that reads and doesn't write: the codebase to read, and a shell for only these commands
 * (each a Bash rule, `onyx research *` say). The base agent and the var-op are these: they study
 * and plan, and workers do the work, so they can't write files or run anything else.
 */
export function readOnlyTools(commands: string[]): AgentTools {
  const read = ["Read", "Glob", "Grep"]
  return {
    tools: [...read, ...(commands.length ? ["Bash"] : [])],
    allow: [...read, ...commands.map((c) => `Bash(${c})`)],
    mode: "dontAsk",
  }
}

/** No tools: an agent that answers from what it's told (a ghost) */
export const NO_TOOLS: AgentTools = { tools: [], allow: [], mode: "dontAsk" }
/** after an agent exits, how long its output is read for (a command it started may hold it open) */
const OUTPUT_GRACE_MS = 3_000

export async function runAgent(a: AgentRun): Promise<AgentResult> {
  const t = a.tools
  const args = [
    "-p",
    a.prompt,
    "--output-format",
    "json",
    "--model",
    a.model,
    // each rule its own argument: a rule may have spaces in it (`Bash(onyx research *)`)
    "--tools",
    ...(t.tools.length ? t.tools : [""]),
    ...(t.allow.length ? ["--allowedTools", ...t.allow] : []),
    "--permission-mode",
    t.mode,
  ]
  if (a.resume) args.push("--resume", a.resume)
  if (a.resume && a.fork) args.push("--fork-session")
  for (const d of a.addDirs ?? []) args.push("--add-dir", d)
  appendFileSync(
    a.log,
    `\n==== ${new Date().toISOString()} ${a.resume ? (a.fork ? `fork of ${a.resume}` : `resume ${a.resume}`) : "new"}\n${a.prompt}\n----\n`
  )
  const proc = Bun.spawn([AGENT_CLI, ...args], {
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
      is_error?: boolean
      permission_denials?: { tool_input?: { command?: unknown } }[]
    }
    return {
      session: r.session_id ?? null,
      text: r.result ?? "",
      ok: !r.is_error && proc.exitCode === 0,
      aborted,
      denied: (r.permission_denials ?? [])
        .map((d) => d.tool_input?.command)
        .filter((c): c is string => typeof c === "string"),
    }
  } catch {
    return { session: null, text: err || out, ok: false, aborted, denied: [] }
  }
}
