// Generated from packages/core/src/view/series.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * A series card's query, in parts (docs/lane-series-design.md; card.ts holds the card): its
 * conditions (any of several values, none of a dim, exactly one node), a lane's conditions in a
 * group of the card (its value in place of its parent, with its pair), the group a card or an
 * opened value lists, what its text bar says, and what every lane counts from. Browser-safe.
 */
import { z } from "zod"

import { QUERY_TEXT_MAX, textSpan } from "../contracts/query"
import {
  canonicalWhere,
  nodeRef,
  type NodeRef,
  type ViewSpecInput,
  type ViewWhere,
  type ViewWhereInput,
} from "./spec"

/** A card's busiest values shown, unless it says otherwise. */
export const SERIES_LIMIT = 50
/** Hierarchy values a card opens in place. */
export const EXPANDED_MAX = 64

const dim = z.string().min(1).max(100)

/** What a query's parts are read from (a card, as card.ts holds it). */
interface QueryParts {
  where: ViewWhereInput
  by?: string
  then?: { dim: string; closed: string[] }
  limit: number
}

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
export function seriesGroup(s: Pick<QueryParts, "where" | "by">, expanded?: string): SeriesGroup {
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
  s: Pick<QueryParts, "where" | "by" | "then">,
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

// ---------------------------------------------------------------- counting

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

/** A group lane's key: its group's, its dim, and its value (a parent's own items: `x`). */
export const groupLaneKey = (group: string, dimKey: string, lane: Omit<LaneRef, "pair">) =>
  `${group}:${dimKey}:${lane.direct ? "x" : "r"}:${lane.value}`

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
export const queryOf = (s: QueryParts): SeriesQueryOf => ({
  where: s.where,
  ...(s.by ? { by: s.by } : {}),
  ...(s.then ? { then: s.then.dim } : {}),
  ...(s.limit !== SERIES_LIMIT ? { limit: s.limit } : {}),
})
