/**
 * Jobs (docs/jobs.md): `onyx run` queues work a unit carries out, `onyx jobs` follows and changes
 * what's in flight, `onyx units` says what can run it. A job's props are its own: the platform hands
 * them to its runner as given.
 */
import type { JobSubmit } from "../../generated/contracts/contracts"
import type { OnyxClient } from "../../sdk"

import { itemArg, need, propArgs } from "../args"
import { flags, type Command, type Context } from "../command"
import { lines } from "../io"
import { EXIT, UsageError } from "../output"
import { idOf } from "./read"

const BATCH = 1000

/** `rel=item`: an edge from the job. */
function linkArgs(links: string[] = []): NonNullable<JobSubmit["links"]> {
  return links.map((l) => {
    const at = l.indexOf("=")
    if (at <= 0) throw new UsageError(`--link ${l}: write relation=item`)
    return { rel: l.slice(0, at), dst: itemArg(l.slice(at + 1), "linked item") }
  })
}

const num = (v: string | undefined, what: string) => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n)) throw new UsageError(`${what}: a whole number`)
  return n
}

type JobView = {
  id: string
  name?: string
  state: string
  outcome?: string | null
  failure?: string | null
  reason?: string | null
  priority?: number
  unitKey?: string | null
  attempt?: number
}

const POLL_FIRST_MS = 500
const POLL_MAX_MS = 5_000

/** Follow jobs until each has ended: their ends, and whether they all succeeded. */
/** What a change left as it was: stdout says what changed, and this says what didn't. */
function unchanged(c: Context, ids: string[], changed: { id: string }[]) {
  const did = new Set(changed.map((j) => j.id))
  const left = ids.filter((id) => !did.has(id))
  if (left.length)
    c.out.note(`not changed (it has moved on, or isn't yours to change): ${left.join(" ")}`)
}

async function waitFor(c: Context, client: OnyxClient, ids: string[]) {
  const ended = new Map<string, JobView>()
  let wait = POLL_FIRST_MS
  while (ended.size < ids.length) {
    for (const id of ids) {
      if (ended.has(id)) continue
      // (not recorded yet is the moment before its first fold, retried by the client)
      const j = (await client.getJob(id)) as unknown as JobView
      if (j.state !== "ended") continue
      // an unknown outcome is ended as far as anyone can tell
      ended.set(id, j)
      if (c.out.human)
        c.out.line(
          `${id}  ${j.outcome}${j.failure ? ` (${j.failure})` : ""}${j.reason ? `: ${j.reason}` : ""}`
        )
    }
    if (ended.size < ids.length) {
      await c.io.sleep(wait)
      wait = Math.min(wait * 1.5, POLL_MAX_MS)
    }
  }
  if (!c.out.human) c.out.json({ jobs: ids.map((id) => ended.get(id)) })
  return [...ended.values()].every((j) => j.outcome === "succeeded") ? EXIT.ok : EXIT.jobFailed
}

const runCommand: Command = {
  summary: "queue a job: work a unit carries out",
  usage: `onyx run --on <unit type> [--type <activity type>] [--name <name>] [--summary <text>]
         [--space <space>] [--prop key=value]... [--link relation=item]... [--units <n>]
         [--priority <n>] [--pin <unit>] [--retries <n>] [--ttl <seconds>] [--by <item>] [--wait]
onyx run -f <jobs.ndjson|-> [--wait]

--on says what can run it: an asset type, or anything under it. Its props are its own, handed to its
runner as given (at most 16 KB: what's large goes behind a pointer). --link records an edge from it
(used=git:9f2c1e). Higher --priority goes first; among equals, oldest first. --retries is how many
times to try again after a failure that isn't its own (default none). A file has one job a line, as
JSON, with these same fields ({"on": "...", "props": {...}}); it's sent in batches of ${BATCH}.

--wait follows until it's ended: the exit code is 0 if it succeeded, ${EXIT.jobFailed} otherwise.`,
  async run(c) {
    const { values } = flags(c.argv, {
      on: { type: "string" },
      type: { type: "string" },
      name: { type: "string" },
      summary: { type: "string" },
      space: { type: "string" },
      prop: { type: "string", multiple: true },
      link: { type: "string", multiple: true },
      units: { type: "string" },
      priority: { type: "string" },
      pin: { type: "string" },
      retries: { type: "string" },
      ttl: { type: "string" },
      by: { type: "string" },
      file: { type: "string", short: "f" },
      wait: { type: "boolean" },
    })
    const client = c.client()
    const ids: string[] = []
    const send = async (jobs: JobSubmit[]) => {
      if (!jobs.length) return
      const r = await client.submitJobs(jobs)
      ids.push(...r.jobs.map((j) => j.id))
      if (c.out.human)
        for (const j of r.jobs) c.out.line(`${j.duplicate ? "already queued" : "queued"} ${j.id}`)
      else if (!values.wait) for (const j of r.jobs) c.out.ndjson(j)
    }
    if (values.file) {
      let batch: JobSubmit[] = []
      for await (const line of lines(c.io, values.file)) {
        if (!line.trim()) continue
        batch.push(JSON.parse(line) as JobSubmit)
        if (batch.length === BATCH) {
          await send(batch)
          batch = []
        }
      }
      await send(batch)
    } else {
      await send([
        {
          on: need(values.on, "--on: what kind of unit runs it"),
          ...(values.type ? { type: values.type } : {}),
          ...(values.name ? { name: values.name } : {}),
          ...(values.summary ? { summary: values.summary } : {}),
          ...(values.space ? { space: values.space } : {}),
          ...(values.prop ? { props: propArgs(values.prop) } : {}),
          ...(values.link ? { links: linkArgs(values.link) } : {}),
          ...(values.units ? { units: num(values.units, "--units") } : {}),
          ...(values.priority ? { priority: num(values.priority, "--priority") } : {}),
          ...(values.pin ? { pin: itemArg(values.pin, "unit") } : {}),
          ...(values.retries ? { retries: num(values.retries, "--retries") } : {}),
          ...(values.ttl ? { ttlS: num(values.ttl, "--ttl") } : {}),
          ...(values.by ? { createdBy: itemArg(values.by, "--by") } : {}),
        },
      ])
    }
    if (values.wait) return waitFor(c, client, ids)
  },
}

const jobsCommand: Command = {
  summary: "what's in flight: list it, follow it, change where it stands",
  usage: `onyx jobs [ls] [--state queued|assigned|running|ended] [--on <unit type>] [--limit <n>]
onyx jobs get <id>
onyx jobs wait <id>...
onyx jobs cancel <id>... [--reason <text>]
onyx jobs bump <id>...
onyx jobs priority <n> <id>...

Waiting, a job can be bumped ahead of everything waiting for its kind of unit, or given a priority
(higher goes first). A waiting job cancelled ends now; one in flight ends when its runner says it
has stopped. Yours to change, or anyone's if you're an admin. wait exits 0 if they all succeeded,
${EXIT.jobFailed} otherwise.`,
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      state: { type: "string" },
      on: { type: "string" },
      limit: { type: "string" },
      reason: { type: "string" },
    })
    const [sub = "ls", ...rest] = positionals
    const client = c.client()
    const idsOf = () => {
      if (!rest.length) throw new UsageError(`onyx jobs ${sub} <id>...`)
      return rest
    }
    if (sub === "ls") {
      const r = await client.listJobs({
        ...(values.state ? { state: values.state } : {}),
        ...(values.on ? { on: values.on } : {}),
        ...(values.limit ? { limit: Number(values.limit) } : {}),
      })
      const jobs = r.jobs as unknown as JobView[]
      if (!c.out.human) return void c.out.json(r)
      c.out.table(
        ["ID", "STATE", "NAME", "PRIORITY", "UNIT", "ATTEMPT"],
        jobs.map((j) => [j.id, j.state, j.name, j.priority, j.unitKey, j.attempt])
      )
      return
    }
    if (sub === "get") {
      const j = await client.getJob(need(rest[0], "the job"))
      c.out.json(j)
      return
    }
    if (sub === "wait") return waitFor(c, client, idsOf())
    if (sub === "cancel") {
      const ids = idsOf()
      const r = await client.cancelJobs(ids, values.reason)
      unchanged(c, ids, r.jobs)
      if (!c.out.human) return void c.out.json(r)
      for (const j of r.jobs)
        c.out.line(`${j.id} ${j.state === "ended" ? "cancelled" : "cancelling"}`)
      return
    }
    if (sub === "bump" || sub === "priority") {
      const to =
        sub === "bump"
          ? ({ bump: true } as const)
          : { priority: num(rest.shift(), "the priority")! }
      const ids = idsOf()
      const r = await client.setJobPriority(ids, to)
      unchanged(c, ids, r.jobs)
      if (!c.out.human) return void c.out.json(r)
      for (const j of r.jobs) c.out.line(`${j.id} priority ${j.priority}`)
      return
    }
    throw new UsageError(`onyx jobs: no ${sub} (onyx help jobs)`)
  },
}

const unitsCommand: Command = {
  summary: "what jobs run on: list units, take them out of service, put them back",
  usage: `onyx units [ls]
onyx units hold <unit>... [--reason <text>]
onyx units resume <unit>...

A held unit is offered no work until it's resumed. Admins only.`,
  async run(c) {
    const { values, positionals } = flags(c.argv, { reason: { type: "string" } })
    const [sub = "ls", ...rest] = positionals
    const client = c.client()
    if (sub === "ls") {
      const r = await client.listUnits()
      if (!c.out.human) return void c.out.json(r)
      const units = r.units as {
        id: string
        name: string
        state: string
        used: number
        capacity: number
      }[]
      c.out.table(
        ["ID", "NAME", "STATE", "USED"],
        units.map((u) => [u.id, u.name, u.state, `${u.used}/${u.capacity}`])
      )
      return
    }
    if (sub !== "hold" && sub !== "resume") throw new UsageError(`onyx units: no ${sub}`)
    if (!rest.length) throw new UsageError(`onyx units ${sub} <unit>...`)
    const ids = await Promise.all(rest.map((a) => idOf(c, client, a)))
    const r =
      sub === "hold" ? await client.holdUnits(ids, values.reason) : await client.resumeUnits(ids)
    if (!c.out.human) return void c.out.json(r)
    for (const id of r.units) c.out.line(`${sub === "hold" ? "held" : "resumed"} ${id}`)
  },
}

export const jobs: Record<string, Command> = {
  run: runCommand,
  jobs: jobsCommand,
  units: unitsCommand,
}
