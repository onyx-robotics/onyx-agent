// Generated from packages/core/src/view/series.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Workspace series (docs/lane-series-design.md): a workspace is a list of series, each a query:
 * its conditions, the dim it's split by (a lane per value, the busiest `limit`, no Other),
 * optionally a second dim that splits each value again (pairs), and how its lanes show. Hierarchy
 * values of the dim it's split by open in place (`expanded`: their children's lanes under them).
 * Browser-safe: the page, the server and the URL compile the same list into one view of lanes.
 *
 * What's saved is the workspace's series as its owner last showed them (its document); what's
 * shown differs in the page's URL (workspace.ts), so a link reproduces the view. A series is named by its id: its
 * conditions change as it's edited. Where a series was made from (the lane whose conditions are
 * its own) is found on the page, never stored.
 */
import { z } from "zod"

import { QUERY_TEXT_MAX, textSpan } from "../contracts/query"
import { graphState, type GraphState } from "./graph"
import { plotState, type PlotState } from "./plot-state"
import {
  canonicalWhere,
  fnv64,
  groupKey,
  MAX_GROUPS,
  MAX_LANE_REFS,
  MAX_LANE_REFS_TOTAL,
  MAX_PINNED,
  nodeRef,
  pinnedKey,
  refCount,
  viewWhere,
  type LaneGroupInput,
  type NodeRef,
  type PinnedLaneInput,
  type ViewSpecInput,
  type ViewWhere,
  type ViewWhereInput,
} from "./spec"
import { seriesId as treeSeriesPathId, type TreeChild, type WorkspaceTree } from "./tree"

/** A series' busiest values shown, unless it says otherwise. */
export const SERIES_LIMIT = 50
/** Series in a workspace, open or not. */
export const SERIES_MAX = 200
/** Hierarchy values a series opens in place. */
export const EXPANDED_MAX = 64

// value keys: entity ids, and literal values' md5-based keys (not RFC 4122 uuids)
const uuid = z.guid()
const dim = z.string().min(1).max(100)

/** A series' id: made on the page (random), or from where a tree had it (`t…`). */
export const seriesKey = z.string().regex(/^[a-z0-9]{1,24}$/)

/** Phrases of a series' text that are part of its query. */
export const TEXT_MARKS_MAX = 32

/**
 * A phrase of a series' text that became part of its query, by its place in the text: a
 * condition's value (or no value of a dim), what the series is split by or then by, or how many
 * values it shows.
 */
export const textMark = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("condition"), span: textSpan, ref: nodeRef }),
  z.strictObject({ kind: z.literal("split"), span: textSpan, dim }),
  z.strictObject({ kind: z.literal("then"), span: textSpan, dim }),
  z.strictObject({
    kind: z.literal("limit"),
    span: textSpan,
    limit: z.number().int().min(1).max(500),
  }),
])
export type TextMark = z.output<typeof textMark>

/**
 * What a series' text bar says (docs/query-builder.md §6): the text as it was last applied, and
 * the phrases of it that became the query, in order and apart. The query is the truth: a phrase
 * whose part the query no longer has (changed another way since) is only words.
 */
export const seriesText = z
  .strictObject({
    value: z.string().min(1).max(QUERY_TEXT_MAX),
    marks: z.array(textMark).max(TEXT_MARKS_MAX).default([]),
  })
  .refine(
    (t) =>
      t.marks.every(
        (m, i) =>
          m.span[0] < m.span[1] &&
          m.span[1] <= t.value.length &&
          (i === 0 || t.marks[i - 1]!.span[1] <= m.span[0])
      ),
    "a text's phrases are in it, in order and apart"
  )
export type SeriesText = z.output<typeof seriesText>

export const laneSeries = z
  .strictObject({
    /** stable in the workspace: the list beside the lanes and a sync name it */
    id: seriesKey,
    /** its name; none: its conditions and dimension in words */
    label: z.string().trim().min(1).max(80).optional(),
    /** its conditions: every `all` ref, and one of each `any` group */
    where: viewWhere
      .refine(
        (w) => refCount(w) <= MAX_LANE_REFS,
        `a series has at most ${MAX_LANE_REFS} conditions`
      )
      .default({ all: [], any: [] }),
    /** split by: a lane per value; none: its total lane alone */
    by: dim.optional(),
    /** each value split again by another dim (pairs); `closed`: values whose pairs are folded */
    then: z.strictObject({ dim, closed: z.array(uuid).max(500).default([]) }).optional(),
    /** hierarchy values of `by` opened in place: their children's lanes under them */
    expanded: z.array(uuid).max(EXPANDED_MAX).default([]),
    /** its busiest values shown */
    limit: z.number().int().min(1).max(500).default(SERIES_LIMIT),
    /**
     * what its lanes' bars show (the page's; not counted): volume (absent), on a scale its values
     * share; shape, each lane on its own; share, each lane's fraction of its whole
     */
    mode: z.enum(["shape", "share"]).optional(),
    /** counted and shown; a closed series is its header */
    open: z.boolean().default(true),
    /** what its text bar says (none: it's empty) */
    text: seriesText.optional(),
    /**
     * a plot of its items in place of its lanes (docs/inline-plots-design.md; none: its lanes): in
     * the URL with the series, and saved with it
     */
    plot: plotState.optional(),
    /**
     * a graph of its items and their relations in place of its lanes (docs/graph-design.md; none:
     * its lanes, or its plot): in the URL with the series, saved with it
     */
    graph: graphState.optional(),
    /**
     * an older address' or document's series drawn as tracks: now its graph's tree (read in, never
     * written: docs/tree-design.md, "Migration")
     */
    tracks: z.unknown().optional(),
    /**
     * its time axis is synced with every series' of the same key: they show one time window (none:
     * its own; `windowKeys`)
     */
    synced: seriesKey.optional(),
  })
  .transform(({ tracks, ...s }) =>
    // a series once drawn as tracks is graphed as a tree (under a plot, the plot shows)
    tracks !== undefined && !s.graph && !s.plot ? { ...s, graph: graphState.parse({}) } : s
  )
export type Series = z.output<typeof laneSeries>
export type SeriesInput = z.input<typeof laneSeries>

/** What a series' bars show: volume (its values on one scale), shape, or share of its whole. */
export type SeriesMode = "volume" | NonNullable<Series["mode"]>

/** What's wrong with a list of series (none: it can be compiled, budgets aside). */
function seriesIssues(list: readonly Series[]): string[] {
  const issues: string[] = []
  const ids = new Set<string>()
  for (const s of list) {
    if (ids.has(s.id)) issues.push(`the series ${s.id} is listed twice`)
    ids.add(s.id)
    if (s.then && !s.by) issues.push("a series splits its values again only when it splits")
    if (s.then && s.then.dim === s.by) issues.push(`split ${s.by}'s values by another dim`)
    if (s.expanded.length && !s.by) issues.push("a series opens values only of what it splits by")
  }
  return [...new Set(issues)]
}

export const workspaceSeries = z
  .array(laneSeries)
  .max(SERIES_MAX)
  .superRefine((list, ctx) => {
    for (const issue of seriesIssues(list)) ctx.addIssue({ code: "custom", message: issue })
  })

/**
 * Every item, one lane (no conditions, not split): the series a new workspace starts with
 * (docs/lane-series-design.md), a series like any other: typed into, split, plotted, removed. Its id is the one a workspace before version 4 showed it by, first, where it didn't
 * list it (`withAllItems`).
 */
export const allItemsSeries = (): Series => laneSeries.parse({ id: ALL_ITEMS_ID })
const ALL_ITEMS_ID = "all"

/**
 * The series a workspace of version 3 (or an address of version 2) shows: every item first, where
 * they don't list it (then, it couldn't be removed).
 */
export function withAllItems(list: readonly Series[]): Series[] {
  if (list.some((s) => s.id === ALL_ITEMS_ID)) return list as Series[]
  return [allItemsSeries(), ...list]
}

/** A new series' id: 8 base-36 characters. */
export function newSeriesId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("")
}

// ---------------------------------------------------------------- conditions

/** Conditions as one text: equal conditions, however built, are equal texts. */
export const whereKey = (w: ViewWhereInput): string => JSON.stringify(canonicalWhere(w))

/** The value of `dim` a group under `where` takes its lanes from: the one rollup value of it. */
export function parentOf(where: ViewWhere, dimKey: string): string | undefined {
  const refs = where.all.filter(
    (r): r is Extract<NodeRef, { key: string }> =>
      r.dim === dimKey && !("none" in r) && r.mode === "rollup"
  )
  return refs.length === 1 ? refs[0]!.key : undefined
}

/**
 * Conditions with a value added, in place of its parent (`parent`, a rollup value of the same dim
 * the value is under): "Topic is Controls", its child Friction, is "Topic is Friction".
 */
export function withValue(where: ViewWhereInput, ref: NodeRef, parent?: string): ViewWhere {
  const w = canonicalWhere(where)
  const all = w.all.filter(
    (r) =>
      parent === undefined ||
      r.dim !== ref.dim ||
      "none" in r ||
      r.mode !== "rollup" ||
      r.key !== parent
  )
  return canonicalWhere({ all: [...all, ref], any: w.any })
}

/** A lane of a series: its total (none), a value, a value's pair, a parent's own items. */
export interface LaneRef {
  /** the value key (for `direct`, the parent's) */
  value: string
  /** with `then`: the value of `then` under `value` */
  pair?: string
  /** the items attached to the parent value itself (its "(direct)" lane) */
  direct?: true
}

/** A group of a series: its gate, and the value it lists the children of. */
export interface SeriesGroup {
  where: ViewWhere
  parent: string | undefined
}

/** A series' group: its own (its values), or an expanded value's (that value's children). */
export function seriesGroup(s: Pick<Series, "where" | "by">, expanded?: string): SeriesGroup {
  const where = canonicalWhere(s.where)
  const parent = s.by ? parentOf(where, s.by) : undefined
  if (expanded === undefined || !s.by) return { where, parent }
  return {
    where: withValue(where, { dim: s.by, key: expanded, mode: "rollup" }, parent),
    parent: expanded,
  }
}

/** A lane's conditions, in a group of a series (its own, or an expanded value's). */
export function laneWhere(
  s: Pick<Series, "where" | "by" | "then">,
  group: SeriesGroup,
  lane: LaneRef
): ViewWhere {
  if (!s.by) return group.where
  const value = withValue(
    group.where,
    { dim: s.by, key: lane.value, mode: lane.direct ? "direct" : "rollup" },
    group.parent
  )
  if (!lane.pair || !s.then) return value
  return withValue(
    value,
    { dim: s.then.dim, key: lane.pair, mode: "rollup" },
    parentOf(group.where, s.then.dim)
  )
}

/**
 * A series' conditions, one per chip: an `all` ref, or an `any` group (of one dim, as the page
 * makes them: any of its values).
 */
export type Condition = { kind: "all"; ref: NodeRef } | { kind: "any"; refs: NodeRef[] }

export function conditionsOf(where: ViewWhereInput): Condition[] {
  const w = canonicalWhere(where)
  return [
    ...w.all.map((ref) => ({ kind: "all" as const, ref })),
    ...w.any.map((refs) => ({ kind: "any" as const, refs })),
  ]
}

export function whereOf(conditions: readonly Condition[]): ViewWhere {
  return canonicalWhere({
    all: conditions.flatMap((c) => (c.kind === "all" ? [c.ref] : [])),
    any: conditions.flatMap((c) => (c.kind === "any" ? [c.refs] : [])),
  })
}

/** A condition's refs, whichever kind. */
export const conditionRefs = (c: Condition): NodeRef[] => (c.kind === "all" ? [c.ref] : c.refs)

/** A condition of one or more refs: one is an `all` ref, more any of them. */
export const conditionOf = (refs: readonly NodeRef[]): Condition | null =>
  refs.length === 0
    ? null
    : refs.length === 1
      ? { kind: "all", ref: refs[0]! }
      : { kind: "any", refs: [...refs] }

// ---------------------------------------------------------------- compiling

/** What every lane counts from: the page's item set and time axis. */
export interface SeriesSettings {
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

/** A window as a view counts it: one without a start ("All time") from `ALL_TIME_FROM`. */
export const countedTime = (time: SeriesSettings["time"]): SeriesSettings["time"] =>
  time.last || time.from ? time : { ...time, from: ALL_TIME_FROM }

export interface CompiledSeries {
  /** what the series count: the scope lane, each series' total lane and its groups */
  spec: ViewSpecInput
  /** the scope lane's key: every item */
  root: string
  /** series id -> its total lane's key (the scope lane's, without conditions); open series */
  totals: Map<string, string>
  /** series id -> its group's key; open series with `by` */
  groups: Map<string, string>
  /** series id -> expanded value -> the key of the group of its children */
  expansions: Map<string, Map<string, string>>
  /** what's beyond the budget: the view would be refused (docs/SEMANTICS.md, "Budget") */
  issues: string[]
}

/** A group lane's key: its group's, its dim, and its value (a parent's own items: `x`). */
export const groupLaneKey = (group: string, dimKey: string, lane: Omit<LaneRef, "pair">) =>
  `${group}:${dimKey}:${lane.direct ? "x" : "r"}:${lane.value}`

/**
 * Series as one view of lanes: the scope lane (every item), and per open series its total lane
 * (its conditions) and a group per value it lists (its own, each expanded value's). Groups and
 * lanes are sorted by key, so moving a series, renaming it or changing what its bars show
 * changes nothing counted.
 */
export function compileSeries(series: readonly Series[], settings: SeriesSettings): CompiledSeries {
  const root = pinnedKey({})
  const pinned = new Map<string, PinnedLaneInput>([[root, { where: {} }]])
  const groups = new Map<string, LaneGroupInput>()
  const totals = new Map<string, string>()
  const own = new Map<string, string>()
  const expansions = new Map<string, Map<string, string>>()

  const addGroup = (s: Series, g: SeriesGroup): string => {
    const subParent = s.then ? parentOf(g.where, s.then.dim) : undefined
    const base: LaneGroupInput = {
      where: g.where,
      dim: s.by!,
      ...(g.parent ? { parent: g.parent } : {}),
      limit: s.limit,
      other: false,
      ...(s.then ? { sub: { dim: s.then.dim, ...(subParent ? { parent: subParent } : {}) } } : {}),
    }
    const key = groupKey(base)
    const had = groups.get(key)
    // a value whose pairs are folded isn't counted under them (`except` names lane keys)
    const except = s.then
      ? s.then.closed.map((v) => groupLaneKey(key, s.by!, { value: v })).sort()
      : []
    const g2: LaneGroupInput = s.then ? { ...base, sub: { ...base.sub!, except } } : base
    if (!had) groups.set(key, g2)
    else {
      // one group reached twice (equal conditions): the larger limit, pairs where either counts
      const hadExcept = new Set(had.sub?.except ?? [])
      groups.set(key, {
        ...had,
        limit: Math.max(had.limit ?? 0, s.limit),
        ...(had.sub ? { sub: { ...had.sub, except: except.filter((k) => hadExcept.has(k)) } } : {}),
      })
    }
    return key
  }

  for (const s of series) {
    if (!s.open) continue
    const where = canonicalWhere(s.where)
    const total = refCount(where) ? pinnedKey(where) : root
    if (!pinned.has(total)) pinned.set(total, { where })
    totals.set(s.id, total)
    if (!s.by) continue
    own.set(s.id, addGroup(s, seriesGroup(s)))
    if (s.expanded.length) {
      const m = new Map<string, string>()
      for (const v of s.expanded) m.set(v, addGroup(s, seriesGroup(s, v)))
      expansions.set(s.id, m)
    }
  }

  const grouped = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g)
  const lanes = [
    pinned.get(root)!,
    ...[...pinned.entries()]
      .filter(([k]) => k !== root)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, l]) => l),
  ]
  const issues: string[] = []
  if (grouped.length > MAX_GROUPS)
    issues.push(`a workspace counts at most ${MAX_GROUPS} splits (series and opened values)`)
  if (lanes.length > MAX_PINNED)
    issues.push(`a workspace counts at most ${MAX_PINNED - 1} series of different conditions`)
  const refs = [...grouped.map((g) => refCount(g.where)), ...lanes.map((l) => refCount(l.where))]
  if (refs.some((n) => n > MAX_LANE_REFS))
    issues.push(`a series has at most ${MAX_LANE_REFS} conditions`)
  if (refs.reduce((a, b) => a + b, 0) > MAX_LANE_REFS_TOTAL)
    issues.push(`a workspace's series have at most ${MAX_LANE_REFS_TOTAL} conditions in all`)
  return {
    spec: {
      itemTypes: settings.itemTypes,
      itemKinds: settings.itemKinds,
      spaces: settings.spaces,
      statusClasses: settings.statusClasses,
      time: countedTime(settings.time),
      columns: [],
      axis: { mode: "time", bucket: settings.bucket },
      lanes: { pinned: lanes, groups: grouped },
    },
    root,
    totals,
    groups: own,
    expansions,
    issues,
  }
}

// ---------------------------------------------------------------- edits

/** The list with one series changed (`f` returns null to remove it). */
/** Each series' time window's key: its syncs' (`synced`), or its own id. */
export const windowKeys = (list: readonly Series[]): Map<string, string> =>
  new Map(list.map((s) => [s.id, s.synced ?? s.id]))

/** A series' own: not synced. */
function unsynced(s: Series): Series {
  const { synced: _was, ...rest } = s
  return rest
}

/**
 * Sync `b`'s time axis with `a`'s: `b`, and the series synced with it, show `a`'s window (`key`
 * names the sync when `a` has none yet).
 */
export function syncSeries(list: readonly Series[], a: string, b: string, key: string): Series[] {
  const sa = list.find((s) => s.id === a)
  const sb = list.find((s) => s.id === b)
  if (!sa || !sb || a === b) return [...list]
  const to = sa.synced ?? key
  const from = sb.synced
  return list.map((s) =>
    s.id === a || s.id === b || (from !== undefined && s.synced === from) ? { ...s, synced: to } : s
  )
}

/** Unsync a series' time axis (its own window again); a sync left with one series is gone too. */
export function unsyncSeries(list: readonly Series[], id: string): Series[] {
  const key = list.find((s) => s.id === id)?.synced
  if (key === undefined) return [...list]
  const out = list.map((s) => (s.id === id ? unsynced(s) : s))
  const left = out.filter((s) => s.synced === key)
  return left.length === 1 ? out.map((s) => (s.synced === key ? unsynced(s) : s)) : out
}

export function editSeries(
  list: readonly Series[],
  id: string,
  f: (s: Series) => Series | null
): Series[] {
  const out: Series[] = []
  for (const s of list) {
    if (s.id !== id) out.push(s)
    else {
      const next = f(s)
      if (next) out.push(next)
    }
  }
  return out
}

/** A series of conditions, split by `by` (none: its total lane alone). */
/**
 * What a new series split by is graphed as a tree by default (docs/tree-design.md: its ideas
 * branching off each of its values).
 */
export const TREE_FIRST = new Set(["goal", "campaign"])

export function makeSeries(
  id: string,
  where: ViewWhereInput = {},
  by?: string,
  label?: string
): Series {
  return laneSeries.parse({
    id,
    where: canonicalWhere(where),
    ...(by ? { by } : {}),
    ...(label ? { label } : {}),
    ...(by && TREE_FIRST.has(by) ? { graph: {} } : {}),
  })
}

/** The list with a series added after another (none: at the end). */
export function insertSeries(list: readonly Series[], s: Series, after?: string | null): Series[] {
  const at = after ? list.findIndex((x) => x.id === after) : -1
  if (at < 0) return [...list, s]
  return [...list.slice(0, at + 1), s, ...list.slice(at + 1)]
}

/** A series with these conditions split by `by` (none: one lane), if the list has one. */
export const findEqual = (
  list: readonly Series[],
  where: ViewWhereInput,
  by: string | undefined
): Series | undefined => {
  const k = whereKey(where)
  return list.find((s) => s.by === by && whereKey(s.where) === k)
}

export const removeSeries = (list: readonly Series[], id: string): Series[] =>
  editSeries(list, id, () => null)

/** Open or close a series: a closed one is its header, and isn't counted. */
export const toggleOpen = (list: readonly Series[], id: string): Series[] =>
  editSeries(list, id, (s) => ({ ...s, open: !s.open }))

export const setOpen = (list: readonly Series[], id: string, open: boolean): Series[] =>
  editSeries(list, id, (s) => (s.open === open ? s : { ...s, open }))

export const setMode = (list: readonly Series[], id: string, mode: SeriesMode): Series[] =>
  editSeries(list, id, (s) => {
    const { mode: _was, ...rest } = s
    return mode === "volume" ? rest : { ...rest, mode }
  })

/** Show a plot of a series' items in place of its lanes, or its graph (null: its lanes again). */
export const setPlot = (list: readonly Series[], id: string, plot: PlotState | null): Series[] =>
  editSeries(list, id, (s) => {
    const { plot: _was, ...rest } = s
    if (!plot) return rest
    const { graph: _graph, ...shown } = rest
    return { ...shown, plot }
  })

/** Show a graph of a series' items in place of its lanes, or its plot (null: its lanes again). */
export const setGraph = (list: readonly Series[], id: string, graph: GraphState | null): Series[] =>
  editSeries(list, id, (s) => {
    const { graph: _was, ...rest } = s
    if (!graph) return rest
    const { plot: _plot, ...shown } = rest
    return { ...shown, graph }
  })

export const setLimit = (list: readonly Series[], id: string, limit: number): Series[] =>
  editSeries(list, id, (s) => ({ ...s, limit }))

/**
 * Name a series: its title is the name, and what was typed in its text bar goes (title.ts
 * `seriesName`). None: neither, its title is its query in words again.
 */
export const setLabel = (list: readonly Series[], id: string, label: string | null): Series[] =>
  editSeries(list, id, (s) => {
    const { label: _was, text: _text, ...rest } = s
    const name = label?.trim()
    return name ? { ...rest, label: name.slice(0, 80) } : rest
  })

/** A series' conditions changed. */
export const setWhere = (list: readonly Series[], id: string, where: ViewWhereInput): Series[] =>
  editSeries(list, id, (s) => ({ ...s, where: canonicalWhere(where) }))

/** Split a series by another dim (none: its total lane alone); what it opened goes. */
export const setBy = (list: readonly Series[], id: string, by: string | null): Series[] =>
  editSeries(list, id, (s) => {
    if ((s.by ?? null) === by) return s
    const { by: _by, then, expanded: _e, ...rest } = s
    return {
      ...rest,
      expanded: [],
      ...(by ? { by } : {}),
      ...(by && then && then.dim !== by ? { then: { dim: then.dim, closed: [] } } : {}),
    }
  })

/** Split each value of a series again by another dim (null: stop). */
export const setThen = (list: readonly Series[], id: string, then: string | null): Series[] =>
  editSeries(list, id, (s) => {
    const { then: was, ...rest } = s
    if (!then || !s.by || then === s.by) return rest
    return { ...rest, then: { dim: then, closed: was?.dim === then ? was.closed : [] } }
  })

/**
 * What a series' text says of it (docs/query-builder.md, `seriesQuery`): its conditions, what it's
 * split by and then by, and how many values it shows when that isn't the default.
 */
export interface SeriesQueryOf {
  where: ViewWhereInput
  by?: string
  then?: string
  limit?: number
}

/** A series' query, as its header's text bar sends it to be refined. */
export const queryOf = (s: Pick<Series, "where" | "by" | "then" | "limit">): SeriesQueryOf => ({
  where: s.where,
  ...(s.by ? { by: s.by } : {}),
  ...(s.then ? { then: s.then.dim } : {}),
  ...(s.limit !== SERIES_LIMIT ? { limit: s.limit } : {}),
})

/**
 * A series' query replaced (its text resolved): its conditions, splits and limit, in one edit,
 * and with `text`, what its text bar says (null: nothing; absent: as it was), its title instead of
 * a name it was given. The values it opened stay while it's split by the same dim, and its folded
 * pairs while each value is split again by the same.
 */
export const setQuery = (
  list: readonly Series[],
  id: string,
  q: SeriesQueryOf,
  text?: SeriesText | null
): Series[] =>
  editSeries(list, id, (s) => {
    const { by: _by, then: was, expanded, text: had, label, ...rest } = s
    const by = q.by || undefined
    const then = by && q.then && q.then !== by ? q.then : undefined
    const same = by === s.by
    const says = text === undefined ? had : (text ?? undefined)
    return {
      ...rest,
      where: canonicalWhere(q.where),
      ...(by ? { by } : {}),
      ...(then ? { then: { dim: then, closed: same && was?.dim === then ? was.closed : [] } } : {}),
      expanded: same ? expanded : [],
      limit: q.limit ?? SERIES_LIMIT,
      ...(says ? { text: says } : {}),
      ...(label && text === undefined ? { label } : {}),
    }
  })

/** Fold or show one value's pairs. */
export const togglePairs = (list: readonly Series[], id: string, value: string): Series[] =>
  editSeries(list, id, (s) =>
    !s.then
      ? s
      : {
          ...s,
          then: {
            ...s.then,
            closed: s.then.closed.includes(value)
              ? s.then.closed.filter((v) => v !== value)
              : [...s.then.closed, value].sort(),
          },
        }
  )

/** Open or close a hierarchy value of what a series splits by: its children's lanes under it. */
export const toggleExpanded = (list: readonly Series[], id: string, value: string): Series[] =>
  editSeries(list, id, (s) =>
    !s.by
      ? s
      : s.expanded.includes(value)
        ? { ...s, expanded: s.expanded.filter((v) => v !== value) }
        : s.expanded.length >= EXPANDED_MAX
          ? s
          : { ...s, expanded: [...s.expanded, value] }
  )

/** A copy of a series just after it, to edit into a variant (unnamed, open). */
export function duplicateSeries(list: readonly Series[], id: string, newId: string): Series[] {
  const s = list.find((x) => x.id === id)
  if (!s) return [...list]
  const { label: _label, ...rest } = s
  return insertSeries(list, { ...rest, id: newId, open: true }, id)
}

/** Move a series one place up (-1) or down (1). */
export function moveSeries(list: readonly Series[], id: string, by: -1 | 1): Series[] {
  const i = list.findIndex((s) => s.id === id)
  const j = i + by
  if (i < 0 || j < 0 || j >= list.length) return [...list]
  const out = [...list]
  ;[out[i], out[j]] = [out[j]!, out[i]!]
  return out
}

// ---------------------------------------------------------------- what the list beside lists

/**
 * What the page lists beside the lanes (none: every item): a series' lanes (its header), its
 * total, one of its lanes, or a node of its graph's tree (its values from the origin, one per
 * split: docs/tree-design.md); or a lane named by its conditions (an older link's).
 */
export const seriesFocus = z.union([
  z
    .strictObject({
      series: seriesKey,
      lane: z
        .union([
          z.literal("total"),
          z.strictObject({
            value: uuid,
            pair: uuid.optional(),
            direct: z.literal(true).optional(),
          }),
        ])
        .optional(),
      path: z.array(uuid).min(1).max(4).optional(),
    })
    .refine((f) => !(f.lane && f.path), "a focus is a lane or a tree's node, not both"),
  z.strictObject({ where: viewWhere }),
])
export type SeriesFocus = z.output<typeof seriesFocus>

// ---------------------------------------------------------------- trees (document version 2)

/** A series converted from a tree: its id, from where the tree had it. */
export const treeSeriesKey = (path: readonly NodeRef[], dimKey: string): string =>
  `t${fnv64(treeSeriesPathId([...path], dimKey))}`

/** A tree's path as conditions: a value with a later value of its dim on the path is under it. */
function pathWhere(path: readonly NodeRef[]): ViewWhere {
  const kept = path.filter(
    (r, i) =>
      "none" in r || r.mode !== "rollup" || !path.slice(i + 1).some((later) => later.dim === r.dim)
  )
  return canonicalWhere({ all: kept })
}

const childRef = (dimKey: string, c: Pick<TreeChild, "value" | "direct">): NodeRef => ({
  dim: dimKey,
  key: c.value,
  mode: c.direct ? "direct" : "rollup",
})

/**
 * A tree (a workspace document of version 2, or a view's address of version 1) as series: depth
 * first in the tree's order, so a series follows the series it was split from. Each series of the
 * tree at a path is a series of that path's conditions; a value's chevron (a series of its own
 * dim under it) is an expanded value of its series; a series under a closed one is closed.
 */
export function seriesFromTree(tree: WorkspaceTree): Series[] {
  const out: Series[] = []
  type TreeSeries = WorkspaceTree["series"][number]

  const walk = (list: TreeSeries[], path: NodeRef[], open: boolean) => {
    for (const s of list) {
      const made: Series = laneSeries.parse({
        id: treeSeriesKey(path, s.dim),
        where: pathWhere(path),
        by: s.dim,
        ...(s.siblings ? { then: { dim: s.siblings.dim, closed: s.siblings.closed } } : {}),
        limit: s.limit,
        ...(s.mode ? { mode: s.mode } : {}),
        open: open && s.open,
      })
      out.push(made)
      under(s, made, path, open && s.open)
    }
  }

  /** What's under a series' values: chevrons (expanded values), and series of other dims. */
  const under = (s: TreeSeries, made: Series, path: NodeRef[], open: boolean) => {
    for (const c of s.children) {
      const childPath = [
        ...path,
        childRef(s.dim, c),
        ...(c.pair && s.siblings
          ? [{ dim: s.siblings.dim, key: c.pair, mode: "rollup" as const }]
          : []),
      ]
      const others: TreeSeries[] = []
      for (const n of c.series) {
        if (n.dim === s.dim && !c.pair && !c.direct) {
          // a chevron: the value's children, in its series
          if (n.open && open && made.expanded.length < EXPANDED_MAX) made.expanded.push(c.value)
          under(n, made, childPath, open && n.open)
        } else others.push(n)
      }
      walk(others, childPath, open)
    }
  }

  walk(tree.series, [], true)
  return out
}

/**
 * What an older link listed beside the lanes, as this version names it: a series' heading by the
 * series converted from it; a lane by its conditions.
 */
export function focusFromTree(focus: { path: NodeRef[]; dim?: string } | null): SeriesFocus | null {
  if (!focus) return null
  if (focus.dim) return { series: treeSeriesKey(focus.path, focus.dim) }
  if (!focus.path.length) return null
  return { where: pathWhere(focus.path) }
}
