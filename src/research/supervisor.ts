/**
 * The supervisor (docs/research.md, "The runtime"): plain code on the user's machine. It sets a
 * run up (the base agent studies the repository), then is two runners in one (docs/jobs.md): one
 * offering worker slots, which forks a worker for each worker_task it's given, and one offering
 * the project's endpoints, which runs experiments. Between them it wakes the var-op and resumes
 * workers whose experiments have ended.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname, join, normalize } from "node:path"

import type { RunnerAssignment } from "../generated/contracts/contracts"
import type { OnyxClient } from "../sdk"

import { runAgent } from "./agents"
import { loadConfig, type LoadedConfig } from "./config"
import { addWorktree, checkout, ensureClone, resolveCommit } from "./git"
import { agentItem, client, RENEW_EVERY_MS, renewRunKey, upsert } from "./platform"
import { basePrompt, varopPrompt, workerPrompt } from "./prompts"
import {
  RunDir,
  type ExperimentResult,
  type HeldJob,
  type RunState,
  type WorkerState,
} from "./state"
import { relatedText, type Board } from "./tools"

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
const short = (id: string) => id.slice(-8)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** a worker's turn, and the var-op's, end after this long whatever they're doing */
const TURN_MS = 45 * 60_000
/** after the deadline, what's running gets this long to finish */
const GRACE_MS = 15 * 60_000
/** the var-op is woken at least this often while the run proposes */
const VAROP_TICK_MS = 10 * 60_000
const LOG_TAIL = 6_000
/** how often a site's experiments are looked up, and how many looks an end gets for its metrics */
const SITE_POLL_MS = 3_000
const SITE_METRIC_LOOKS = 5
/** a site's experiment's files are downloaded for its worker up to these sizes (bytes) */
const SITE_FILE_MAX = 20 * 1024 * 1024
const SITE_FILES_MAX = 100 * 1024 * 1024
/** the log a site's driver keeps beside a job's own files */
const SITE_LOG = "_onyx/driver.log"

export function runDirFor(cfg: LoadedConfig) {
  return new RunDir(join(cfg.root, ".onyx-research", slug(cfg.name)))
}

function agentEnv(
  run: RunDir,
  cfg: LoadedConfig,
  agent: string,
  task?: string
): Record<string, string> {
  return {
    ONYX_RESEARCH_RUN: run.dir,
    ONYX_RESEARCH_CONFIG: cfg.path,
    ONYX_AGENT: agent,
    ...(task ? { ONYX_TASK: task } : {}),
    PATH: `${run.path("bin")}:${process.env.PATH}`,
  }
}

/** This same onyx, to run again: the binary itself, or bun with its entry point (and no .env). */
function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, "--no-env-file", Bun.main]
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * Agents call `onyx research …` from their shells: the `onyx` first on their PATH runs this same
 * onyx, and only its research commands, so what they do is by the run's key. Written whenever a
 * supervisor starts, so it follows the onyx that runs it.
 */
export function writeShim(run: RunDir, self = selfCommand()) {
  const bin = run.path("bin", "onyx")
  const refuse = `echo "in a research run, onyx runs only onyx research <command> (onyx research help)" >&2; exit 2`
  writeFileSync(
    bin,
    `#!/bin/sh\n[ "$1" = research ] || { ${refuse}; }\nexec ${self.map(shellQuote).join(" ")} "$@"\n`
  )
  chmodSync(bin, 0o755)
}

// ---------------------------------------------------------------- setup

export async function setup(cfgPath: string) {
  const cfg = loadConfig(cfgPath)
  const run = runDirFor(cfg)
  // the run's key, for everything it does (docs/auth.md, "Run keys"): its jobs are its own
  await renewRunKey(run.dir, slug(cfg.name))
  const onyx = client(run.dir)
  const repo = run.path("repo")
  ensureClone(cfg.remote, repo)
  writeShim(run)

  const me = await onyx.me()
  const campaign = await upsert(onyx, `run:${slug(cfg.name)}`, {
    type: "campaign",
    name: cfg.name,
    summary: cfg.goal.slice(0, 4000),
    status: "active",
  })
  const base = await upsert(
    onyx,
    `agent:${slug(cfg.name)}:base`,
    agentItem(cfg.name, "base agent", "base", cfg.models.base)
  )
  const varop = await upsert(
    onyx,
    `agent:${slug(cfg.name)}:varop`,
    agentItem(cfg.name, "variational operator", "var_op", cfg.models.varop)
  )
  const prior = run.read<RunState>("state.json")
  const state: RunState = prior ?? {
    campaign,
    supervisor: me.actor?.id ?? "",
    base: { agent: base, session: null, costUsd: 0 },
    varop: { agent: varop, session: null, lastWake: 0, costUsd: 0, wakes: 0 },
    startedAt: 0,
    deadline: 0,
    workers: {},
    results: {},
    unseen: [],
  }
  run.write("state.json", state)

  console.log(`base agent (${cfg.models.base}) is studying ${cfg.root} ...`)
  const r = await runAgent({
    prompt: basePrompt(cfg),
    model: cfg.models.base,
    cwd: repo,
    env: agentEnv(run, cfg, base),
    log: run.path("logs", "base.log"),
    timeoutMs: TURN_MS,
  })
  if (!r.ok || !r.session) throw new Error(`the base agent failed: ${r.text.slice(0, 1000)}`)
  state.base.session = r.session
  state.base.costUsd += r.costUsd
  run.write("state.json", state)
  writeFileSync(run.path("base-summary.md"), r.text)
  console.log(
    `${r.text}\n\nbase session ${r.session} ($${r.costUsd.toFixed(2)}). Start the run: onyx research run ${cfgPath}`
  )
}

// ---------------------------------------------------------------- the run

export class Supervisor {
  private state: RunState
  /** the SDK with the run's current key (renewed in the run's directory) */
  private get onyx(): OnyxClient {
    return client(this.run.dir)
  }
  private readonly repo: string
  private readonly journal = new Map<string, HeldJob>()
  private outbox: Record<string, unknown>[] = []
  private readonly running = new Map<string, number>()
  /** worker slots in use: slot -> the task whose turn runs in it. A worker waiting on its
   * experiments holds none: its slot goes to the next task, and it takes one again to resume */
  private readonly slots = new Map<string, string>()
  /** tasks waiting for a slot for their turn: workers with results first, then new tasks, each
   * in the order they asked */
  private readonly line: { task: string; first: boolean }[] = []
  private varopBusy = false
  private stopping = false
  private readonly instance = `research-${hostname()}`

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly run: RunDir
  ) {
    this.state = run.state()
    this.repo = run.path("repo")
  }

  private save() {
    this.state.held = Object.fromEntries(this.journal)
    this.run.write("state.json", this.state)
  }

  /** A job taken: in the journal, its unit busy, on disk before anything runs. */
  private hold(id: string, h: HeldJob) {
    this.journal.set(id, h)
    this.running.set(h.unit, (this.running.get(h.unit) ?? 0) + 1)
    this.save()
  }

  /** A job let go once its end is acknowledged (its unit was freed when it ended). */
  private release(id: string) {
    if (!this.journal.delete(id)) return
    this.save()
  }

  /**
   * After a restart: the jobs it held are held again (its first sync says so, so none is found
   * lost), and each carries on. A worker that had finished reports its end; one waiting on
   * experiments waits; one that was working resumes its session, or starts its first turn again
   * if it never finished one. An experiment runs again from its commit.
   */
  private async resume() {
    let held = this.state.held
    if (!held) {
      // a run from before the journal was kept: its unfinished workers are what it held
      const open = Object.values(this.state.workers).filter((w) => w.phase !== "done")
      held = Object.fromEntries(
        open.map((w, i) => [
          w.task,
          { attempt: w.attempt, kind: "task" as const, unit: `worker-${i + 1}` },
        ])
      )
    }
    const all = Object.entries(held)
    if (!all.length) return
    this.log(`resuming: ${all.length} jobs held when it stopped`)
    // ended, with the end unacknowledged: only the report goes again
    for (const [id, h] of all.filter(([, h]) => h.report)) {
      this.journal.set(id, h)
      this.outbox.push(h.report!)
    }
    const entries = all.filter(([, h]) => !h.report)
    for (const [id, h] of entries) this.hold(id, h)
    for (const [id, h] of entries) {
      const carry =
        h.kind === "experiment"
          ? this.runExperiment({ id, unit: h.unit, props: h.props ?? {} })
          : this.resumeWorker(id)
      void carry.catch((e: Error) => {
        this.log(`${h.kind} ${short(id)} couldn't resume: ${e.message}`)
        this.end(id, "failed", {
          failure: "infra",
          reason: `couldn't resume: ${e.message}`.slice(0, 900),
        })
      })
    }
  }

  private async resumeWorker(task: string) {
    const w = this.state.workers[task]
    if (!w) throw new Error("it was taken but never set up")
    if (existsSync(join(this.run.workerDir(task), "finished.json")))
      return this.endTask(task, "succeeded")
    if (this.pendingOf(task).length) {
      w.phase = "waiting"
      this.save()
      return
    }
    this.log(`worker ${short(task)} resumes`)
    if (w.session)
      return this.workerTurn(
        task,
        "The run was interrupted and has restarted. Carry on where you left off: check your worktree's state, then continue (submit an experiment, or record your insights and finish)."
      )
    return this.workerTurn(task, w.prompt ?? (await this.firstPrompt(w)), true)
  }

  /** A worker's first message, from its hypothesis as the graph has it. */
  private async firstPrompt(w: WorkerState, why?: string): Promise<string> {
    const h = (await this.onyx.getEntity(w.hypothesis)) as {
      name?: string
      summary?: string | null
    }
    const title = h.name ?? w.hypothesis
    const [related, cited] = await Promise.all([
      relatedText(this.onyx, {
        q: `${title}\n${h.summary ?? ""}`,
        types: ["note"],
        limit: 6,
      }).catch(() => ""),
      relatedText(this.onyx, { item: w.hypothesis, types: ["note"], limit: 6 }).catch(() => ""),
    ])
    return workerPrompt(this.cfg, {
      hypothesis: title,
      why: why ?? h.summary ?? "",
      baseCommit: w.baseCommit,
      worktree: w.worktree,
      cited,
      related,
    })
  }

  /** The run key, renewed well before it runs out (a failed renewal is tried again next time). */
  private async keyLoop() {
    let next = Date.now() + RENEW_EVERY_MS
    while (!this.done()) {
      if (Date.now() >= next) {
        next = Date.now() + RENEW_EVERY_MS
        await renewRunKey(this.run.dir, slug(this.cfg.name)).catch((e: Error) =>
          this.log(`renewing the run key: ${e.message}`)
        )
      }
      await sleep(5000)
    }
  }

  private log(msg: string) {
    console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`)
  }

  async start() {
    if (!this.state.base.session) throw new Error("no base agent yet: run setup first")
    if (!this.state.startedAt) {
      this.state.startedAt = Date.now()
      this.state.deadline = Date.now() + this.cfg.minutes * 60_000
      this.save()
    }
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (this.stopping = true))
    writeShim(this.run)
    // a fresh run key (the same run's agent and runner as before a restart), then renewed hourly
    await renewRunKey(this.run.dir, slug(this.cfg.name))
    await this.resume()
    this.log(
      `run "${this.cfg.name}": ${this.cfg.workers} workers, proposing until ${new Date(this.state.deadline).toISOString().slice(11, 19)}`
    )
    await Promise.all([
      this.runnerLoop(),
      this.varopLoop(),
      this.waitingLoop(),
      this.siteLoop(),
      this.keyLoop(),
    ])
    const cost =
      this.state.base.costUsd +
      this.state.varop.costUsd +
      Object.values(this.state.workers).reduce((s, w) => s + w.costUsd, 0)
    this.log(`stopped. Agents cost $${cost.toFixed(2)}.`)
  }

  // ------------------------------------------------------------ runner

  private slotKeys() {
    return Array.from({ length: this.cfg.workers }, (_, i) => `worker-${i + 1}`)
  }

  /**
   * Each worker slot is a unit of its own (worker-1 …), so a task's slot shows where it started.
   * A slot is free while no worker's turn runs in it, so a worker waiting on an experiment
   * doesn't keep one; a slot a waiting worker will resume in isn't offered.
   */
  private units(): { key: string; type: string; name: string; capacity: number; free: number }[] {
    const busy = (k: string) => this.running.get(k) ?? 0
    const open = this.slotKeys().filter((k) => !this.slots.has(k))
    const offered = new Set(
      this.past() ? [] : open.slice(0, Math.max(0, open.length - this.line.length))
    )
    return [
      ...this.slotKeys().map((key, i) => ({
        key,
        type: "agent_worker",
        name: `${hostname()} worker ${i + 1}`,
        capacity: 1,
        free: offered.has(key) ? 1 : 0,
      })),
      // a site's endpoints are the site's to offer
      ...this.cfg.endpoints
        .filter((e) => !e.site)
        .map((e) => ({
          key: e.type,
          type: e.type,
          name: `${hostname()} ${e.label}`,
          capacity: e.capacity,
          free: Math.max(0, e.capacity - busy(e.type)),
        })),
    ]
  }

  private past() {
    return Date.now() > this.state.deadline
  }

  private done() {
    const active = Object.values(this.state.workers).some((w) => w.phase !== "done")
    return (
      (this.past() && !active && !this.journal.size) ||
      Date.now() > this.state.deadline + GRACE_MS ||
      this.stopping
    )
  }

  /** At the deadline: what's still queued won't run in this run. */
  private async closeQueue() {
    const b = this.run.read<Board>("board.json") ?? { tracks: [], hypotheses: [] }
    const queued = b.hypotheses.filter((h) => !this.state.workers[h.task]).map((h) => h.task)
    if (queued.length) await this.onyx.cancelJobs(queued, "the run's time was up")
    this.log(
      `proposing is over: ${queued.length} queued hypotheses cancelled; letting what's running finish`
    )
  }

  private async runnerLoop() {
    let closed = false
    while (!this.done()) {
      let wait = 1000
      if (this.past() && !closed) {
        closed = true
        await this.closeQueue().catch((e: Error) => this.log(`closing the queue: ${e.message}`))
      }
      // what's sent leaves the outbox now: a job that ends while the sync is out reports in the
      // next one (sharing the array, its report was dropped unsent and the job counted as lost)
      const sent = this.outbox
      this.outbox = []
      try {
        const res = await this.onyx.runnerSync({
          instance: this.instance,
          version: "research-0.1",
          units: this.units(),
          held: this.heldList(),
          reports: sent,
        })
        for (const r of res.rejected) this.log(`report rejected: ${r.reason}`)
        // acknowledged: the ends it sent are the platform's now
        for (const r of sent) if (r.state === "ended") this.release(String(r.id))
        for (const id of [...res.stale, ...res.cancel]) {
          // a queued task the var-op withdrew, or one gone elsewhere: nothing of ours runs it yet
          if (this.journal.get(id)?.kind === "task" && !this.state.workers[id])
            this.end(id, "cancelled")
        }
        for (const a of res.assign) {
          if (this.journal.has(a.id)) continue
          const kind = a.type === "worker_task" ? "task" : "experiment"
          this.hold(a.id, {
            attempt: a.attempt,
            kind,
            unit: a.unit,
            ...(kind === "experiment" ? { props: a.props } : {}),
          })
          // a task has its slot from now: setting its worker up takes seconds, and a slot still
          // offered meanwhile would be given a second task (and the platform would show both there)
          if (kind === "task") this.slots.set(a.unit, a.id)
          const work = kind === "task" ? this.startWorker(a) : this.runExperiment(a)
          void work.catch((e: Error) => {
            if (this.slots.get(a.unit) === a.id) this.slots.delete(a.unit)
            this.log(`${kind} ${short(a.id)} failed: ${e.message}`)
            this.end(a.id, "failed", { failure: "infra", reason: e.message.slice(0, 900) })
          })
        }
        wait = res.assign.length || sent.length ? 200 : Math.min(res.nextInMs, 2000)
      } catch (e) {
        // not acknowledged: sent again, ahead of what's come since
        this.outbox = [...sent, ...this.outbox]
        this.log(`sync: ${(e as Error).message}`)
      }
      await sleep(wait)
    }
    // anything still held: say what happened to it
    if (this.outbox.length)
      await this.onyx
        .runnerSync({
          instance: this.instance,
          units: this.units(),
          held: this.heldList(),
          reports: this.outbox,
        })
        .catch(() => undefined)
  }

  /**
   * Report a job's end and free its unit. It stays in the journal, with its report, until a sync
   * acknowledges it: a restart in between sends the report again rather than losing the job.
   */
  private end(id: string, outcome: string, extra: Record<string, unknown> = {}) {
    const h = this.journal.get(id)
    if (!h || h.report) return
    h.report = {
      id,
      attempt: h.attempt,
      state: "ended",
      outcome,
      at: new Date().toISOString(),
      ...extra,
    }
    this.outbox.push(h.report)
    this.running.set(h.unit, Math.max(0, (this.running.get(h.unit) ?? 1) - 1))
    this.save()
  }

  /** What it holds, as a sync says it: the jobs whose end isn't acknowledged yet aren't held. */
  private heldList() {
    return [...this.journal.entries()]
      .filter(([, h]) => !h.report)
      .map(([id, h]) => ({ id, attempt: h.attempt }))
  }

  private started(id: string) {
    const h = this.journal.get(id)
    if (h)
      this.outbox.push({ id, attempt: h.attempt, state: "started", at: new Date().toISOString() })
  }

  // ------------------------------------------------------------ workers

  private async startWorker(a: RunnerAssignment) {
    this.started(a.id)
    const task = a.id
    const hypothesis = String(a.props.hypothesis)
    const h = (await this.onyx.getEntity(hypothesis)) as { name?: string; summary?: string | null }
    ensureClone(this.cfg.remote, this.repo)
    let baseCommit: string
    try {
      baseCommit = resolveCommit(this.repo, String(a.props.base_commit ?? this.cfg.baseBranch))
    } catch {
      baseCommit = resolveCommit(this.repo, this.cfg.baseBranch)
    }
    const agent = await upsert(
      this.onyx,
      `agent:${slug(this.cfg.name)}:worker:${task}`,
      agentItem(this.cfg.name, `worker ${short(task)}`, "worker", this.cfg.models.worker)
    )
    await this.onyx
      .ingest({ edges: [{ rel: "performed_by", src: task, dst: agent }] })
      .catch(() => undefined)
    const branch = `research/${slug(this.cfg.name)}/${short(task)}`
    const worktree = this.run.path("worktrees", short(task))
    addWorktree(this.repo, worktree, branch, baseCommit)
    this.run.workerDir(task)
    await this.onyx.setStatus(hypothesis, "active").catch(() => undefined)
    const w: WorkerState = {
      task,
      attempt: a.attempt,
      hypothesis,
      agent,
      session: null,
      worktree,
      branch,
      baseCommit,
      phase: "running",
      pending: [],
      experiments: [],
      nudges: 0,
      costUsd: 0,
    }
    this.state.workers[task] = w
    this.save()
    w.prompt = await this.firstPrompt(w, h.summary ?? a.summary ?? undefined)
    this.save()
    this.log(`worker ${short(task)} starts: ${h.name ?? a.name}`)
    await this.workerTurn(task, w.prompt, true, a.unit)
  }

  /**
   * A slot for one turn of a task's worker: a new task's is the one it was assigned (held for it
   * since); a worker under way takes the first free one. A worker already under way (back with its results, nudged, or carrying on after a
   * restart) goes ahead of every new task in line; and units() offers no slot to the queue while
   * anyone is in line, so new tasks never take a slot a worker with results is waiting for.
   */
  private async takeSlot(task: string, first: boolean, prefer?: string): Promise<string> {
    // a new task's slot was its own from when it was assigned
    if (prefer && this.slots.get(prefer) === task) return prefer
    const at = first ? this.line.findIndex((e) => !e.first) : -1
    this.line.splice(at < 0 ? this.line.length : at, 0, { task, first })
    for (;;) {
      if (this.line[0]?.task === task) {
        const open = this.slotKeys().filter((k) => !this.slots.has(k))
        const slot = prefer && open.includes(prefer) ? prefer : open[0]
        if (slot) {
          this.line.shift()
          this.slots.set(slot, task)
          return slot
        }
      }
      await sleep(500)
    }
  }

  private async workerTurn(task: string, prompt: string, fork = false, prefer?: string) {
    const w = this.state.workers[task]!
    w.phase = "running"
    this.save()
    // a new worker is a fork of the base agent; any other turn is a worker under way
    const slot = await this.takeSlot(task, !fork, prefer)
    let r: Awaited<ReturnType<typeof runAgent>>
    try {
      r = await runAgent({
        prompt,
        model: this.cfg.models.worker,
        cwd: w.worktree,
        env: agentEnv(this.run, this.cfg, w.agent, task),
        resume: fork ? this.state.base.session! : w.session!,
        fork,
        addDirs: [w.worktree, this.experimentsDir(task)],
        log: join(this.run.workerDir(task), "agent.log"),
        timeoutMs: TURN_MS,
      })
    } finally {
      this.slots.delete(slot)
    }
    if (r.session) w.session = r.session
    w.costUsd += r.costUsd
    this.save()
    await this.afterTurn(task, r.ok ? null : r.text)
  }

  /** where a worker's site experiments' files are downloaded, one folder per experiment */
  private experimentsDir(task: string) {
    const dir = join(this.run.workerDir(task), "experiments")
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private pendingOf(task: string): string[] {
    return this.run.read<string[]>(`workers/${task}/pending.json`) ?? []
  }

  private async afterTurn(task: string, error: string | null) {
    const w = this.state.workers[task]!
    if (existsSync(join(this.run.workerDir(task), "finished.json")))
      return this.endTask(task, "succeeded")
    if (this.pendingOf(task).length) {
      w.phase = "waiting"
      this.save()
      this.log(`worker ${short(task)} waits on its experiment; its slot is free`)
      return
    }
    if (w.nudges < 2 && w.session) {
      w.nudges++
      return this.workerTurn(
        task,
        `You ended your turn without an experiment in flight and without finishing${error ? ` (${error.slice(0, 300)})` : ""}. If you have something to test, submit it with \`onyx research experiment\`. If you're done, record your insights (\`onyx research insight\`) and \`onyx research finish --state <file>\`.`
      )
    }
    return this.endTask(task, "failed", {
      failure: "job",
      reason: "the worker stopped without finishing",
    })
  }

  private endTask(task: string, outcome: string, extra: Record<string, unknown> = {}) {
    const w = this.state.workers[task]!
    w.phase = "done"
    this.state.unseen.push(task)
    this.save()
    this.end(task, outcome, extra)
    this.log(
      `worker ${short(task)} ${outcome} after ${w.experiments.length} experiments ($${w.costUsd.toFixed(2)})`
    )
  }

  /** Workers waiting on experiments: resumed once all of theirs have ended. */
  private async waitingLoop() {
    while (!this.done()) {
      for (const w of Object.values(this.state.workers)) {
        if (w.phase !== "waiting") continue
        const pending = this.pendingOf(w.task)
        if (!pending.every((id) => this.state.results[id])) continue
        w.pending = []
        w.experiments.push(...pending)
        this.run.write(`workers/${w.task}/pending.json`, [])
        const left = this.cfg.experimentsPerTask - w.experiments.length
        const digest = pending.map((id) => this.describe(this.state.results[id]!)).join("\n\n")
        const next = this.past()
          ? "The run's time is up: record your insights and finish now."
          : left > 0
            ? `You have ${left} experiment${left === 1 ? "" : "s"} left for this hypothesis. Iterate, or record your insights and finish.`
            : "You're out of experiments: record your insights and finish."
        void this.workerTurn(
          w.task,
          `Your experiment${pending.length === 1 ? " has" : "s have"} ended.\n\n${digest}\n\n${next}`
        ).catch((e: Error) => this.log(`worker ${short(w.task)}: ${e.message}`))
      }
      await sleep(2000)
    }
  }

  private describe(r: ExperimentResult): string {
    const m = Object.entries(r.metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")
    const files = r.filesDir
      ? r.files?.length
        ? `\nIts files (its log is ${SITE_LOG}), downloaded to ${r.filesDir}:\n${r.files.map((f) => `- ${f}`).join("\n")}`
        : `\nIt left no files.`
      : ""
    return `Experiment ${r.id} at ${r.commit.slice(0, 10)} on ${r.endpoint}: ${r.outcome}${m ? `; ${m}` : ""}.${files}\nLog (its end):\n${r.logTail}`
  }

  // ------------------------------------------------------------ endpoints

  private async runExperiment(a: Pick<RunnerAssignment, "id" | "unit" | "props">) {
    this.started(a.id)
    const ep = this.cfg.endpoints.find((e) => e.type === a.unit)
    if (!ep) throw new Error(`no endpoint ${a.unit}`)
    const commit = String(a.props.git_sha)
    const branch = String(a.props.branch)
    const dir = this.run.path("checkouts", short(a.id))
    checkout(this.cfg.remote, dir, branch, commit)
    const logPath = this.run.path("logs", `${a.id}.log`)
    const cmd = `${ep.driver}${a.props.packet ? ` ${JSON.stringify(String(a.props.packet))}` : ""}`
    this.log(`experiment ${short(a.id)} on ${ep.type} at ${commit.slice(0, 10)}`)
    const proc = Bun.spawn(["sh", "-c", `${cmd} 2>&1`], { cwd: dir, stdout: "pipe" })
    const timer = setTimeout(() => proc.kill(), ep.timeoutS * 1000)
    const out = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)
    writeFileSync(logPath, out)
    rmSync(dir, { recursive: true, force: true })
    const line = out
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("METRICS "))
    let measured: Record<string, unknown> = {}
    try {
      measured = line ? (JSON.parse(line.slice("METRICS ".length)) as Record<string, unknown>) : {}
    } catch {
      measured = {}
    }
    const declared = new Set(this.cfg.metrics.map((m) => m.key))
    const metrics: Record<string, number> = {}
    const other: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(measured))
      if (declared.has(k) && typeof v === "number" && Number.isFinite(v)) metrics[k] = v
      else other[k] = v
    const ok = proc.exitCode === 0 && Object.keys(metrics).length > 0
    const tail = out.slice(-LOG_TAIL)
    const task =
      Object.values(this.state.workers).find((w) => this.pendingOf(w.task).includes(a.id))?.task ??
      ""
    this.state.results[a.id] = {
      id: a.id,
      task,
      endpoint: ep.type,
      commit,
      status: ok ? "succeeded" : "failed",
      outcome: ok ? "succeeded" : "failed",
      metrics,
      logTail: tail,
      endedAt: Date.now(),
    }
    this.save()
    this.end(a.id, ok ? "succeeded" : "failed", {
      ...(ok
        ? {}
        : {
            failure: "job",
            reason:
              proc.exitCode === 0
                ? "the driver reported no metrics"
                : `the driver exited ${proc.exitCode}`,
          }),
      props: {
        log_tail: tail.slice(-8000),
        ...(Object.keys(other).length ? { measured: JSON.stringify(other).slice(0, 4000) } : {}),
      },
      ...(Object.keys(metrics).length ? { metrics: [{ values: metrics }] } : {}),
      refs: [
        { system: "file", locator: `file://${hostname()}${logPath}`, mediaType: "text/plain" },
      ],
    })
    this.log(`experiment ${short(a.id)} ${ok ? "succeeded" : "failed"} ${JSON.stringify(metrics)}`)
  }

  /**
   * Experiments a site runs (an endpoint with `site`) end on the site, so their results come from
   * the platform: each pending one is looked up until it has ended and its record has its metrics.
   * Experiments this supervisor runs itself are in its journal, and record their own results.
   */
  private async siteLoop() {
    if (!this.cfg.endpoints.some((e) => e.site)) return
    const seen = new Map<string, number>() // ended, but its record not yet complete: looks so far
    while (!this.done()) {
      for (const w of Object.values(this.state.workers)) {
        if (w.phase === "done") continue
        for (const id of this.pendingOf(w.task)) {
          if (this.state.results[id] || this.journal.has(id)) continue
          await this.siteResult(id, w.task, seen).catch((e: Error) =>
            this.log(`experiment ${short(id)}: ${e.message}`)
          )
        }
      }
      await sleep(SITE_POLL_MS)
    }
  }

  private async siteResult(id: string, task: string, seen: Map<string, number>) {
    const job = (await this.onyx.getJob(id)) as {
      state: string
      outcome: string | null
      failure: string | null
      reason: string | null
    }
    if (job.state !== "ended") return
    const item = (await this.onyx.getEntity(id)) as {
      props: Record<string, unknown>
      metrics: { property: string; value: number }[]
    }
    const props = item.props ?? {}
    // what the site reported goes back to the worker: its metrics, and, from a driver that sends
    // them as props, numbers the registry doesn't declare (`results`) and its log's end
    // (`log_tail`); and its files, downloaded from the site for the worker to read, its log among them
    const metrics: Record<string, number> = {}
    const results = props.results
    if (results && typeof results === "object")
      for (const [k, v] of Object.entries(results))
        if (typeof v === "number" && Number.isFinite(v)) metrics[k] = v
    for (const m of item.metrics ?? []) metrics[m.property] = m.value
    const ok = job.outcome === "succeeded"
    // the end can be visible a moment before the fold records its results: look again a few times
    const looks = (seen.get(id) ?? 0) + 1
    seen.set(id, looks)
    const listed = await this.onyx.jobFiles(id).catch((e: Error) => {
      this.log(`experiment ${short(id)}: its files: ${e.message}`)
      return { files: [] }
    })
    if (
      ok &&
      !Object.keys(metrics).length &&
      !props.log_tail &&
      !listed.files.length &&
      looks < SITE_METRIC_LOOKS
    )
      return
    seen.delete(id)
    const why = ok ? "" : `${job.failure ?? "failed"}: ${job.reason ?? "no reason given"}`
    const filesDir = join(this.experimentsDir(task), short(id))
    const files = await this.download(id, listed.files, filesDir)
    const log = files.includes(SITE_LOG) ? readFileSync(join(filesDir, SITE_LOG), "utf8") : ""
    const tail = typeof props.log_tail === "string" && props.log_tail ? props.log_tail : log
    this.state.results[id] = {
      id,
      task,
      endpoint: String(props.endpoint ?? "a site's endpoint"),
      commit: String(props.git_sha ?? ""),
      status: job.outcome,
      outcome: job.outcome,
      metrics,
      logTail: (why ? `${why}\n` : "") + tail.slice(-LOG_TAIL),
      filesDir,
      files,
      endedAt: Date.now(),
    }
    this.save()
    this.log(
      `experiment ${short(id)} ended on a site: ${job.outcome} ${JSON.stringify(metrics)}, ${files.length} files`
    )
  }

  /**
   * A site's experiment's files, from the site's file server through the links the platform signs,
   * into dir: what it downloaded, by path. A file too large, or past the total, is left on the site
   * and listed as such.
   */
  private async download(
    id: string,
    list: { path: string; sizeBytes: number | null; url: string }[],
    dir: string
  ): Promise<string[]> {
    const got: string[] = []
    let total = 0
    for (const f of list) {
      const path = normalize(f.path)
      if (path.startsWith("..") || path.startsWith("/")) continue
      const size = f.sizeBytes ?? 0
      if (size > SITE_FILE_MAX || total + size > SITE_FILES_MAX) {
        got.push(`${path} (${Math.round(size / 1024)} KB: left on the site, too large)`)
        continue
      }
      try {
        const res = await fetch(f.url)
        if (!res.ok) throw new Error(`the site answered ${res.status}`)
        const body = Buffer.from(await res.arrayBuffer())
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), body)
        total += body.length
        got.push(path)
      } catch (e) {
        this.log(`experiment ${short(id)}: couldn't download ${path}: ${(e as Error).message}`)
      }
    }
    return got
  }

  // ------------------------------------------------------------ the var-op

  private activeHypotheses(): number {
    let b: Board
    try {
      b = this.run.read<Board>("board.json") ?? { tracks: [], hypotheses: [] }
    } catch (e) {
      // the var-op's file, unreadable: it'll be told when it next runs `board`; the run goes on
      this.log(`board.json: ${(e as Error).message}`)
      return 0
    }
    // the ones that want a slot: queued, or a worker working. One waiting on its experiments has none
    return b.hypotheses.filter((h) => {
      const phase = this.state.workers[h.task]?.phase
      return phase !== "done" && phase !== "waiting"
    }).length
  }

  private waitingWorkers(): number {
    return Object.values(this.state.workers).filter((w) => w.phase === "waiting").length
  }

  private async varopLoop() {
    while (!this.done()) {
      if (!this.varopBusy && !this.past()) {
        const v = this.state.varop
        const inbox = readdirSync(this.run.path("inbox"))
        const now = Date.now()
        const due =
          !v.session ||
          this.state.unseen.length > 0 ||
          inbox.length > 0 ||
          (this.activeHypotheses() < this.cfg.workers && now - v.lastWake > 60_000) ||
          now - v.lastWake > VAROP_TICK_MS
        if (due) {
          this.varopBusy = true
          void this.wakeVarop(inbox)
            .catch((e: Error) => this.log(`var-op: ${e.message}`))
            .finally(() => (this.varopBusy = false))
        }
      }
      await sleep(3000)
    }
  }

  private async wakeVarop(inbox: string[]) {
    const v = this.state.varop
    const first = !v.session
    const seen = this.state.unseen.splice(0)
    v.lastWake = Date.now()
    v.wakes++
    this.save()
    let prompt: string
    if (first) {
      prompt = varopPrompt(this.cfg, Math.round((this.state.deadline - Date.now()) / 60_000))
    } else {
      const parts: string[] = [
        `${Math.max(0, Math.round((this.state.deadline - Date.now()) / 60_000))} minutes of proposing left; ${this.activeHypotheses()} hypotheses queued or being worked on for ${this.cfg.workers} slots, and ${this.waitingWorkers()} workers waiting on experiments (a waiting worker gives up its slot, and takes one again when its results come).`,
      ]
      for (const task of seen) {
        const w = this.state.workers[task]
        if (!w) continue
        const exps = w.experiments
          .map((id) => this.state.results[id])
          .filter((r): r is ExperimentResult => !!r)
        const ghost = this.run.path("ghosts", `${w.agent}.md`)
        parts.push(
          `Worker ${short(task)} finished hypothesis ${w.hypothesis}.\n${
            exps
              .map(
                (r) =>
                  `- experiment ${r.id} ${r.outcome} ${Object.entries(r.metrics)
                    .map(([k, x]) => `${k}=${x}`)
                    .join(" ")} @${r.commit}`
              )
              .join("\n") || "- no experiments"
          }\n${existsSync(ghost) ? `Its state:\n${readFileSync(ghost, "utf8").slice(0, 2500)}` : "It left no state."}\nIts insights: onyx research related --item ${w.hypothesis}`
        )
      }
      for (const f of inbox) {
        parts.push(`The user says: ${readFileSync(this.run.path("inbox", f), "utf8")}`)
        rmSync(this.run.path("inbox", f))
      }
      const journal = this.run.path("journal.md")
      if (existsSync(journal))
        parts.push(
          `Your journal (latest):${readFileSync(journal, "utf8").split("\n").slice(-15).join("\n")}`
        )
      parts.push("Look at the board (onyx research board), update it, and end your turn.")
      prompt = parts.join("\n\n")
    }
    this.log(
      `var-op wakes${first ? " (first time)" : ""}: ${seen.length} finished, ${inbox.length} messages`
    )
    const r = await runAgent({
      prompt,
      model: this.cfg.models.varop,
      cwd: this.repo,
      env: agentEnv(this.run, this.cfg, v.agent),
      resume: first ? this.state.base.session! : v.session!,
      fork: first,
      log: this.run.path("logs", "varop.log"),
      timeoutMs: TURN_MS,
    })
    if (r.session) v.session = r.session
    v.costUsd += r.costUsd
    this.save()
    this.log(`var-op: ${r.text.replace(/\s+/g, " ").slice(0, 300)}`)
  }
}

export async function runResearch(cfgPath: string) {
  const cfg = loadConfig(cfgPath)
  await new Supervisor(cfg, runDirFor(cfg)).start()
}

/** A message to the var-op from the user or the orchestrator, read when it's next woken. */
export function steer(cfgPath: string, message: string) {
  const run = runDirFor(loadConfig(cfgPath))
  writeFileSync(run.path("inbox", `${Date.now()}.md`), message)
}
