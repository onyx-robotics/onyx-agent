/** Reading: items, their lineage, search, lists, the vocabulary, the change feed. */
import { existsSync, readFileSync, writeFileSync } from "node:fs"

import type { OnyxClient } from "../../sdk"

import { itemArg, need } from "../args"
import { flags, type Command, type Context } from "../command"
import { UsageError, type Out } from "../output"

/** An item argument as an id: an id as is, a source key looked up. */
export async function idOf(_c: Context, client: OnyxClient, arg: string | undefined) {
  const ref = itemArg(arg)
  return "id" in ref ? ref.id : (await client.resolve(ref.source)).id
}

const when = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "" : new Date(ms).toISOString().replace(".000Z", "Z")

interface ItemView {
  id: string
  name: string
  type: string
  typeLabel: string
  status: string | null
  summary: string | null
  space: { id: string; name: string }
  t: number
  createdAt: number
  archivedAt: number | null
  sealedAt: number | null
  revision: number | null
  createdBy: { id: string; name: string } | null
  props: Record<string, unknown>
  sources: { system: string; key: string }[]
  metrics: {
    property: string
    value: number
    unit: string | null
    context: { name: string } | null
  }[]
  edges: {
    out: EdgeView[]
    in: EdgeView[]
    counts: { dir: string; label: string; n: number; atLeast: boolean; shown: number }[]
  }
}
interface EdgeView {
  rel: string
  label: string
  other: { id: string; name: string; type: string }
}

function showItem(out: Out, it: ItemView) {
  out.line(`${it.name}  (${it.typeLabel}${it.status ? `, ${it.status}` : ""})`)
  const rows: [string, string][] = [
    ["id", it.id],
    ["type", it.type + (it.revision !== null ? ` (revision ${it.revision})` : "")],
    ["space", it.space.name],
    ["created", `${when(it.createdAt)}${it.createdBy ? ` by ${it.createdBy.name}` : ""}`],
  ]
  if (it.sources.length)
    rows.push(["sources", it.sources.map((s) => `${s.system}:${s.key}`).join(", ")])
  if (it.sealedAt) rows.push(["sealed", when(it.sealedAt)])
  if (it.archivedAt) rows.push(["archived", when(it.archivedAt)])
  if (it.summary) rows.push(["summary", it.summary])
  for (const [k, v] of rows) out.line(`${k.padEnd(9)} ${v}`)
  const props = Object.entries(it.props)
  if (props.length) {
    out.line("props")
    for (const [k, v] of props) out.line(`  ${k}: ${JSON.stringify(v)}`)
  }
  if (it.metrics.length) {
    out.line("metrics")
    for (const m of it.metrics)
      out.line(
        `  ${m.property}: ${m.value}${m.unit ? ` ${m.unit}` : ""}${m.context ? `  (in ${m.context.name})` : ""}`
      )
  }
  const edges = [
    ...it.edges.out.map((e) => `  ${e.label} -> ${e.other.name} (${e.other.type}, ${e.other.id})`),
    ...it.edges.in.map((e) => `  ${e.label} <- ${e.other.name} (${e.other.type}, ${e.other.id})`),
  ]
  if (edges.length) {
    out.line("edges")
    for (const e of edges) out.line(e)
    for (const k of it.edges.counts.filter((x) => x.n > x.shown))
      out.line(`  … ${k.label}: ${k.atLeast ? "at least " : ""}${k.n} in all`)
  }
}

const get: Command = {
  summary: "an item: what it is, its props, metrics and edges",
  usage: "onyx get <item> [--history]   (an item: its id, or a source key system:key)",
  async run(c) {
    const { values, positionals } = flags(c.argv, { history: { type: "boolean" } })
    const client = c.client()
    const id = await idOf(c, client, positionals[0])
    const it = (await client.request<ItemView>(
      "GET",
      `/entities/${id}${values.history ? "?history=true" : ""}`
    )) as ItemView
    if (c.out.human) showItem(c.out, it)
    else c.out.json(it)
  },
}

const find: Command = {
  summary: "items by name",
  usage: "onyx find <text> [--type <type>]... [--limit <n>]",
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      type: { type: "string", multiple: true },
      limit: { type: "string" },
    })
    const q = need(positionals.join(" ") || undefined, "what to look for")
    const hits = await c.client().search(q, Number(values.limit ?? 20), values.type ?? [])
    if (!c.out.human) return void c.out.json(hits)
    c.out.table(
      ["id", "type", "status", "name"],
      hits.map((h) => [h.id, h.type, h.status, h.name])
    )
  },
}

const STATUS = [
  "pending",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "none",
]
const SINCE = ["1d", "7d", "30d", "90d", "365d"]

const ls: Command = {
  summary: "items, newest first: by type, status class, space and time",
  usage: `onyx ls [--type <type>]... [--status <class>]... [--since 1d|7d|30d|90d|365d]
         [--space <space id>]... [--limit <n>] [--all]

A status is a class (${STATUS.join(", ")}). --all follows every page (NDJSON with --json).`,
  async run(c) {
    const { values } = flags(c.argv, {
      type: { type: "string", multiple: true },
      status: { type: "string", multiple: true },
      since: { type: "string" },
      space: { type: "string", multiple: true },
      limit: { type: "string" },
      all: { type: "boolean" },
    })
    for (const s of values.status ?? [])
      if (!STATUS.includes(s)) throw new UsageError(`--status ${s}: one of ${STATUS.join(", ")}`)
    if (values.since && !SINCE.includes(values.since))
      throw new UsageError(`--since: one of ${SINCE.join(", ")}`)
    const client = c.client()
    const filter = {
      types: values.type,
      statusClasses: values.status as never,
      since: values.since as never,
      spaces: values.space,
      limit: Math.min(Number(values.limit ?? (values.all ? 500 : 50)), 500),
    }
    const head = ["id", "type", "status", "time", "name"]
    type Row = { id: string; type: string; status: string | null; t: number; name: string }
    const row = (i: Row) => [i.id, i.type, i.status, when(i.t), i.name]
    let cursor: string | undefined
    let first = true
    do {
      const page = await client.listItems({ ...filter, cursor })
      const items = page.items as unknown as Row[]
      if (!values.all) {
        if (!c.out.human) return void c.out.json(page)
        c.out.table(head, items.map(row))
        if (page.cursor) c.out.note("(more: --limit, or --all)")
        return
      }
      if (c.out.human) {
        if (first) c.out.line(head.join("  "))
        for (const i of items) c.out.line(row(i).join("  "))
      } else for (const i of items) c.out.ndjson(i)
      first = false
      cursor = page.cursor ?? undefined
    } while (cursor)
  },
}

const lineage: Command = {
  summary: "what an item came from and what came from it",
  usage: "onyx lineage <item> [--up | --down] [--depth <1-6>] [--relation <key>]...",
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      up: { type: "boolean" },
      down: { type: "boolean" },
      depth: { type: "string" },
      relation: { type: "string", multiple: true },
    })
    const client = c.client()
    const id = await idOf(c, client, positionals[0])
    const l = (await client.lineage(id, {
      direction: values.up ? "up" : values.down ? "down" : "both",
      depth: values.depth ? Number(values.depth) : undefined,
      relations: values.relation,
    })) as {
      nodes: { id: string; name: string; type: string; depth: number }[]
      edges: { src: string; dst: string; label: string }[]
      truncated: unknown
    }
    if (!c.out.human) return void c.out.json(l)
    const name = new Map(l.nodes.map((n) => [n.id, `${n.name} (${n.type})`]))
    for (const e of l.edges)
      c.out.line(`${name.get(e.src) ?? e.src}  --${e.label}-->  ${name.get(e.dst) ?? e.dst}`)
    if (l.truncated) c.out.note("(cut short: --depth, or --relation to narrow it)")
  },
}

const events: Command = {
  summary: "the change feed: every event once, in commit order",
  usage: `onyx events [--follow] [--cursor-file <path>] [--interval <seconds>] [--limit <n>]

Prints events after the cursor (from --cursor-file, else from the start), and saves the cursor
there after each page. Without --follow it stops once caught up. NDJSON with --json.`,
  async run(c) {
    const { values } = flags(c.argv, {
      follow: { type: "boolean" },
      "cursor-file": { type: "string" },
      interval: { type: "string" },
      limit: { type: "string" },
    })
    const client = c.client()
    const file = values["cursor-file"]
    let cursor: string | null =
      file && existsSync(file) ? readFileSync(file, "utf8").trim() || null : null
    const interval = Number(values.interval ?? 2) * 1000
    for (;;) {
      const page = await client.changes(cursor, Number(values.limit ?? 200))
      for (const e of page.events) {
        if (!c.out.human) c.out.ndjson(e)
        else
          c.out.line(
            `${when(e.occurredAt)}  ${e.type}${e.entity ? `  ${e.entity.name} (${e.entity.type}, ${e.entity.id})` : ""}`
          )
      }
      if (page.cursor && page.cursor !== cursor) {
        cursor = page.cursor
        if (file) writeFileSync(file, `${cursor}\n`)
      }
      if (page.caughtUp) {
        if (!values.follow) return
        await c.io.sleep(interval)
      }
    }
  },
}

export const reads: Record<string, Command> = { get, find, ls, lineage, events }
