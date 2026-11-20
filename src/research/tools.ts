/**
 * The commands agents use (`onyx research <command>`), run from their shells inside a run. Each
 * writes to the platform with the run's key, naming the agent that asked as the author
 * (`ONYX_AGENT`), and to the run's directory what the supervisor needs to see.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"

import { FILE_MAX_BYTES } from "../generated/contracts/contracts"
import type { KgResult } from "../generated/contracts/contracts"
import type { OnyxClient } from "../sdk"

import { NO_TOOLS, runAgent } from "./agents"
import { loadConfig, type LoadedConfig, modelFor } from "./config"
import { changedPaths, commitAndPush, measurementOf } from "./git"
import { client, SOURCE, upsert } from "./platform"
import { limitsText, timeLimits } from "./limits"
import { ghostPrompt, PACKETS_DIR } from "./prompts"
import { runFromEnv, type ExperimentResult, type RunDir } from "./state"

export interface Board {
  tracks: { id: string; name: string; why: string; status: string; weight: number }[]
  hypotheses: {
    id: string
    title: string
    track: string
    task: string
    priority: number
    base: string | null
    at: number
    /** a measurement hypothesis: it may change how results are measured */
    measurement?: boolean
  }[]
}

/**
 * At or above this, an insight is close enough that its writer should say how theirs relates: the
 * embedding model scores unrelated notes about 0.8 (docs/knowledge-graph.md), so a lower bar shows
 * a worker nearly everything. At most SIMILAR_SHOWN of them, nearest first.
 */
const SIMILAR = 0.88
const SIMILAR_SHOWN = 3
const NOTE_KINDS = ["insight", "dead_end", "promising_direction", "risk", "transfer_note"]
/** what an experiment is for (skills/onyx-research-worker, "Common experiment shapes") */
export const EXPERIMENT_KINDS = ["measure", "diagnose", "repeat", "ablate", "variant"]

class Usage extends Error {}

const list = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
const short = (id: string) => id.slice(-8)

interface Env {
  run: RunDir
  cfg: LoadedConfig
  onyx: OnyxClient
  agent: string
}

function env(): Env {
  const run = runFromEnv()
  const cfgPath = process.env.ONYX_RESEARCH_CONFIG
  if (!cfgPath) throw new Error("ONYX_RESEARCH_CONFIG isn't set")
  const agent = process.env.ONYX_AGENT
  if (!agent) throw new Error("ONYX_AGENT isn't set")
  return { run, cfg: loadConfig(cfgPath), onyx: client(), agent }
}

const board = (run: RunDir) => run.read<Board>("board.json") ?? { tracks: [], hypotheses: [] }

/** An aspect's id by name: an existing one of the same name (or very near it), or a new one. */
async function aspectId(onyx: OnyxClient, name: string, author: string): Promise<string> {
  const key = `aspect:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  try {
    return (await onyx.resolve({ system: SOURCE, key })).id
  } catch {
    const near = await onyx.related({ q: name, types: ["topic"], limit: 1, expand: false })
    const hit = near.results[0]
    if (hit && (hit.similarity ?? 0) >= 0.85) return hit.item.id
    return upsert(onyx, key, { type: "topic", name, createdBy: author })
  }
}

function formatResult(r: KgResult): string {
  const it = r.item
  const kind = it.noteKind ? ` ${it.noteKind}` : ""
  const sim = r.similarity !== null ? ` sim ${r.similarity.toFixed(2)}` : ""
  const sup = r.superseded ? " [SUPERSEDED]" : ""
  const links = r.links
    .slice(0, 6)
    .map(
      (l) =>
        `${l.dir === "out" ? "" : "<-"}${l.rel} ${l.item.type} "${l.item.name}" (${l.item.id}${l.item.status ? `, ${l.item.status}` : ""})`
    )
    .join("; ")
  return `- ${it.id} ${it.type}${kind}${sim}${sup}: ${it.name}${it.summary ? `\n    ${it.summary.replace(/\s+/g, " ").slice(0, 400)}` : ""}${links ? `\n    links: ${links}` : ""}`
}

/** The related read, as text an agent reads. */
export async function relatedText(onyx: OnyxClient, input: Parameters<OnyxClient["related"]>[0]) {
  const r = await onyx.related(input)
  return r.results.map(formatResult).join("\n")
}

/** The board as the var-op reads it: slots, tracks, hypotheses with their results, best commits. */
export function boardText(run: RunDir, cfg: LoadedConfig): string {
  const b = board(run)
  const s = run.state()
  const lines: string[] = []
  const left = Math.max(0, Math.round((s.deadline - Date.now()) / 60_000))
  // only a turn running holds a slot: a worker waiting on its experiments holds none
  const workers = Object.values(s.workers)
  const inSlots = workers.filter((w) => w.phase === "running" || w.phase === "starting").length
  const backInLine = workers.filter((w) => w.phase === "queued").length
  const waiting = workers.filter((w) => w.phase === "waiting").length
  const queuedNew = b.hypotheses.filter((h) => !s.workers[h.task]).length
  const free = Math.max(0, cfg.workers - inSlots - backInLine - queuedNew)
  lines.push(`Time limit per experiment (a hard cutoff): ${limitsText(timeLimits(run, cfg))}.`)
  lines.push(
    `${left} minutes of proposing left. ${cfg.workers} worker slots: ${inSlots} running a turn now, ${backInLine} workers back in line for one, ${queuedNew} new hypotheses queued; ${waiting} workers waiting on experiments hold no slot.${free ? ` ${free} slots will sit idle: queue at least ${free} more hypotheses.` : ""}`
  )
  const taskState = (task: string) => {
    const w = s.workers[task]
    return w
      ? w.phase === "done"
        ? "done"
        : w.phase === "waiting"
          ? "waiting on an experiment (holds no slot)"
          : w.phase === "queued"
            ? "back in line for a slot, with its results"
            : "running a turn in a slot"
      : "queued"
  }
  lines.push("\n## Tracks")
  for (const t of b.tracks)
    lines.push(`- ${t.id} [${t.status}, weight ${t.weight}] ${t.name}: ${t.why}`)
  if (!b.tracks.length) lines.push("(none yet)")
  const measurements = new Set(Object.values(s.results).map((r) => r.measurement ?? "-"))
  const several = measurements.size > 1
  lines.push("\n## Hypotheses")
  for (const h of b.hypotheses) {
    const w = s.workers[h.task]
    const ids = w
      ? [...w.experiments, ...(run.read<string[]>(`workers/${w.task}/pending.json`) ?? [])]
      : []
    const res = ids
      .map((x) => {
        const r = s.results[x]
        if (!r) return `${short(x)} in flight`
        const m = Object.entries(r.metrics)
          .map(([k, v]) => `${k}=${+v.toPrecision(4)}`)
          .join(" ")
        return `${short(r.id)} ${r.kind ?? "measure"} ${r.outcome ?? "?"} ${m} @${r.commit.slice(0, 10)}${several ? ` (measurement ${r.measurement ?? "-"})` : ""}`
      })
      .join("; ")
    lines.push(
      `- ${h.id} [${taskState(h.task)}]${h.measurement ? " [measurement]" : ""} track ${short(h.track)}: ${h.title}${res ? `\n    experiments: ${res}` : ""}`
    )
  }
  if (!b.hypotheses.length) lines.push("(none yet)")
  lines.push(
    `\n## Best commits (diagnostic runs left out${several ? "; results measured differently are never compared" : ""})`
  )
  const ok = Object.values(s.results).filter(
    (r) => r.outcome === "succeeded" && (r.kind ?? "measure") !== "diagnose"
  )
  const byMeasurement = new Map<string, ExperimentResult[]>()
  for (const r of ok)
    byMeasurement.set(r.measurement ?? "-", [...(byMeasurement.get(r.measurement ?? "-") ?? []), r])
  if (!byMeasurement.size) byMeasurement.set("-", [])
  for (const [measured, rs] of byMeasurement) {
    if (several) lines.push(`Measured by ${measured}:`)
    for (const m of cfg.metrics) {
      const best = rs
        .filter((r) => m.key in r.metrics)
        .sort((a, b) =>
          m.better === "higher"
            ? b.metrics[m.key]! - a.metrics[m.key]!
            : a.metrics[m.key]! - b.metrics[m.key]!
        )
        .slice(0, 3)
      lines.push(
        `- ${m.key} (${m.better}): ${best.map((r) => `${+r.metrics[m.key]!.toPrecision(4)} @${r.commit} (experiment ${r.id})`).join(", ") || "none yet"}`
      )
    }
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------- commands

const COMMANDS: Record<string, { help: string; run: (args: string[]) => Promise<string> }> = {
  aspect: {
    help: 'aspect "<name>" "<description>": an aspect of the system (base agent)',
    async run(args) {
      const [name, description] = args
      if (!name) throw new Usage("aspect needs a name")
      const e = env()
      const key = `aspect:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      const near = await e.onyx.related({ q: name, types: ["topic"], limit: 3, expand: false })
      const dup = near.results.find((r) => (r.similarity ?? 0) >= 0.85)
      if (dup) return `exists: ${dup.item.id} "${dup.item.name}" (use it)`
      const id = await upsert(e.onyx, key, {
        type: "topic",
        name,
        summary: description,
        createdBy: e.agent,
      })
      return `aspect ${id}: ${name}`
    },
  },

  board: {
    help: "board: tracks, hypotheses, results and the best commits (var-op)",
    async run() {
      const e = env()
      return boardText(e.run, e.cfg)
    },
  },

  track: {
    help: 'track open "<name>" --why "<text>" [--weight w] | track set <track> [--weight w] [--status s] (var-op)',
    async run(args) {
      const [verb, ...rest] = args
      const { values: o, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          why: { type: "string" },
          weight: { type: "string" },
          status: { type: "string" },
        },
      })
      const e = env()
      const s = e.run.state()
      const b = board(e.run)
      if (verb === "open") {
        const name = positionals[0]
        if (!name || !o.why) throw new Usage('track open "<name>" --why "<rationale>"')
        const weight = Number(o.weight ?? 1)
        const id = e.onyx.newId()
        await e.onyx.ingest({
          items: [
            {
              id,
              type: "track",
              name,
              summary: o.why,
              status: "exploring",
              props: { weight },
              createdBy: e.agent,
            },
          ],
          edges: [{ rel: "in_campaign", src: id, dst: s.campaign }],
        })
        b.tracks.push({ id, name, why: o.why, status: "exploring", weight })
        e.run.write("board.json", b)
        return `track ${id}: ${name}`
      }
      if (verb === "set") {
        const t = b.tracks.find(
          (x) => x.id === positionals[0] || x.id.endsWith(positionals[0] ?? "-")
        )
        if (!t) throw new Usage(`no track ${positionals[0]}`)
        const patch: { status?: string; props?: Record<string, unknown> } = {}
        if (o.weight !== undefined) {
          t.weight = Number(o.weight)
          patch.props = { weight: t.weight }
        }
        if (o.status) t.status = patch.status = o.status
        if (patch.props) await e.onyx.updateEntity(t.id, { props: patch.props })
        if (patch.status) await e.onyx.setStatus(t.id, patch.status)
        e.run.write("board.json", b)
        return `track ${t.id}: ${t.status}, weight ${t.weight}`
      }
      throw new Usage("track open | track set")
    },
  },

  propose: {
    help: 'propose --track <track> --title "<hypothesis>" --why "<text>" [--base <commit>] [--informed-by ids] [--reworks <hypothesis>] [--about "aspect,..."] [--priority n] [--measurement] (var-op; --measurement: it changes how results are measured)',
    async run(args) {
      const { values: o } = parseArgs({
        args,
        options: {
          track: { type: "string" },
          title: { type: "string" },
          why: { type: "string" },
          base: { type: "string" },
          "informed-by": { type: "string" },
          reworks: { type: "string" },
          about: { type: "string" },
          priority: { type: "string" },
          measurement: { type: "boolean" },
        },
      })
      if (!o.track || !o.title || !o.why)
        throw new Usage("propose needs --track, --title and --why")
      const e = env()
      const b = board(e.run)
      const track = b.tracks.find((t) => t.id === o.track || t.id.endsWith(o.track!))
      if (!track) throw new Usage(`no track ${o.track}: open one first`)
      const id = e.onyx.newId()
      const task = e.onyx.newId()
      const priority = Math.round(Number(o.priority ?? 0))
      const base = o.base ?? null
      const edges = [
        { rel: "in_track", src: id, dst: track.id },
        // and its run, so the campaign's plot (onyx research plot) finds its experiments
        { rel: "in_campaign", src: id, dst: e.run.state().campaign },
        ...list(o["informed-by"]).map((x) => ({ rel: "informed_by", src: id, dst: x })),
        ...(o.reworks ? [{ rel: "reworks", src: id, dst: o.reworks }] : []),
      ]
      for (const name of list(o.about))
        edges.push({ rel: "about", src: id, dst: await aspectId(e.onyx, name, e.agent) })
      await e.onyx.ingest({
        items: [
          {
            id,
            type: "hypothesis",
            name: o.title.slice(0, 500),
            summary: o.why.slice(0, 4000),
            status: "proposed",
            ...(o.measurement ? { props: { measurement: true } } : {}),
            createdBy: e.agent,
          },
        ],
        edges,
      })
      await e.onyx.submitJobs([
        {
          id: task,
          type: "worker_task",
          on: "agent_worker",
          name: o.title.slice(0, 500),
          summary: o.why.slice(0, 4000),
          priority,
          props: {
            hypothesis: id,
            base_commit: base ?? e.cfg.baseBranch,
            track: track.id,
            ...(o.measurement ? { measurement: true } : {}),
          },
          links: [{ rel: "tests", dst: id }],
          createdBy: e.agent,
        },
      ])
      b.hypotheses.push({
        id,
        title: o.title,
        track: track.id,
        task,
        priority,
        base,
        at: Date.now(),
        ...(o.measurement ? { measurement: true } : {}),
      })
      e.run.write("board.json", b)
      return `${o.measurement ? "measurement " : ""}hypothesis ${id} queued (task ${task})`
    },
  },

  withdraw: {
    help: "withdraw <hypothesis>: drop one that's still queued (var-op)",
    async run(args) {
      const e = env()
      const b = board(e.run)
      const h = b.hypotheses.find((x) => x.id === args[0] || x.id.endsWith(args[0] ?? "-"))
      if (!h) throw new Usage(`no hypothesis ${args[0]}`)
      await e.onyx.cancelJobs([h.task], "withdrawn by the variational operator")
      await e.onyx.setStatus(h.id, "abandoned")
      return `withdrawn ${h.id}`
    },
  },

  related: {
    help: 'related "<text>" | related --item <id> [--types note,hypothesis] [--limit n]',
    async run(args) {
      const { values: o, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { item: { type: "string" }, types: { type: "string" }, limit: { type: "string" } },
      })
      const e = env()
      const text = await relatedText(e.onyx, {
        ...(o.item ? { item: o.item } : { q: positionals.join(" ") }),
        types: list(o.types),
        limit: Number(o.limit ?? 8),
      })
      return text || "nothing related yet"
    },
  },

  ask: {
    help: 'ask <insight or agent> "<question>": ask the worker that wrote it',
    async run(args) {
      const [ref, ...q] = args
      const question = q.join(" ")
      if (!ref || !question) throw new Usage('ask <insight or agent> "<question>"')
      const e = env()
      const s = e.run.state()
      const item = (await e.onyx.getEntity(ref)) as {
        id: string
        type?: string
        createdBy?: string | null
        created_by?: string | null
      }
      const author =
        item.type === "ai_agent" ? item.id : (item.createdBy ?? item.created_by ?? null)
      if (!author) return "that item has no author to ask"
      const statePath = e.run.path("ghosts", `${author}.md`)
      if (!existsSync(statePath))
        return "its author left no state to answer from (it may still be working, or be from another machine's run)"
      const state = readFileSync(statePath, "utf8")
      const agentItem = (await e.onyx.getEntity(author)) as { name?: string }
      const r = await runAgent({
        agent: e.cfg.agent,
        prompt: ghostPrompt(agentItem.name ?? author, state, question),
        model: modelFor(e.cfg, "ghost"),
        cwd: e.run.path("repo"),
        env: {},
        resume: s.base.session ?? undefined,
        fork: true,
        log: e.run.path("logs", "ghosts.log"),
        timeoutMs: 300_000,
        // it answers from its state, which is in the prompt
        tools: NO_TOOLS,
      })
      return r.ok ? r.text : `the ghost couldn't answer: ${r.text.slice(0, 500)}`
    },
  },

  journal: {
    help: 'journal "<note>": the var-op\'s own notes',
    async run(args) {
      const e = env()
      appendFileSync(
        e.run.path("journal.md"),
        `\n- ${new Date().toISOString().slice(11, 16)} ${args.join(" ")}`
      )
      return "noted"
    },
  },

  experiment: {
    help: `experiment --endpoint <type> --kind ${EXPERIMENT_KINDS.join("|")} -m "<what it tests>" [--packet <repo path>] (worker)`,
    async run(args) {
      const { values: o } = parseArgs({
        args,
        options: {
          endpoint: { type: "string" },
          m: { type: "string", short: "m" },
          packet: { type: "string" },
          kind: { type: "string" },
        },
      })
      const kind = o.kind ?? "measure"
      if (!EXPERIMENT_KINDS.includes(kind))
        throw new Usage(`--kind: ${EXPERIMENT_KINDS.join(", ")}`)
      const e = env()
      const task = process.env.ONYX_TASK
      if (!task) throw new Usage("experiment is a worker's command")
      const ep =
        e.cfg.endpoints.find((x) => x.type === o.endpoint) ??
        (e.cfg.endpoints.length === 1 ? e.cfg.endpoints[0] : undefined)
      if (!ep)
        throw new Usage(`--endpoint: one of ${e.cfg.endpoints.map((x) => x.type).join(", ")}`)
      if (!o.m) throw new Usage('-m "<what this experiment tests>"')
      const w = e.run.state().workers[task]
      if (!w) throw new Error(`no worker for task ${task}`)
      const pending = e.run.read<string[]>(`workers/${task}/pending.json`) ?? []
      const done = w.experiments.length + pending.length
      if (done >= e.cfg.experimentsPerTask)
        return `You've reached the run's ceiling of ${e.cfg.experimentsPerTask} experiments for one hypothesis. Record your insights, including what you'd test next and why, and finish: the var-op can give a follow-up its own hypothesis.`
      if (o.packet && !existsSync(join(w.worktree, o.packet)))
        throw new Usage(
          `--packet ${o.packet}: no such file in your worktree (write packets in ${PACKETS_DIR}/)`
        )
      const touched = w.measurement ? [] : changedPaths(w.worktree, w.baseCommit, e.cfg.measurement)
      if (touched.length)
        throw new Usage(
          `your change touches the measurement (${touched.join(", ")}): only a measurement hypothesis may change how results are measured. Put those files back as they were at ${w.baseCommit.slice(0, 10)} (git diff shows what changed), and if you think the measurement should change, say why in an insight or at the end of your turn: the var-op can propose it`
        )
      const commit = commitAndPush(w.worktree, w.branch, o.m)
      const measurement = measurementOf(w.worktree, commit, e.cfg.measurement)
      // the campaign's limit as it is now, sent with the experiment: its driver stops it there
      const timeLimit = timeLimits(e.run, e.cfg)[ep.type]!
      const id = e.onyx.newId()
      // Fair share of a shared endpoint: the more experiments this run has in flight, the lower the
      // priority of its next one, so a run using little of the endpoint goes ahead of one using a
      // lot. (Two runs on one site's bench, at equal priority, were served first come: one run's
      // slow experiments held 7 of 8 slots and the other's waited behind them.)
      const s = e.run.state()
      let inFlight = 0
      for (const x of Object.values(s.workers))
        if (x.phase !== "done")
          for (const p of e.run.read<string[]>(`workers/${x.task}/pending.json`) ?? [])
            if (!s.results[p]) inFlight++
      await e.onyx.submitJobs([
        {
          id,
          type: "experiment",
          on: ep.type,
          priority: -inFlight,
          name: o.m.slice(0, 500),
          summary: o.m.slice(0, 4000),
          props: {
            git_sha: commit,
            branch: w.branch,
            base_commit: w.baseCommit,
            packet: o.packet ?? null,
            kind,
            measurement,
            time_limit_s: timeLimit,
            endpoint: ep.type,
            // what a site fetches (python/site-runner, "Writing a driver"); the ref for remotes
            // that refuse fetching by sha
            git: { url: e.cfg.remote, commit, ref: w.branch },
          },
          links: [
            { rel: "tests", dst: w.hypothesis },
            { rel: "performed_by", dst: e.agent },
          ],
          createdBy: e.agent,
        },
      ])
      e.run.write(`workers/${task}/pending.json`, [...pending, id])
      return `experiment ${id} queued on ${ep.type} at commit ${commit.slice(0, 10)}, time limit ${timeLimit} s. End your turn now: you'll be resumed with its result.`
    },
  },

  insight: {
    help: 'insight --claim "<sentence>" --detail "<evidence>" --kind insight|dead_end|promising_direction|risk --from <experiment,...> [--about "aspect,..."] [--informed-by ids] [--rel <relation>:<id>[:confidence] ...] [--checked]',
    async run(args) {
      const { values: o } = parseArgs({
        args,
        options: {
          claim: { type: "string" },
          detail: { type: "string" },
          kind: { type: "string" },
          from: { type: "string" },
          about: { type: "string" },
          "informed-by": { type: "string" },
          rel: { type: "string", multiple: true },
          checked: { type: "boolean" },
        },
      })
      if (!o.claim || !o.kind || !o.from)
        throw new Usage("insight needs --claim, --kind and --from")
      if (!NOTE_KINDS.includes(o.kind)) throw new Usage(`--kind: ${NOTE_KINDS.join(", ")}`)
      const e = env()
      if (!o.checked) {
        // every similar insight goes to the worker, who judges how it relates (docs/research.md)
        const near = await e.onyx.related({
          q: `${o.claim}\n${o.detail ?? ""}`,
          types: ["note"],
          limit: 8,
        })
        const similar = near.results
          .filter((r) => (r.similarity ?? 0) >= SIMILAR)
          .slice(0, SIMILAR_SHOWN)
        if (similar.length)
          return `Similar insights are already in the graph:\n${similar.map(formatResult).join("\n")}\n\nDecide how yours relates to each (supports, contradicts, refines, supersedes; or none), then run the same command again with --checked and a --rel <relation>:<id>[:confidence] for each that relates.`
      }
      const id = e.onyx.newId()
      const rels = (o.rel ?? []).map((r) => {
        const [rel, dst, conf] = r.split(":")
        if (!rel || !dst || !["supports", "contradicts", "refines", "supersedes"].includes(rel))
          throw new Usage(`--rel ${r}: <supports|contradicts|refines|supersedes>:<id>[:confidence]`)
        return {
          rel,
          src: id,
          dst,
          assertion: "inferred" as const,
          ...(conf ? { confidence: Number(conf) } : {}),
        }
      })
      const edges = [
        ...list(o.from).map((x) => ({ rel: "generated_by", src: id, dst: x })),
        ...list(o["informed-by"]).map((x) => ({ rel: "informed_by", src: id, dst: x })),
        ...rels,
      ]
      for (const name of list(o.about))
        edges.push({ rel: "about", src: id, dst: await aspectId(e.onyx, name, e.agent) })
      await e.onyx.ingest({
        items: [
          {
            id,
            type: "note",
            name: o.claim.slice(0, 500),
            summary: o.detail?.slice(0, 4000),
            props: { note_kind: o.kind },
            createdBy: e.agent,
          },
        ],
        edges,
      })
      return `insight ${id} recorded`
    },
  },

  image: {
    help: 'image <file> [<file> ...] [--on <item>] [--caption "<what it shows>"] [--step <n>]: put screenshots or GIFs (PNG, JPEG, GIF, WebP; at most 4 MB each) on an item\'s page for people to see: your hypothesis by default, or an experiment or insight',
    async run(args) {
      const { values: o, positionals: files } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          on: { type: "string" },
          caption: { type: "string" },
          step: { type: "string" },
        },
      })
      if (!files.length) throw new Usage("image <file> [<file> ...] [--on <item>]")
      const step = o.step === undefined ? undefined : Number(o.step)
      if (step !== undefined && !(Number.isInteger(step) && step >= 0))
        throw new Usage("--step: a whole number, 0 or more")
      const e = env()
      const task = process.env.ONYX_TASK
      const on = o.on ?? (task ? e.run.state().workers[task]?.hypothesis : undefined)
      if (!on) throw new Usage("--on <item>: the hypothesis, experiment or insight it belongs to")
      const lines: string[] = []
      for (const file of files) {
        if (!existsSync(file)) throw new Usage(`${file}: no such file`)
        const bytes = new Uint8Array(readFileSync(file))
        if (bytes.byteLength > FILE_MAX_BYTES)
          throw new Usage(
            `${file} is ${(bytes.byteLength / 1e6).toFixed(1)} MB; at most ${FILE_MAX_BYTES / 2 ** 20} MB. Make it smaller: fewer frames or a lower resolution for a GIF (ffmpeg -i in.gif -vf "fps=8,scale=480:-1" out.gif), a JPEG or WebP for a screenshot`
          )
        const f = await e.onyx.uploadFile(on, bytes, {
          name: basename(file).slice(0, 200),
          ...(o.caption !== undefined && { caption: o.caption.slice(0, 2000) }),
          ...(step !== undefined && { step }),
        })
        lines.push(`image ${f.id} (${f.mediaType}) on ${on}`)
      }
      return lines.join("\n")
    },
  },

  finish: {
    help: "finish --state <file> --verdict supported|refuted|unclear: your state, for your ghost; then stop (worker)",
    async run(args) {
      const { values: o } = parseArgs({
        args,
        options: { state: { type: "string" }, verdict: { type: "string" } },
      })
      const e = env()
      const task = process.env.ONYX_TASK
      if (!task) throw new Usage("finish is a worker's command")
      if (!o.verdict || !["supported", "refuted", "unclear"].includes(o.verdict))
        throw new Usage("--verdict supported|refuted|unclear")
      if (!o.state || !existsSync(o.state))
        throw new Usage("finish --state <file>: write your state first")
      const text = readFileSync(o.state, "utf8")
      if (text.trim().length < 200)
        throw new Usage("your state is too short to answer questions from: fill in every section")
      // a hypothesis can be answered without an experiment (a thought experiment, reading the
      // code): the state says how it was answered
      const id = e.onyx.newId()
      await e.onyx.ingest({
        items: [
          {
            id,
            type: "agent_state",
            name: `state of ${short(e.agent)}`,
            summary: text.slice(0, 4000),
            props: {
              state_text: text.slice(0, 60_000),
              model: modelFor(e.cfg, "worker") ?? `${e.cfg.agent} default`,
            },
            createdBy: e.agent,
          },
        ],
        edges: [{ rel: "state_of", src: id, dst: e.agent }],
      })
      const w = e.run.state().workers[task]
      if (w && o.verdict !== "unclear") await e.onyx.setStatus(w.hypothesis, o.verdict)
      writeFileSync(e.run.path("ghosts", `${e.agent}.md`), text)
      e.run.write(`workers/${task}/finished.json`, { state: id, at: Date.now() })
      return "Finished. Your state is saved; end your turn."
    },
  },
}

export async function runTool(name: string, args: string[]): Promise<number> {
  if (name === "help" || !COMMANDS[name]) {
    console.log(
      Object.values(COMMANDS)
        .map((c) => `onyx research ${c.help}`)
        .join("\n")
    )
    return name === "help" ? 0 : 2
  }
  try {
    console.log(await COMMANDS[name]!.run(args))
    return 0
  } catch (err) {
    console.error(`${err instanceof Usage ? "usage" : "error"}: ${(err as Error).message}`)
    return err instanceof Usage ? 2 : 1
  }
}
