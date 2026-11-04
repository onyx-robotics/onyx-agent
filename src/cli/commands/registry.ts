/**
 * The org's vocabulary, and its own pack as code: show it, check a pack offline, pull one back,
 * plan a change (what it would do), apply it (what was planned, or nothing).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { BUILTIN_PACKS, checkPack, namespaceIssues } from "../../generated/contracts/packs"
import type { PackPlan } from "../../sdk"
import { stringify } from "yaml"

import { flags, type Command, type Context } from "../command"
import { CliError, EXIT, UsageError, type Out } from "../output"

interface RawRegistry {
  version: number
  types: {
    id: number
    key: string
    kind: string
    parentId: number | null
    label: string
    description: string | null
    statuses: { status: string; class: string | null }[]
    properties: { propertyId: number; required: boolean }[]
    comparisonRole: string
  }[]
  relations: {
    id: number
    key: string
    label: string
    inverseLabel: string
    parentId: number | null
    srcKinds: string[] | null
    dstKinds: string[] | null
    isHierarchy: boolean
    isLineage: boolean
    isTemporal: boolean
    isEvidence: boolean
    maxCurrentOut: number | null
    description: string | null
  }[]
  properties: {
    id: number
    key: string
    label: string
    valueType: string
    unit: string | null
    enumValues: string[] | null
    isMetric: boolean
    isInput: boolean
    better: string | null
    description: string | null
  }[]
  dims: {
    key: string
    label: string
    source: string
    propertyId: number | null
    rollupRelId: number | null
    paths: number[][]
    description: string | null
  }[]
}

/** The vocabulary by key, not database id: what an agent reads before it writes. */
export function compactRegistry(r: RawRegistry) {
  const type = new Map(r.types.map((t) => [t.id, t.key]))
  const rel = new Map(r.relations.map((x) => [x.id, x.key]))
  const prop = new Map(r.properties.map((p) => [p.id, p.key]))
  const drop = <T extends object>(o: T) =>
    Object.fromEntries(
      Object.entries(o).filter(
        ([, v]) => v !== null && v !== false && !(Array.isArray(v) && !v.length)
      )
    )
  return {
    version: r.version,
    types: r.types.map((t) =>
      drop({
        key: t.key,
        kind: t.kind,
        parent: t.parentId === null ? null : type.get(t.parentId),
        label: t.label,
        statuses: t.statuses.map((s) => (s.class ? `${s.status} (${s.class})` : s.status)),
        properties: t.properties.map((p) => `${prop.get(p.propertyId)}${p.required ? "!" : ""}`),
        comparison: t.comparisonRole === "subject" ? "subject" : null,
        description: t.description,
      })
    ),
    relations: r.relations.map((x) =>
      drop({
        key: x.key,
        label: x.label,
        inverse: x.inverseLabel,
        parent: x.parentId === null ? null : rel.get(x.parentId),
        from: x.srcKinds,
        to: x.dstKinds,
        hierarchy: x.isHierarchy,
        lineage: x.isLineage,
        temporal: x.isTemporal,
        evidence: x.isEvidence,
        maxCurrentOut: x.maxCurrentOut,
        description: x.description,
      })
    ),
    properties: r.properties.map((p) =>
      drop({
        key: p.key,
        label: p.label,
        type: p.valueType,
        unit: p.unit,
        values: p.enumValues,
        metric: p.isMetric,
        input: p.isInput,
        better: p.better,
        description: p.description,
      })
    ),
    dims: r.dims.map((d) =>
      drop({
        key: d.key,
        label: d.label,
        property: d.propertyId === null ? null : prop.get(d.propertyId),
        paths: d.paths.map((p) =>
          p.map((s) => (s < 0 ? `~${rel.get(-s)}` : rel.get(s))).join(" > ")
        ),
        rollup: d.rollupRelId === null ? null : rel.get(d.rollupRelId),
        builtin: d.source !== "relation" && d.source !== "property",
        description: d.description,
      })
    ),
  }
}

const SECTIONS = { types: "types", relations: "relations", props: "properties", dims: "dims" }

async function registryShow(c: Context, args: string[]) {
  const [section, key] = args
  if (section && !(section in SECTIONS) && !key) {
    // `registry show <key>`: one definition, whichever section it's in
    return registryShow(c, ["", section])
  }
  const reg = compactRegistry((await c.client().registry()) as unknown as RawRegistry)
  const parts = section
    ? [SECTIONS[section as keyof typeof SECTIONS]]
    : (Object.values(SECTIONS) as (keyof typeof reg)[])
  if (key) {
    const found = Object.values(SECTIONS)
      .flatMap((s) => (reg[s as "types"] as { key: string }[]).map((d) => ({ what: s, ...d })))
      .filter((d) => d.key === key)
    if (!found.length) throw new UsageError(`nothing in the registry is called ${key}`)
    return void c.out.json(found.length === 1 ? found[0] : found)
  }
  if (!c.out.human)
    return void c.out.json(
      section ? { version: reg.version, [parts[0]!]: reg[parts[0] as "types"] } : reg
    )
  c.out.line(`registry v${reg.version}`)
  for (const p of parts) {
    c.out.line(`\n${p}`)
    if (p === "types")
      c.out.table(
        ["key", "kind", "parent", "label"],
        reg.types.map((t) => [t.key, t.kind, t.parent as string, t.label])
      )
    if (p === "relations")
      c.out.table(
        ["key", "from", "to", "label"],
        reg.relations.map((r) => [
          r.key,
          ((r.from as string[]) ?? ["any"]).join(","),
          ((r.to as string[]) ?? ["any"]).join(","),
          r.label,
        ])
      )
    if (p === "properties")
      c.out.table(
        ["key", "type", "unit", "metric", "label"],
        reg.properties.map((x) => [
          x.key,
          x.type,
          x.unit as string,
          x.metric ? `yes${x.better ? ` (${x.better} is better)` : ""}` : "",
          x.label,
        ])
      )
    if (p === "dims")
      c.out.table(
        ["key", "from", "label"],
        reg.dims.map((d) => [
          d.key,
          (d.property as string) ?? ((d.paths as string[]) ?? []).join(" | ") ?? "",
          d.label,
        ])
      )
  }
}

/** A pack argument: a file's text, or a built-in pack by name (the server has its text). */
function packInputs(args: string[]): { name: string; input: string }[] {
  if (!args.length) throw new UsageError("which packs? give their files (or built-in pack names)")
  return args.map((a) => {
    if (existsSync(a)) return { name: a, input: readFileSync(a, "utf8") }
    if (Object.hasOwn(BUILTIN_PACKS, a)) return { name: a, input: a }
    throw new UsageError(`no file ${a}`)
  })
}

const SIGN: Record<string, string> = {
  added: "+",
  changed: "~",
  restated: "=",
  dropped: "-",
  refused: "!",
  blocked: "?",
}

/** A plan for a person: each pack, what changes in it, the rebuild, the refusals. */
function showPlan(out: Out, plan: PackPlan) {
  const entries = plan.entries.filter((e) => e.change !== "unchanged")
  const width = Math.max(0, ...entries.map((e) => e.key.length))
  for (const p of plan.packs) {
    const versions =
      p.from === null
        ? `(new) -> ${p.to}`
        : p.changed
          ? `${p.from} -> ${p.to}`
          : `${p.to} (unchanged)`
    out.line(`pack ${p.pack}  ${versions}   (registry v${plan.registryVersion})`)
    for (const e of entries.filter((x) => x.pack === p.pack))
      out.line(
        `  ${SIGN[e.change]} ${e.what.padEnd(8)}  ${e.key.padEnd(width)}  ${
          e.change === "blocked"
            ? `blocked: ${e.detail}`
            : e.change === "restated" && !e.detail
              ? "restated"
              : (e.detail ?? "")
        }`.trimEnd()
      )
  }
  const others = plan.issues.filter(
    (i) => !plan.entries.some((e) => e.change === "refused" && e.detail === i.message)
  )
  for (const i of others) out.line(`  ! ${i.path ? `${i.path}: ` : ""}${i.message}`)
  const r = plan.rebuild
  if (r.needed)
    out.line(
      `rebuild: ${r.items.toLocaleString("en")} item${r.items === 1 ? "" : "s"}, ${r.mode === "background" ? "in a background job" : r.mode === "in_transaction" ? "in the transaction" : "none needed (no items)"} (${r.reasons.join("; ")})`
    )
  const n = plan.issues.length
  if (n) out.line(`${n} refusal${n === 1 ? "" : "s"}: nothing would be applied`)
  else if (!plan.packs.some((p) => p.changed)) out.line("no changes")
}

const changes = (plan: PackPlan) => plan.packs.some((p) => p.changed)

async function registryCheck(c: Context, args: string[]) {
  if (!args.length) throw new UsageError("which pack files?")
  const results = args.map((file) => {
    if (!existsSync(file)) throw new UsageError(`no file ${file}`)
    const r = checkPack(readFileSync(file, "utf8"))
    const issues = "pack" in r ? namespaceIssues(r.pack, BUILTIN_PACKS) : r.issues
    return {
      file,
      ...("pack" in r ? { pack: r.pack.key, version: r.pack.version } : {}),
      ok: !issues.length,
      issues,
      counts:
        "pack" in r
          ? {
              types: r.pack.types.length,
              relations: r.pack.relations.length,
              properties: r.pack.properties.length,
              dims: r.pack.dims.length,
            }
          : undefined,
    }
  })
  const bad = results.flatMap((r) =>
    r.issues.map((i) => ({ path: `${r.file}${i.path ? ` ${i.path}` : ""}`, message: i.message }))
  )
  if (bad.length)
    throw new CliError(
      `${bad.length} problem${bad.length === 1 ? "" : "s"}`,
      EXIT.invalid,
      bad,
      "validation_failed"
    )
  if (!c.out.human) return void c.out.json(results)
  for (const r of results)
    c.out.line(
      `ok  ${r.file}: pack ${r.pack} ${r.version} (${r.counts!.types} types, ${r.counts!.relations} relations, ${r.counts!.properties} properties, ${r.counts!.dims} dims)`
    )
}

async function registryPull(c: Context, args: string[], out?: string) {
  const [key] = args
  if (!key) throw new UsageError("which pack? onyx registry pull <pack key>")
  const p = await c.client().getPack(key)
  // as its author wrote it, when it was loaded as text
  const text = p.source ?? stringify(p.body)
  if (out) {
    writeFileSync(out, text)
    if (c.out.human) c.out.note(`wrote pack ${p.key} ${p.version} to ${out}`)
    else c.out.json({ key: p.key, version: p.version, file: out })
  } else if (c.jsonAsked) c.out.json(p)
  else c.io.stdout(text.endsWith("\n") ? text : `${text}\n`)
}

async function registryPlan(c: Context, args: string[], detailed: boolean) {
  const plan = await c.client().planPacks(packInputs(args).map((p) => p.input))
  if (c.out.human) showPlan(c.out, plan)
  else c.out.json(plan)
  if (plan.issues.length) return EXIT.invalid
  return detailed && changes(plan) ? EXIT.changes : EXIT.ok
}

async function registryApply(c: Context, args: string[], yes: boolean, wait: boolean) {
  const client = c.client()
  const inputs = packInputs(args).map((p) => p.input)
  const plan = await client.planPacks(inputs)
  if (c.out.human) showPlan(c.out, plan)
  if (plan.issues.length)
    throw new CliError(
      `${plan.issues.length} refusal${plan.issues.length === 1 ? "" : "s"}: nothing was applied`,
      EXIT.invalid,
      plan.issues.map((i) => ({ path: i.path, message: i.message })),
      "validation_failed"
    )
  if (!changes(plan)) {
    if (!c.out.human) c.out.json({ applied: false, plan })
    return
  }
  if (!yes) {
    const answer = await c.io.prompt("Apply this plan? [y/N] ")
    if (answer === null) throw new UsageError("not at a terminal: --yes applies without asking")
    if (!/^y(es)?$/i.test(answer)) {
      c.out.line("not applied")
      return
    }
  }
  const r = await client.applyPacks(inputs, { expectedRegistryVersion: plan.registryVersion })
  if (c.out.human)
    c.out.line(
      `applied: registry v${r.registryVersion}${r.rebuilt ? ", serving rows rebuilt" : r.rebuildPending ? ", serving rows being rebuilt in the background" : ""}`
    )
  if (wait && r.rebuildPending) {
    const until = Date.now() + 30 * 60_000
    for (;;) {
      const reg = await client.registry()
      if (!reg.rebuilding) break
      if (Date.now() > until)
        throw new CliError("still rebuilding after 30 minutes", EXIT.unavailable)
      await c.io.sleep(2000)
    }
    if (c.out.human) c.out.line("rebuild done")
  }
  if (!c.out.human) c.out.json({ applied: true, ...r })
}

export const registry: Command = {
  summary: "the vocabulary, and the org's pack as code: show, check, pull, plan, apply",
  usage: `onyx registry show [types|relations|props|dims] [key]
onyx registry check <file>...
onyx registry pull <pack> [--out <file>]
onyx registry plan <file | built-in pack>... [--detailed-exitcode]
onyx registry apply <file | built-in pack>... [--yes] [--wait]

show     types, relations, properties and dimensions by key (JSON: compact, for agents to read
         before they write); a key alone shows that definition
check    a pack file offline: its format and its namespace (no org needed)
pull     a loaded pack as it was loaded (YAML as written), to keep in a repo
plan     what loading packs would do: + added, ~ changed, = restated, - dropped (kept in the
         registry), ! refused, ? blocked, and the rebuild. Writes nothing; writes go on while it
         runs. Exit 3 when something is refused; with --detailed-exitcode, 8 when it changes
         something and 0 when not (for CI)
apply    plan, ask, then load what was planned (refused if the registry moved since: plan
         again). --yes skips the question (needed off a terminal); --wait follows a large
         org's rebuild to its end. Admins, with a token that has the admin scope`,
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      out: { type: "string" },
      "detailed-exitcode": { type: "boolean" },
      yes: { type: "boolean" },
      wait: { type: "boolean" },
    })
    const [sub, ...rest] = positionals
    if (sub === "show") return registryShow(c, rest)
    if (sub === "check") return registryCheck(c, rest)
    if (sub === "pull") return registryPull(c, rest, values.out)
    if (sub === "plan") return registryPlan(c, rest, values["detailed-exitcode"] === true)
    if (sub === "apply") return registryApply(c, rest, values.yes === true, values.wait === true)
    throw new UsageError(`unknown: registry ${sub ?? ""} (onyx help registry)`)
  },
}
