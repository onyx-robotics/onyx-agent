// Generated from packages/core/src/registry/pack-format.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Domain pack format. A pack is YAML (or JSON) describing part of an org's ontology: entity
 * types, relation types, properties and facet dimensions. Packs are loaded per org, idempotently;
 * the same definition may appear in several packs, a conflicting one is an error.
 *
 * Namespaces: the built-in packs (packs/) define flat keys (`experiment`, `used`); an org's own
 * pack names what it defines `<pack>.<key>` (`acme.torque_test`), so a later built-in key can
 * never collide with it. A custom pack may restate a flat, built-in definition (to add
 * properties to `experiment`, say) but not create one (load-pack.ts).
 *
 * Server-free (zod and yaml only): the CLI checks a pack offline with it (`@onyx/core/packs`).
 */
import { parse as parseYaml } from "yaml"
import { z } from "zod"

const NAME = "[a-z][a-z0-9_]*"
/** a pack's own key, and status labels: flat */
const flatKey = z
  .string()
  .regex(
    new RegExp(`^${NAME}$`),
    "lowercase letters, digits and underscores, starting with a letter"
  )
/** a definition: flat (built-in) or `<pack>.<key>` */
export const QUALIFIED_KEY = new RegExp(`^(${NAME}\\.)?${NAME}$`)
const key = z
  .string()
  .regex(
    QUALIFIED_KEY,
    "lowercase letters, digits and underscores, starting with a letter; a custom pack's own as <pack>.<key>"
  )
const kind = z.enum(["activity", "artifact", "asset", "concept", "agent"])
const statusClass = z.enum([
  "pending",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
])

export const packTypeSchema = z.object({
  key,
  kind,
  label: z.string().min(1),
  parent: key.optional(),
  description: z.string().optional(),
  /** status label -> engine status class (null for non-lifecycle labels). Subtypes inherit. */
  statuses: z.record(flatKey, statusClass.nullable()).optional(),
  /** property keys used by this type; `key!` marks a required property */
  properties: z.array(z.string().regex(new RegExp(`^(${NAME}\\.)?${NAME}!?$`))).optional(),
  /**
   * in baseline comparisons: `subject` for what's being changed (a model, a controller, code),
   * which may differ; `condition` (the default) for what must match (datasets, protocols)
   */
  comparison: z.enum(["subject", "condition"]).optional(),
})

export const packRelationSchema = z.object({
  key,
  label: z.string().min(1),
  inverse: z.string().min(1),
  parent: key.optional(),
  src_kinds: z.array(kind).optional(),
  dst_kinds: z.array(kind).optional(),
  hierarchy: z.boolean().optional(),
  lineage: z.boolean().optional(),
  temporal: z.boolean().optional(),
  /**
   * what an activity used or was evaluated with: an artifact it points at is sealed, and
   * baselines compare it. Sub-relations inherit it.
   */
  evidence: z.boolean().optional(),
  max_current_out: z.number().int().positive().optional(),
  description: z.string().optional(),
})

export const packPropertySchema = z
  .object({
    key,
    label: z.string().min(1),
    type: z.enum(["text", "number", "integer", "boolean", "timestamp", "enum", "json"]),
    unit: z.string().optional(),
    values: z.array(z.string().min(1)).optional(),
    metric: z.boolean().optional(),
    input: z.boolean().optional(),
    better: z.enum(["higher", "lower"]).optional(),
    description: z.string().optional(),
  })
  .refine((p) => p.type !== "enum" || (p.values?.length ?? 0) > 0, "enum properties need values")
  .refine((p) => p.type === "enum" || p.values === undefined, "only enum properties have values")
  .refine(
    (p) => !p.metric || p.type === "number" || p.type === "integer",
    "metrics must be numeric"
  )
  .refine(
    (p) => p.better === undefined || (p.metric && !p.input),
    "only a metric that isn't an input has a better direction"
  )

/** A step is a relation key; `~key` follows the relation backwards (dst -> src). */
const pathStep = z.string().regex(new RegExp(`^~?(${NAME}\\.)?${NAME}$`))

export const packDimSchema = z
  .object({
    key,
    label: z.string().min(1),
    description: z.string().optional(),
    /** relation-backed: one or more paths of 1–3 steps from the item to the value */
    paths: z.array(z.array(pathStep).min(1).max(3)).min(1).optional(),
    /** hierarchy relation that values roll up through */
    rollup: key.optional(),
    /** property-backed: an enum, boolean or integer property */
    property: key.optional(),
    ordinal: z.number().int().min(-32768).max(32767).optional(),
  })
  .refine(
    (d) => (d.paths === undefined) !== (d.property === undefined),
    "a dim has either paths or a property"
  )
  .refine((d) => d.rollup === undefined || d.paths !== undefined, "rollup applies to relation dims")

export const packSchema = z.object({
  key: flatKey,
  version: z.union([z.string(), z.number()]).transform(String),
  label: z.string().optional(),
  description: z.string().optional(),
  requires: z.array(flatKey).optional(),
  types: z.array(packTypeSchema).default([]),
  relations: z.array(packRelationSchema).default([]),
  properties: z.array(packPropertySchema).default([]),
  dims: z.array(packDimSchema).default([]),
})

export type DomainPack = z.infer<typeof packSchema>
export type PackType = z.infer<typeof packTypeSchema>
export type PackRelation = z.infer<typeof packRelationSchema>
export type PackProperty = z.infer<typeof packPropertySchema>
export type PackDim = z.infer<typeof packDimSchema>

export interface PackIssue {
  path: string
  message: string
}

/** A pack read and checked: the pack, or every problem with it. */
export function checkPack(input: string | unknown): { pack: DomainPack } | { issues: PackIssue[] } {
  let raw: unknown
  try {
    raw = typeof input === "string" ? parseYaml(input) : input
  } catch (e) {
    return { issues: [{ path: "", message: `not YAML: ${(e as Error).message}` }] }
  }
  const result = packSchema.safeParse(raw)
  if (!result.success)
    return {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    }
  const pack = result.data
  const issues: PackIssue[] = []
  const dupes = (xs: { key: string }[]) =>
    xs.map((x) => x.key).filter((k, i, all) => all.indexOf(k) !== i)
  for (const [what, xs] of [
    ["type", pack.types],
    ["relation", pack.relations],
    ["property", pack.properties],
    ["dim", pack.dims],
  ] as const) {
    const d = dupes(xs)
    if (d.length)
      issues.push({
        path: `${what}s`,
        message: `duplicate ${what} keys in pack ${pack.key}: ${d.join(", ")}`,
      })
  }
  return issues.length ? { issues } : { pack }
}

/**
 * The namespace rules a pack can be held to without an org (the loader checks the rest): an
 * org's own pack can't take a built-in pack's key, and a flat key it uses must be a built-in
 * definition (it restates it). A key prefixed by another pack must exist in the org: not
 * checked here.
 */
export function namespaceIssues(
  pack: DomainPack,
  builtinPacks: Record<string, string>
): PackIssue[] {
  if (Object.hasOwn(builtinPacks, pack.key))
    return [
      {
        path: "key",
        message: `pack key ${pack.key} is a built-in pack's: name your pack something else`,
      },
    ]
  const builtin = new Set<string>()
  for (const text of Object.values(builtinPacks)) {
    const r = checkPack(text)
    if ("pack" in r)
      for (const x of [...r.pack.types, ...r.pack.relations, ...r.pack.properties, ...r.pack.dims])
        builtin.add(x.key)
  }
  const issues: PackIssue[] = []
  for (const [what, xs] of [
    ["type", pack.types],
    ["relation", pack.relations],
    ["property", pack.properties],
    ["dim", pack.dims],
  ] as const)
    for (const x of xs)
      if (!x.key.includes(".") && !builtin.has(x.key))
        issues.push({
          path: `${what}s.${x.key}`,
          message: `${what} ${x.key} is new, and a pack's own definitions are named ${pack.key}.<key>`,
        })
  return issues
}
