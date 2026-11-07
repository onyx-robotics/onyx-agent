// Generated from packages/core/src/view/tree-graph.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * A series' graph as a tree (docs/tree-design.md): from one origin, its runs split by a chain of
 * dims left to right (its goals, then each goal's ideas, then…), every path from the origin counted
 * on its own over all of time. What a tree counts is a read of its own (`tree_counts`), never the
 * page's view: drawing a graph changes nothing the page counts. Browser-safe.
 */
import { countedTime, parentOf, type SeriesSettings } from "./series"
import {
  canonicalWhere,
  groupKey,
  pinnedKey,
  type BucketKey,
  type LaneGroupInput,
  type ViewSpecInput,
  type ViewWhereInput,
} from "./spec"
import type { MatchPlan, ViewResult } from "./types"

/** What a tree splits a series' values by unless it says: ideas. */
export const TRACK_DIM = "hypothesis"
/** The statuses a run counts in a tree with: it ended, and ran (a cancelled job may not have). */
export const ENDED_CLASSES = ["succeeded", "failed", "unknown", "none"] as const

/** The most splits a tree takes, left to right from its origin. */
export const TREE_SPLITS_MAX = 4
/**
 * A path's fewest runs ever to be counted apart: fewer, and its runs are its parent's "other". It
 * could never have earned a branch, so leaving it out never changes what's drawn.
 */
export const TREE_MIN_RUNS = 5
/**
 * The buckets a tree may be counted in, finest first: each level's the finest that fits
 * `TREE_CELLS` with the levels above it as fine or finer.
 */
export const TREE_STEPS = ["1h", "1d", "7d", "28d"] as const satisfies readonly BucketKey[]
export type TreeStep = (typeof TREE_STEPS)[number]
/** The most path × bucket cells a tree's counts return. */
export const TREE_CELLS = 100_000
/** The most values one split may have to choose from. */
export const TREE_LEVEL_MAX = 5000

/** A path's place at a level that isn't a value: runs under values too small to count apart. */
export const TREE_OTHER = "other"
/** …and runs whose value there is in a space the viewer can't see (always a leaf). */
export const TREE_RESTRICTED = "restricted"

/**
 * A card's splits as a tree, in order: its Node panel's own chain, else what its lanes are split
 * by (its `by`, then its `then` or its ideas), else its ideas.
 */
export function treeSplits(s: {
  by?: string
  then?: { dim: string }
  graph?: { splits?: readonly string[] }
}): string[] {
  const own = s.graph?.splits
  if (own?.length) return [...new Set(own)].slice(0, TREE_SPLITS_MAX)
  const chain = s.by && s.by !== TRACK_DIM ? [s.by, s.then?.dim ?? TRACK_DIM] : [TRACK_DIM]
  return [...new Set(chain)]
}

/** What a tree reads: its counts' and its queue's specs, its total lane and a group per split. */
export interface CompiledTreeGraph {
  /** its ended runs over all of time: the total lane and a group per split (planned, not counted) */
  counts: ViewSpecInput
  /** what's in flight on it: the same, of every status */
  queue: ViewSpecInput
  /** its total lane's key (the series' conditions) */
  total: string
  /** each split's group's key, in order */
  levels: string[]
}

/**
 * A tree's specs (none when the page's settings leave nothing of the kind): the series' runs
 * (activities, of the page's statuses that end), each split a group under its conditions whose
 * values are its candidates (the roots of its dim, or the children of its value the series names).
 */
export function compileTreeGraph(
  s: { where: ViewWhereInput },
  splits: readonly string[],
  settings: SeriesSettings
): CompiledTreeGraph | null {
  const asked = settings.statusClasses ?? []
  const statusClasses = ENDED_CLASSES.filter((c) => !asked.length || asked.includes(c))
  // (an empty list is every status: one that ends none is nothing)
  if (!statusClasses.length || !splits.length) return null
  if (settings.itemKinds?.length && !settings.itemKinds.includes("activity")) return null
  const where = canonicalWhere(s.where)
  const groups: LaneGroupInput[] = splits.slice(0, TREE_SPLITS_MAX).map((dim) => {
    const parent = parentOf(where, dim)
    return { where, dim, ...(parent ? { parent } : {}), limit: 1, other: false }
  })
  const base: ViewSpecInput = {
    itemTypes: settings.itemTypes,
    itemKinds: ["activity"],
    spaces: settings.spaces,
    time: countedTime({}),
    columns: [],
    axis: { mode: "time", bucket: "1d" },
    lanes: { pinned: [{ where }], groups },
  }
  return {
    counts: { ...base, statusClasses },
    queue: { ...base, statusClasses: [] },
    total: pinnedKey(where),
    levels: groups.map(groupKey),
  }
}

/** A path's key (its values joined): the origin is "". */
export const treePathKey = (path: readonly string[]) => path.join("/")

/** A node of a tree: a path from its origin, and its runs by bucket. */
export interface TreeGraphNode {
  /** a value per split from the origin (none: the origin): value keys, other or restricted */
  path: string[]
  /** its runs ever */
  n: number
  /** its buckets with runs, in order: each one's index from the read's `t0`, and its runs */
  b: number[]
  c: number[]
  /**
   * how many of the read's buckets each of its buckets spans (its level counted coarser: each count
   * is of the `w` buckets from its index); none, 1
   */
  w?: number
}

/** A split of a tree: its dim, and its name. */
export interface TreeGraphSplit {
  dim: string
  label: string
  /** why its values aren't counted apart (too many to split by): its runs stay on their parent */
  issue?: string
}

/** A tree's counts (docs/tree-design.md). */
export interface TreeGraphRead {
  asOf: string
  snapshot: ViewResult["snapshot"]
  registryVersion: number
  visibilityGen: number
  /** the match plan its total lane was placed by: what a delta changes */
  match: MatchPlan
  splits: TreeGraphSplit[]
  /** the bucket its counts came in: the origin's, the finest (a node's `b` count in it) */
  step: TreeStep
  /**
   * each level's bucket (the origin's, then each split's): the finest the budget allows at the top,
   * coarser deeper (a deep split's paths are many)
   */
  steps: TreeStep[]
  /** its first bucket's start (epoch ms): a node's `b` count from it */
  t0: number
  /** every path with at least `min` runs (the origin first), and each kept parent's other */
  nodes: TreeGraphNode[]
  /** under each parent, how many values were counted in its other (each under `min` runs) */
  folded: { parent: string[]; values: number; n: number }[]
  /** value key -> its name, for the values its paths name */
  labels: Record<string, string>
  /**
   * each split's dim, and its values as the counts placed them ([facet value id, value key]): what
   * places a published row's values on paths, so the counts follow each run as it ends
   */
  levels: { dim: number; ids: [number, string][] }[]
  /** each path folded into its parent's other, and its runs (one reaching `min` is a branch) */
  small: { path: string[]; n: number }[]
  /** the fewest runs a path is counted apart with */
  min: number
  /** the messages applied to it since it was read (docs/SEMANTICS.md, "Resync") */
  applied?: string[]
}

/** What's in flight at a node of a tree (`path`: its values; the origin, none). */
export interface TreeGraphQueue {
  path: string[]
  running: number
  waiting: number
  /** the first of them: running, then newest */
  head: { id: string; running: boolean }[]
}

/** What's known of a value a tree's path names (an idea, a goal…): its status, and since when. */
export interface TreeGraphFact {
  id: string
  name: string
  status: string | null
  /** its status' class (closed: succeeded, failed, cancelled) */
  cls: string | null
  endedAt: number | null
}

/** A tree's queue (docs/tree-design.md): what's in flight at each node, and its values' facts. */
export interface TreeGraphQueueRead {
  asOf: string
  snapshot: ViewResult["snapshot"]
  registryVersion: number
  visibilityGen: number
  match: MatchPlan
  queue: TreeGraphQueue[]
  facts: TreeGraphFact[]
  /** [idea, the idea it was declared inspired by], among its values */
  parents: [string, string][]
}
