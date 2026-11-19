/**
 * Agents are sessions of a coding agent's CLI run headless, with the user's own login to it
 * (agent-claude.ts says how for Claude Code). Every agent but the base is a fork of the base
 * agent's session, so it starts knowing the codebase; a session is resumed by id to carry on (a
 * worker after its experiments end, the var-op when it's woken). Linux and macOS.
 */
import { appendFileSync } from "node:fs"

import { claude } from "./agent-claude"

export interface AgentRun {
  /** the CLI it's a session of (AGENT_CLIS: a config's `agent`) */
  agent: string
  prompt: string
  /** unset: the CLI's own default */
  model?: string
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

/** the coding agent a run's agents are sessions of when its config doesn't say (agent-check.ts knows how to check each one) */
export const DEFAULT_AGENT = "claude"

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

/**
 * One turn of a coding agent's CLI: the command for it, and what its output says. runAgent runs
 * it, and stops, times out and logs it the same for every CLI.
 */
export interface AgentCli {
  /** whose models it runs, for the agents' items in the graph */
  provider: string
  /** each role's model when the config doesn't say; a role it leaves out gets the CLI's default */
  models: Partial<Record<AgentModelRole, string>>
  turn(a: AgentRun): AgentTurn
}

/** the agents whose models a config can set (`models`) */
export type AgentModelRole = "base" | "varop" | "worker" | "ghost"

export interface AgentTurn {
  argv: string[]
  /** what the turn said: its session, its last message, whether it ended well, what was refused */
  result(out: string, err: string, exitCode: number | null): Omit<AgentResult, "aborted">
}

/** the CLIs a run's agents can be sessions of, by command */
export const AGENT_CLIS: Record<string, AgentCli> = { claude }

export async function runAgent(a: AgentRun): Promise<AgentResult> {
  const cli = AGENT_CLIS[a.agent]
  if (!cli)
    throw new Error(`no coding agent ${a.agent}: one of ${Object.keys(AGENT_CLIS).join(", ")}`)
  const turn = cli.turn(a)
  appendFileSync(
    a.log,
    `\n==== ${new Date().toISOString()} ${a.resume ? (a.fork ? `fork of ${a.resume}` : `resume ${a.resume}`) : "new"}\n${a.prompt}\n----\n`
  )
  const proc = Bun.spawn(turn.argv, {
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
  return { ...turn.result(out, err, proc.exitCode), aborted }
}
