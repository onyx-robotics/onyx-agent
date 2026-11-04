/** One-line writes: an item, an edge, a change to an item, archiving it. Files go to `ingest`. */
import type { IngestItem } from "../../generated/contracts/contracts"

import { itemArg, need, propArgs, unsetArgs } from "../args"
import { flags, type Command } from "../command"
import { UsageError } from "../output"
import { idOf } from "./read"

const add: Command = {
  summary: "create (or update, by source key) one item",
  usage: `onyx add <type> <name> [--source system:key] [--status <status>] [--prop key=value]...
         [--summary <text>] [--space <space>] [--started-at <iso>] [--ended-at <iso>]

With --source the item is upserted by that key: running it again updates it, never duplicates.`,
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      source: { type: "string" },
      status: { type: "string" },
      prop: { type: "string", multiple: true },
      summary: { type: "string" },
      space: { type: "string" },
      "started-at": { type: "string" },
      "ended-at": { type: "string" },
    })
    const [type, ...words] = positionals
    const item: IngestItem = {
      type: need(type, "the item's type"),
      name: need(words.join(" ") || undefined, "the item's name"),
      ...(values.status ? { status: values.status } : {}),
      ...(values.summary ? { summary: values.summary } : {}),
      ...(values.space ? { space: values.space } : {}),
      ...(values["started-at"] ? { startedAt: values["started-at"] } : {}),
      ...(values["ended-at"] ? { endedAt: values["ended-at"] } : {}),
      ...(values.prop?.length ? { props: propArgs(values.prop) } : {}),
    }
    if (values.source) {
      const ref = itemArg(values.source, "--source")
      if (!("source" in ref)) throw new UsageError("--source is a source key: system:key")
      item.source = ref.source
    }
    const r = await c.client().ingest({ items: [item] })
    const id = r.itemIds[0]!
    const what = r.items.created ? "created" : r.items.updated ? "updated" : "unchanged"
    const { url } = c.app(`items/${id}`)
    if (c.out.human) {
      c.out.line(`${what} ${item.type} ${id}`)
      c.out.line(`see it: ${url}`)
    } else c.out.json({ id, [what]: true, txid: r.txid, url })
  },
}

const link: Command = {
  summary: "add an edge: link <item> <relation> <item>",
  usage: `onyx link <item> <relation> <item> [--pin] [--valid-from <iso>] [--replace]
         [--assertion declared|observed|inferred] [--confidence <0-1>]

--pin points at the target identity's head revision (and seals it). --replace closes the
source's other current edges of the relation first (a reassignment). Linking again is a no-op.`,
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      pin: { type: "boolean" },
      "valid-from": { type: "string" },
      replace: { type: "boolean" },
      assertion: { type: "string" },
      confidence: { type: "string" },
    })
    const [src, rel, dst] = positionals
    if (positionals.length > 3) throw new UsageError("link <item> <relation> <item>")
    const r = await c.client().link({
      src: itemArg(src, "source item"),
      rel: need(rel, "the relation"),
      dst: itemArg(dst, "target item"),
      ...(values.pin ? { pin: true } : {}),
      ...(values.replace ? { replaceCurrent: true } : {}),
      ...(values["valid-from"] ? { validFrom: values["valid-from"] } : {}),
      ...(values.assertion ? { assertion: values.assertion as never } : {}),
      ...(values.confidence ? { confidence: Number(values.confidence) } : {}),
    })
    const what = r.edges.created ? "linked" : "already linked"
    if (c.out.human)
      c.out.line(`${what}${r.edges.closed ? ` (closed ${r.edges.closed} it replaced)` : ""}`)
    else c.out.json({ created: r.edges.created > 0, closed: r.edges.closed, txid: r.txid })
  },
}

const unlink: Command = {
  summary: "close the current edge: unlink <item> <relation> <item>",
  usage: `onyx unlink <item> <relation> <item> [--retract | --ended]

The edge stays in history; it stops being current. By default a temporal relation (an
assignment) has ended and any other was recorded in error (retracted); --retract or --ended says
which. An edge made with --pin points at the revision that was the head then: name that.`,
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      retract: { type: "boolean" },
      ended: { type: "boolean" },
    })
    if (values.retract && values.ended) throw new UsageError("--retract or --ended, not both")
    const [src, rel, dst] = positionals
    if (positionals.length > 3) throw new UsageError("unlink <item> <relation> <item>")
    const r = await c.client().unlink({
      src: itemArg(src, "source item"),
      rel: need(rel, "the relation"),
      dst: itemArg(dst, "target item"),
      ...(values.retract ? { kind: "retracted" as const } : {}),
      ...(values.ended ? { kind: "ended" as const } : {}),
    })
    if (c.out.human) c.out.line(`closed edge ${r.edge}`)
    else c.out.json(r)
  },
}

const set: Command = {
  summary: "change an item: name, status, summary, space, props",
  usage: `onyx set <item> [--name <name>] [--status <status>] [--summary <text>] [--space <space>]
         [--prop key=value]... [--unset key]... [--started-at <iso>] [--ended-at <iso>]
         [--expected-version <n>]

Props are merged; --unset removes one. --expected-version refuses the change (conflict) if the
item changed since that version.`,
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      name: { type: "string" },
      status: { type: "string" },
      summary: { type: "string" },
      space: { type: "string" },
      prop: { type: "string", multiple: true },
      unset: { type: "string", multiple: true },
      "started-at": { type: "string" },
      "ended-at": { type: "string" },
      "expected-version": { type: "string" },
    })
    const client = c.client()
    const id = await idOf(c, client, positionals[0])
    const props = { ...propArgs(values.prop), ...unsetArgs(values.unset) }
    const patch = {
      ...(values.name ? { name: values.name } : {}),
      ...(values.status ? { status: values.status } : {}),
      ...(values.summary !== undefined ? { summary: values.summary } : {}),
      ...(values.space ? { space: values.space } : {}),
      ...(values["started-at"] ? { startedAt: values["started-at"] } : {}),
      ...(values["ended-at"] ? { endedAt: values["ended-at"] } : {}),
      ...(Object.keys(props).length ? { props } : {}),
      ...(values["expected-version"]
        ? { expectedVersion: Number(values["expected-version"]) }
        : {}),
    }
    if (!Object.keys(patch).length) throw new UsageError("nothing to change (onyx help set)")
    const row = (await client.updateEntity(id, patch)) as { row_version?: number }
    if (c.out.human)
      c.out.line(`updated ${id}${row.row_version ? ` (version ${row.row_version})` : ""}`)
    else c.out.json(row)
  },
}

const archive: Command = {
  summary: "archive an item (it stays in history)",
  usage: "onyx archive <item>",
  async run(c) {
    const { positionals } = flags(c.argv, {})
    const client = c.client()
    const id = await idOf(c, client, positionals[0])
    await client.archive(id)
    if (c.out.human) c.out.line(`archived ${id}`)
    else c.out.json({ id, archived: true })
  },
}

export const writes: Record<string, Command> = { add, link, unlink, set, archive }
