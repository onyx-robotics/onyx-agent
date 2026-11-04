// Generated from packages/core/src/view/tree.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Workspace trees: what a workspace was until its document's version 3 (docs/lane-series-design.md
 * §9). The root (every item), split into series by facet dims, any item split again: a series is a
 * dim under an item, a lane per value of that dim among the item's items; under a value of its own
 * hierarchy it lists that value's children (the chevron); it can split each of its values at once
 * by another dim (split siblings: pairs). Kept to read what was saved and linked as one: a document
 * of version 2 and an address of version 1 are read as the series their tree converts to
 * (series.ts `seriesFromTree`), and `compileTree` is what such a tree counted (the tests hold the
 * converted series to it).
 */
import { z } from "zod"

import {
  canonicalWhere,
  groupKey,
  MAX_GROUPS,
  MAX_LANE_REFS,
  MAX_LANE_REFS_TOTAL,
  pinnedKey,
  refCount,
  type LaneGroupInput,
  type NodeRef,
  type ViewSpecInput,
  type ViewWhere,
} from "./spec"

/** A series' busiest values shown, unless it says otherwise. */
export const SERIES_LIMIT = 50
/** Values on a path from the root (its conditions: a lane's budget is 16). */
export const TREE_DEPTH_MAX = 8
/** Series in a tree, open or not. */
export const TREE_SERIES_MAX = 200

// value keys: entity ids, and literal values' md5-based keys (not RFC 4122 uuids)
const uuid = z.guid()
const dim = z.string().min(1).max(100)

/** An item a series opens: a value, a pair (a value and its sibling split's), a parent's own lane. */
const childSchema = z.strictObject({
  /** the value key (for `direct`, the parent's) */
  value: uuid,
  /** with split siblings: the sibling split's value under `value` */
  pair: uuid.optional(),
  /** the items attached to the parent value itself (its "(direct)" lane) */
  direct: z.literal(true).optional(),
  get series(): z.ZodArray<typeof seriesSchema> {
    return z.array(seriesSchema).max(TREE_SERIES_MAX)
  },
})

const seriesSchema = z.strictObject({
  dim,
  /** counted and shown; a closed series keeps its place */
  open: z.boolean().default(true),
  /** its busiest values shown */
  limit: z.number().int().min(1).max(500).default(SERIES_LIMIT),
  /** every value split at once by another dim; `closed`: values whose pairs are folded */
  siblings: z.strictObject({ dim, closed: z.array(uuid).max(500).default([]) }).optional(),
  /**
   * what its lanes' bars show (the page's; not counted): volume (absent), on a scale its values
   * share; shape, each lane on its own; share, each value's fraction of the item it splits
   */
  mode: z.enum(["shape", "share"]).optional(),
  /** the items it opens that are split further (or kept: a pin) */
  get children(): z.ZodDefault<z.ZodArray<typeof childSchema>> {
    return z.array(childSchema).max(TREE_SERIES_MAX).default([])
  },
})

export type TreeChild = z.output<typeof childSchema>
export type Series = z.output<typeof seriesSchema>

export interface WorkspaceTree {
  series: Series[]
}

export const workspaceTree = z
  .object({ series: z.array(seriesSchema).max(TREE_SERIES_MAX).default([]) })
  .strict()
  .superRefine((t, ctx) => {
    for (const issue of treeIssues(t)) ctx.addIssue({ code: "custom", message: issue })
  })

/** What's wrong with a tree's shape (none: it can be compiled, budgets aside). */
function treeIssues(t: WorkspaceTree): string[] {
  const issues: string[] = []
  let count = 0
  const walk = (series: Series[], path: NodeRef[]) => {
    const dims = new Set<string>()
    for (const s of series) {
      count++
      if (dims.has(s.dim)) issues.push(`${s.dim} is split twice under one item`)
      dims.add(s.dim)
      if (s.siblings && s.siblings.dim === s.dim)
        issues.push(`split siblings by another dim than ${s.dim}`)
      const seen = new Set<string>()
      for (const c of s.children) {
        const id = `${c.value}|${c.pair ?? ""}|${c.direct ? 1 : 0}`
        if (seen.has(id)) issues.push(`a ${s.dim} value is listed twice`)
        if (c.pair && c.direct) issues.push("a parent's own lane has no pairs")
        seen.add(id)
        if (c.pair && !s.siblings) {
          issues.push(`a pair under ${s.dim} without split siblings`)
          continue
        }
        const next = childPath(path, s, c)
        if (next.length > TREE_DEPTH_MAX)
          issues.push(`a tree is at most ${TREE_DEPTH_MAX} values deep`)
        else walk(c.series, next)
      }
    }
  }
  walk(t.series, [])
  if (count > TREE_SERIES_MAX) issues.push(`a tree has at most ${TREE_SERIES_MAX} series`)
  return [...new Set(issues)]
}

/** The values from the root to a child of `s` (its conditions, in order). */
function childPath(path: NodeRef[], s: Series, c: TreeChild): NodeRef[] {
  return [
    ...path,
    { dim: s.dim, key: c.value, mode: c.direct ? "direct" : "rollup" },
    ...(c.pair ? [{ dim: s.siblings!.dim, key: c.pair, mode: "rollup" as const }] : []),
  ]
}

/** Where a split by `dim` is taken from under `path`: the nearest single value of it, its children. */
function parentOf(path: NodeRef[], dim: string): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const r = path[i]!
    if (r.dim === dim && !("none" in r)) return r.key
  }
  return undefined
}

/** A series' name: the path from the root (values and pairs) and its dim. */
export const seriesId = (path: NodeRef[], dimKey: string): string =>
  [
    ...path.map(
      (r) => `${r.dim}=${"none" in r ? "none" : `${r.key}${r.mode === "direct" ? "!" : ""}`}`
    ),
    dimKey,
  ].join("/")

export interface CompiledTree {
  /** what the tree counts: the root lane and a group per open series */
  spec: ViewSpecInput
  /** the root lane's key */
  root: string
  /** series id -> its group's key (open series) */
  groups: Map<string, string>
  /** what's beyond the budget: the view would be refused (docs/SEMANTICS.md, "Budget") */
  issues: string[]
}

/** What every lane of a tree counts from: the page's item set and time axis. */
export interface TreeSettings {
  itemTypes: string[]
  itemKinds: ViewSpecInput["itemKinds"]
  spaces: string[]
  statusClasses: ViewSpecInput["statusClasses"]
  time: NonNullable<ViewSpecInput["time"]>
  bucket: NonNullable<NonNullable<ViewSpecInput["axis"]>["bucket"]>
}

/**
 * Where a window without a start ("All time") is counted from: lanes on a time axis need a start,
 * and nothing a research graph holds is older. The page draws the axis from the earliest item.
 */
export const ALL_TIME_FROM = "1970-01-01T00:00:00.000Z"

/** A tree's window as its view counts it: one without a start ("All time") from `ALL_TIME_FROM`. */
export const treeTime = (time: TreeSettings["time"]): TreeSettings["time"] =>
  time.last || time.from ? time : { ...time, from: ALL_TIME_FROM }

/** A tree's view: no columns, the root lane (every item), and a group per open series. */
export function compileTree(tree: WorkspaceTree, settings: TreeSettings): CompiledTree {
  const groups = new Map<string, string>()
  const specGroups = new Map<string, LaneGroupInput>()
  const walk = (series: Series[], path: NodeRef[]) => {
    const where: ViewWhere = canonicalWhere({ all: path })
    for (const s of series) {
      if (!s.open) continue
      const parent = parentOf(path, s.dim)
      const subParent = s.siblings ? parentOf(path, s.siblings.dim) : undefined
      const g: LaneGroupInput = {
        where,
        dim: s.dim,
        ...(parent ? { parent } : {}),
        limit: s.limit,
        other: false,
        ...(s.siblings
          ? {
              sub: {
                dim: s.siblings.dim,
                ...(subParent ? { parent: subParent } : {}),
                except: [...s.siblings.closed].sort(),
              },
            }
          : {}),
      }
      const key = groupKey(g)
      groups.set(seriesId(path, s.dim), key)
      // one series reached twice (the same conditions) is one group: the larger limit
      const had = specGroups.get(key)
      if (!had || (had.limit ?? 0) < s.limit) specGroups.set(key, g)
      for (const c of s.children) walk(c.series, childPath(path, s, c))
    }
  }
  walk(tree.series, [])
  const grouped = [...specGroups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g)
  const issues: string[] = []
  if (grouped.length > MAX_GROUPS) issues.push(`a tree shows at most ${MAX_GROUPS} open splits`)
  const refs = grouped.map((g) => refCount(g.where))
  if (refs.some((n) => n > MAX_LANE_REFS))
    issues.push(`a split has at most ${MAX_LANE_REFS} values above it`)
  if (refs.reduce((a, b) => a + b, 0) > MAX_LANE_REFS_TOTAL)
    issues.push(`a tree's splits have at most ${MAX_LANE_REFS_TOTAL} values above them in all`)
  return {
    spec: {
      itemTypes: settings.itemTypes,
      itemKinds: settings.itemKinds,
      spaces: settings.spaces,
      statusClasses: settings.statusClasses,
      time: treeTime(settings.time),
      columns: [],
      axis: { mode: "time", bucket: settings.bucket },
      lanes: { pinned: [{ where: {} }], groups: grouped },
    },
    root: pinnedKey({}),
    groups,
    issues,
  }
}
