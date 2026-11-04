// Generated from packages/core/src/contracts/query.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Series query resolution (docs/query-builder.md): what a series header's text means as the
 * series' query (its conditions, what it's split by), shown as chips the person checks and
 * changes. Shared by the route, the page and the evaluation harness. Browser-safe.
 */
import { z } from "zod"

import { MAX_LANE_REFS, nodeRef, viewWhere } from "../view/spec"

export const QUERY_TEXT_MAX = 500

const dim = z.string().min(1).max(100)

/** The part of a series the text says: its conditions, its splits and how many values it shows. */
export const seriesQuery = z.strictObject({
  where: viewWhere.default({ all: [], any: [] }),
  by: dim.optional(),
  then: dim.optional(),
  limit: z.number().int().min(1).max(500).optional(),
})
export type SeriesQuery = z.output<typeof seriesQuery>
export type SeriesQueryInput = z.input<typeof seriesQuery>

export const resolveQueryInput = z.object({
  text: z.string().max(QUERY_TEXT_MAX),
  /** the series' query now: the text changes it; omitted, the text says the whole query */
  current: seriesQuery.optional(),
  /** the resolver to use (a development menu compares them); omitted, the server's default */
  strategy: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
})
export type ResolveQueryInput = z.input<typeof resolveQueryInput>

/** UTF-16 offsets into the text, end exclusive. */
export const textSpan = z.tuple([z.number().int().min(0), z.number().int().min(0)])
export type TextSpan = z.output<typeof textSpan>

/** Something a phrase could mean: a value of a dimension, or a dimension (to split by). */
export const queryCandidate = z.object({
  dim: z.string(),
  dimLabel: z.string(),
  /** a value's key; absent: the dimension itself */
  key: z.string().optional(),
  label: z.string(),
  /** the value's ancestors in its dimension, nearest last */
  path: z.array(z.string()).default([]),
  /** the viewer's own entity ("you") */
  me: z.boolean().optional(),
  /** how well it matched, 0..1, comparable within one resolution */
  score: z.number(),
  /** what found it: exact, trigram, embedding, model, ... */
  via: z.string(),
})
export type QueryCandidate = z.output<typeof queryCandidate>

/**
 * One element of the query, as a chip: a condition (one value, or no value at all), a split, a
 * second split, or how many values to show. Conditions with the same `group` are one any-of
 * group; without one, a condition is required.
 */
export const queryChip = z.object({
  kind: z.enum(["condition", "split", "then", "limit"]),
  ref: nodeRef.optional(),
  dim: z.string().optional(),
  dimLabel: z.string().optional(),
  /** the value's label ("you" for the viewer's own entity) */
  label: z.string().optional(),
  limit: z.number().int().optional(),
  group: z.number().int().optional(),
  /** where it came from in the text; absent: kept from the current query */
  span: textSpan.optional(),
  phrase: z.string().optional(),
  /** 0..1: how sure the resolver is (calibration is part of what the harness measures) */
  confidence: z.number().min(0).max(1),
  /** other readings of the same phrase, best first */
  alternatives: z.array(queryCandidate).default([]),
})
export type QueryChip = z.output<typeof queryChip>
export type QueryChipInput = z.input<typeof queryChip>

/** What the text asks for that a series can't say yet: shown, never silently dropped. */
export const UNSUPPORTED_KINDS = [
  "negation",
  "range",
  "metric",
  "time",
  "text",
  "sort",
  "other",
] as const
export const queryUnsupported = z.object({
  kind: z.enum(UNSUPPORTED_KINDS),
  span: textSpan,
  phrase: z.string(),
  note: z.string(),
})
export type QueryUnsupported = z.output<typeof queryUnsupported>

export const queryResolution = z.object({
  /** the series' query after the text */
  query: seriesQuery,
  chips: z.array(queryChip),
  unsupported: z.array(queryUnsupported),
  /** words that became nothing (beyond the small ones: "the", "of") */
  leftover: z.array(z.object({ span: textSpan, phrase: z.string() })),
  strategy: z.string(),
  /** milliseconds per stage, and in all */
  timings: z.record(z.string(), z.number()),
  /** what the resolver proposed that wasn't valid (an unknown value, say) and was dropped */
  dropped: z.array(z.string()).default([]),
  /**
   * what the resolver considered, best first (only when asked: the evaluation's candidate
   * recall, whether the right reading was among them)
   */
  candidates: z.array(queryCandidate).optional(),
  /**
   * the resolver asked for failed (no key, an error, no answer in time) and this is the
   * baseline's resolution instead (`strategy` says which answered): which failed, and why
   */
  fallback: z.object({ from: z.string(), reason: z.string() }).optional(),
})
export type QueryResolution = z.output<typeof queryResolution>

/** The resolvers a series' text can use, and which one a request that names none gets. */
export const queryStrategies = z.object({
  default: z.string(),
  strategies: z.array(
    z.object({
      name: z.string(),
      /** one line: what it does */
      description: z.string(),
      /** another version kept for comparison: the evaluation runs it only when named */
      variant: z.boolean(),
    })
  ),
})
export type QueryStrategies = z.output<typeof queryStrategies>

export { MAX_LANE_REFS }
