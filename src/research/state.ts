/**
 * A run's directory on the user's machine (`<repo>/.onyx-research/<run>/`): the supervisor's state,
 * and a folder per worker that its tool calls write to. Everything the platform needs is on the
 * platform; this is what lets the supervisor pick up where it was after a restart.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface WorkerState {
  /** the worker's id: the var-op's worker_task, its first turn */
  task: string
  attempt: number
  hypothesis: string
  /** the hypothesis's title, for its later turns' jobs */
  title?: string
  /** the worker's ai_agent entity */
  agent: string
  session: string | null
  worktree: string
  branch: string
  baseCommit: string
  /**
   * running: a turn of its session runs in a slot; waiting: on experiments, holding no slot;
   * queued: its experiments have ended and its next turn is a job in line for a slot; done: reported
   */
  phase: "starting" | "running" | "waiting" | "queued" | "done"
  /**
   * Each turn is a worker_task job, holding its slot only while the turn runs (docs/research.md,
   * "Worker turns"): the job of the turn running now, or of the one queued. The first is `task`.
   */
  turnJob?: string | null
  /** turns started so far */
  turns?: number
  /** a queued turn's first message, and whether its job has reached the platform */
  nextPrompt?: string
  submitted?: boolean
  /** experiments it has submitted that haven't been shown to it yet */
  pending: string[]
  experiments: string[]
  nudges: number
  /** what it was first told: a worker interrupted before its first turn ended starts from it again */
  prompt?: string
  costUsd: number
}

export interface ExperimentResult {
  id: string
  task: string
  endpoint: string
  commit: string
  status: string | null
  outcome: string | null
  metrics: Record<string, number>
  logTail: string
  /** a site's experiment: where its files were downloaded to, and their paths in it */
  filesDir?: string
  files?: string[]
  endedAt: number
}

export interface RunState {
  campaign: string
  /** the supervisor's own agent (its API key's) */
  supervisor: string
  base: { agent: string; session: string | null; costUsd: number }
  varop: { agent: string; session: string | null; lastWake: number; costUsd: number; wakes: number }
  startedAt: number
  deadline: number
  workers: Record<string, WorkerState>
  results: Record<string, ExperimentResult>
  /** tasks that ended since the var-op last looked */
  unseen: string[]
  /** what workers said at the end of a turn (mid-hypothesis), since the var-op last looked */
  turnNotes?: { task: string; turn: number; text: string }[]
  /**
   * The runner's journal: every job it holds (docs/jobs.md, "The runner's protocol"). Kept here
   * so a supervisor that restarts says it still holds them, and carries them on, rather than
   * the platform finding them lost.
   */
  held?: Record<string, HeldJob>
}

export interface HeldJob {
  attempt: number
  kind: "task" | "experiment"
  /** the unit it occupies: a worker slot (worker-1 …) or an endpoint's type */
  unit: string
  /** a task that's a worker's later turn: the worker it continues (a first turn is its own id) */
  worker?: string
  /** an experiment's props as assigned (its commit and branch), to run it again */
  props?: Record<string, unknown>
  /** its end, reported and not yet acknowledged: sent again after a restart */
  report?: Record<string, unknown>
}

export class RunDir {
  constructor(readonly dir: string) {
    for (const d of ["", "workers", "inbox", "bin", "checkouts", "worktrees", "logs", "ghosts"])
      mkdirSync(join(dir, d), { recursive: true })
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts)
  }

  workerDir(task: string) {
    const d = this.path("workers", task)
    mkdirSync(d, { recursive: true })
    return d
  }

  read<T>(file: string): T | null {
    const p = this.path(file)
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null
  }

  /** written whole, then renamed: a reader never sees half a file */
  write(file: string, value: unknown) {
    const p = this.path(file)
    writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 2))
    renameSync(`${p}.tmp`, p)
  }

  state(): RunState {
    const s = this.read<RunState>("state.json")
    if (!s) throw new Error(`no run in ${this.dir}: run setup first`)
    return s
  }
}

/** A run directory named by the environment (agents' tool calls) */
export function runFromEnv(): RunDir {
  const dir = process.env.ONYX_RESEARCH_RUN
  if (!dir) throw new Error("ONYX_RESEARCH_RUN isn't set: this command runs inside a research run")
  return new RunDir(dir)
}
