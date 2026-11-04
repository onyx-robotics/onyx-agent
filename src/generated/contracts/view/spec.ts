// Generated from packages/core/src/view/spec.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * ViewSpec: what the research graph shows. Browser-safe. Semantics: docs/SEMANTICS.md.
 */
import { z } from "zod"

const uuid = z.string().uuid()
const iso = z.string().datetime({ offset: true })

export const STATUS_FILTERS = [
  "pending",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "none",
] as const
export const BUCKETS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "1d": 86_400_000,
  "7d": 604_800_000,
  "28d": 2_419_200_000,
} as const
export type BucketKey = keyof typeof BUCKETS
/** date_bin origin: a Monday, so 7d buckets are calendar weeks */
export const BUCKET_ORIGIN_MS = Date.UTC(2000, 0, 3)
export const RELATIVE_WINDOWS = {
  "1d": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  "90d": 7_776_000_000,
  "365d": 31_536_000_000,
} as const

/** A facet node: `key` is the node's value key (entity id, or the dictionary key of a literal). */
export const nodeRef = z.union([
  z
    .object({
      dim: z.string().min(1),
      key: z.string().min(1),
      mode: z.enum(["rollup", "direct"]).default("rollup"),
    })
    .strict(),
  z.object({ dim: z.string().min(1), none: z.literal(true) }).strict(),
])
export type NodeRef = z.output<typeof nodeRef>
export type NodeRefInput = z.input<typeof nodeRef>

/** A combination of conditions: every `all` ref, and at least one ref of each `any` group. */
export const viewWhere = z.object({
  all: z.array(nodeRef).default([]),
  any: z.array(z.array(nodeRef).min(1)).default([]),
})
export type ViewWhere = z.output<typeof viewWhere>
export type ViewWhereInput = z.input<typeof viewWhere>

/**
 * Budgets of pinned lanes and lane groups (docs/SEMANTICS.md, "Budget"): lanes and groups per
 * view, conditions per lane and in all, the lanes they can show (checked before anything is
 * counted) and the lane x bucket cells with items (what a view's response and its live copy hold,
 * checked once counted).
 */
export const MAX_PINNED = 50
export const MAX_GROUPS = 64
export const MAX_LANE_REFS = 16
export const MAX_LANE_REFS_TOTAL = 400
export const MAX_CANDIDATE_LANES = 20_000
export const MAX_LANE_CELLS = 100_000

export const refCount = (w: ViewWhereInput) =>
  (w.all?.length ?? 0) + (w.any ?? []).reduce((n, g) => n + g.length, 0)

/** A lane of the items matching `where`, whatever the columns show. */
export const pinnedLane = z.object({
  /** shown instead of the conditions */
  label: z.string().trim().min(1).max(200).optional(),
  where: viewWhere.refine(
    (w) => refCount(w) <= MAX_LANE_REFS,
    `a lane has at most ${MAX_LANE_REFS} conditions`
  ),
})
export type PinnedLane = z.output<typeof pinnedLane>
export type PinnedLaneInput = z.input<typeof pinnedLane>

/**
 * Under each lane of a group (each value a of its dim), a lane per value b of another dim among
 * a's items: B's roots, or the children of `parent` (and its own lane). B has at most 300 values
 * there. `except`: lane keys of the group whose pairs aren't counted.
 */
export const laneSub = z.object({
  dim: z.string().min(1),
  /** value key of a node of `dim` */
  parent: z.string().min(1).optional(),
  except: z.array(z.string().min(1)).max(500).default([]),
})
export type LaneSub = z.output<typeof laneSub>

/**
 * A lane per value of `dim` among the items matching `where`: the dim's roots, or the children of
 * `parent` (with a lane for items attached to the parent itself). A dim with over 300 values
 * shows its `limit` busiest, the rest as Other (none with `other: false`).
 */
export const laneGroup = z.object({
  /** shown instead of the conditions */
  label: z.string().trim().min(1).max(200).optional(),
  where: viewWhere.refine(
    (w) => refCount(w) <= MAX_LANE_REFS,
    `a group has at most ${MAX_LANE_REFS} conditions`
  ),
  dim: z.string().min(1),
  /** value key of a node of `dim` */
  parent: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  /** a big dim's values beyond `limit` as an Other lane */
  other: z.boolean().default(true),
  /** a lane per value of another dim under each of its lanes */
  sub: laneSub.optional(),
})
export type LaneGroup = z.output<typeof laneGroup>
export type LaneGroupInput = z.input<typeof laneGroup>

/** Refuse two lanes (or groups) with one key: the same conditions are the same lane. */
const uniqueBy =
  <T>(keyOf: (x: T) => string, what: string) =>
  (xs: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>()
    xs.forEach((x, i) => {
      const key = keyOf(x)
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `${what} twice`, path: [i] })
      seen.add(key)
    })
  }

export const dimView = z.object({
  dim: z.string().min(1),
  /** value keys of expanded tree nodes */
  expanded: z.array(z.string()).default([]),
  /** show the top N nodes by count; the rest are grouped as "other" */
  limit: z.number().int().min(1).max(500).default(50),
})

export const viewSpec = z.object({
  /** type keys (subtypes included); empty = every type */
  itemTypes: z.array(z.string()).default([]),
  /** kinds, used when itemTypes is empty */
  itemKinds: z.array(z.enum(["activity", "artifact", "asset", "concept", "agent"])).default([]),
  /** subset of the viewer's visible spaces; empty = all visible */
  spaces: z.array(uuid).default([]),
  statusClasses: z.array(z.enum(STATUS_FILTERS)).default([]),
  time: z
    .object({
      from: iso.optional(),
      to: iso.optional(),
      last: z.enum(Object.keys(RELATIVE_WINDOWS) as [keyof typeof RELATIVE_WINDOWS]).optional(),
    })
    .default({}),
  /**
   * left to right; the last column titles the lanes; several dims in a column are stacked. None
   * at all only with pinned lanes or groups (a view of lanes: checked when it's run, since
   * `viewSpec.partial()` can't carry a refinement)
   */
  columns: z.array(z.object({ dims: z.array(dimView).min(1).max(6) })).max(8),
  /** filters shrink the item set: every `all` ref, and at least one ref of each `any` group */
  filters: viewWhere.default({ all: [], any: [] }),
  /** selection highlights without filtering: OR within a column, AND across columns */
  selection: z.array(nodeRef).default([]),
  axis: z
    .object({
      mode: z.enum(["count", "time"]).default("count"),
      bucket: z.enum(Object.keys(BUCKETS) as [BucketKey]).default("7d"),
    })
    .default({ mode: "count", bucket: "7d" }),
  lanes: z
    .object({
      sort: z.enum(["count", "recent", "metric", "label"]).default("count"),
      metric: z
        .object({
          property: z.string().min(1),
          context: uuid.nullable().default(null),
          agg: z.enum(["avg", "min", "max", "latest"]).default("avg"),
        })
        .optional(),
      limit: z.number().int().min(1).max(500).default(100),
      includeNone: z.boolean().default(false),
      /** lanes of their own conditions, in this order, above the last column's lanes */
      pinned: z
        .array(pinnedLane)
        .max(MAX_PINNED)
        .superRefine(uniqueBy((l) => pinnedKey(l.where), "this lane is pinned"))
        .default([]),
      /** groups of lanes, one per value of a dim under their conditions, in this order */
      groups: z
        .array(laneGroup)
        .max(MAX_GROUPS)
        .superRefine(uniqueBy((g) => groupKey(g), "this group is pinned"))
        .default([]),
    })
    .default({ sort: "count", limit: 100, includeNone: false, pinned: [], groups: [] }),
})
export type ViewSpec = z.output<typeof viewSpec>
export type ViewSpecInput = z.input<typeof viewSpec>

/**
 * How a live client refetches a view (resync.ts): `after`, comma-separated txids the view must
 * include (a shared view that excludes one isn't served); `within`, how long ago at most a shared
 * view may have been computed, in ms (the time since the client joined its topics: a view computed
 * before that isn't served); `fresh`, compute it for this request.
 */
export const viewFetchQuery = z.object({
  after: z
    .string()
    .regex(/^\d{1,20}(,\d{1,20}){0,63}$/, "comma-separated transaction ids, at most 64")
    .transform((s) => s.split(","))
    .optional(),
  within: z.coerce.number().int().min(0).max(86_400_000).optional(),
  fresh: z
    .enum(["1", "true"])
    .transform(() => true)
    .optional(),
})

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
    )
  }
  return v
}

/** Normalised spec: defaults applied, set-like arrays sorted, so equal views hash equally. */
export function canonicalSpec(input: ViewSpecInput): ViewSpec {
  const s = viewSpec.parse(input)
  const sortedRefs = (xs: NodeRef[]) =>
    [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return {
    ...s,
    itemTypes: [...s.itemTypes].sort(),
    itemKinds: [...s.itemKinds].sort(),
    spaces: [...s.spaces].sort(),
    statusClasses: [...s.statusClasses].sort(),
    columns: s.columns.map((c) => ({
      dims: c.dims.map((d) => ({ ...d, expanded: [...d.expanded].sort() })),
    })),
    filters: { all: sortedRefs(s.filters.all), any: s.filters.any.map(sortedRefs) },
    selection: sortedRefs(s.selection),
    // pinned lanes keep their order: it's the order they're shown in
    lanes: {
      ...s.lanes,
      pinned: s.lanes.pinned.map((l) => ({ ...l, where: canonicalWhere(l.where) })),
      groups: s.lanes.groups.map((g) => ({
        ...g,
        where: canonicalWhere(g.where),
        ...(g.sub ? { sub: { ...g.sub, except: [...new Set(g.sub.except)].sort() } } : {}),
      })),
    },
  }
}

/** FNV-1a 64-bit, as 16 hex digits. */
export function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, "0")
}

/** FNV-1a 64-bit of the canonical JSON: a stable cache / query key. */
export function specHash(input: ViewSpecInput): string {
  return fnv64(JSON.stringify(canonical(canonicalSpec(input))))
}

const normRef = (r: NodeRefInput): NodeRef =>
  "none" in r ? { dim: r.dim, none: true } : { dim: r.dim, key: r.key, mode: r.mode ?? "rollup" }
const refText = (r: NodeRef) => JSON.stringify(r)
const sortedUnique = (xs: NodeRef[]) =>
  [...new Map(xs.map((r) => [refText(r), r])).values()].sort((a, b) =>
    refText(a).localeCompare(refText(b))
  )

/**
 * A combination of conditions in one form: refs deduplicated and sorted, an `any` group of one
 * ref is an `all` ref, groups sorted. Equal combinations have equal forms (and keys).
 */
export function canonicalWhere(w: ViewWhereInput): ViewWhere {
  const groups = (w.any ?? []).map((g) => sortedUnique(g.map(normRef)))
  const any = [
    ...new Map(
      groups.filter((g) => g.length > 1).map((g) => [JSON.stringify(g), g] as const)
    ).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return {
    all: sortedUnique([
      ...(w.all ?? []).map(normRef),
      ...groups.filter((g) => g.length === 1).flat(),
    ]),
    any,
  }
}

/** A pinned lane's key: the same conditions are the same lane, wherever it's placed. */
export const pinnedKey = (w: ViewWhereInput) => `p:${fnv64(JSON.stringify(canonicalWhere(w)))}`

/** A group's key: its conditions, dim and parent. Its lanes' keys start with it. */
export const groupKey = (g: Pick<LaneGroupInput, "where" | "dim" | "parent" | "sub">) =>
  `g:${fnv64(
    JSON.stringify([
      canonicalWhere(g.where),
      g.dim,
      g.parent ?? null,
      // a group without a sub-dimension keeps the key it always had
      ...(g.sub ? [[g.sub.dim, g.sub.parent ?? null]] : []),
    ])
  )}`

/** The selection as conditions: OR within a column (or a dim outside the columns), AND across. */
export function selectionWhere(spec: Pick<ViewSpecInput, "columns" | "selection">): ViewWhere {
  const colOf = new Map<string, number>()
  spec.columns.forEach((c, i) => c.dims.forEach((d) => colOf.set(d.dim, i)))
  const groups = new Map<string, NodeRef[]>()
  for (const r of (spec.selection ?? []).map(normRef)) {
    const g = String(colOf.get(r.dim) ?? `dim:${r.dim}`)
    groups.set(g, [...(groups.get(g) ?? []), r])
  }
  return canonicalWhere({ any: [...groups.values()] })
}

/**
 * The absolute time window a spec covers at `now`; on a time axis, widened to whole buckets
 * (`alignWindow`).
 */
export function resolveTime(
  spec: ViewSpec,
  now: number
): { from: number | null; to: number | null } {
  const w = spec.time.last
    ? { from: now - RELATIVE_WINDOWS[spec.time.last], to: null }
    : {
        from: spec.time.from ? Date.parse(spec.time.from) : null,
        to: spec.time.to ? Date.parse(spec.time.to) : null,
      }
  return spec.axis.mode === "time" ? alignWindow(w, BUCKETS[spec.axis.bucket]) : w
}

/**
 * A window widened to whole buckets: its start down to the start of its bucket, its end (when it
 * has one) up to the start of the next (docs/SEMANTICS.md, "Item set U").
 */
export function alignWindow(
  w: { from: number | null; to: number | null },
  bucketMs: number,
  originMs = BUCKET_ORIGIN_MS
): { from: number | null; to: number | null } {
  return {
    from: w.from === null ? null : binStart(w.from, bucketMs, originMs),
    to: w.to === null ? null : binStart(w.to - 1, bucketMs, originMs) + bucketMs,
  }
}

export function binStart(t: number, bucketMs: number, originMs = BUCKET_ORIGIN_MS): number {
  return originMs + Math.floor((t - originMs) / bucketMs) * bucketMs
}
