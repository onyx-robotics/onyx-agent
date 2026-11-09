// Generated from packages/core/src/contracts/plots.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Plot read contracts (docs/plots-design.md §6), shared by the routes, the SDK and the page. A
 * request names its scope as the page shows it: the workspace's view spec, the scope's lane keys
 * (a series' lanes, or one), the view's display frontier and the time window; fields by key
 * (@onyx/core/view plot.ts `fieldKey`).
 */
import { z } from "zod"

import { isPow2, LASSO_MAX, PICK_IDS_MAX, scaleKind, timeOf } from "../view/plot"
import { viewSpec } from "../view/spec"

const window = z
  .strictObject({ from: z.number().int(), to: z.number().int() })
  .refine((w) => w.to > w.from, "a window ends after it starts")
const laneKeys = z.array(z.string().min(1).max(400)).min(1).max(500)
const fieldKey = z.string().min(1).max(200)
const range = z.tuple([z.number(), z.number()]).refine(([a, b]) => b >= a, "a range is ordered")
const scales = z.strictObject({
  x: scaleKind.default("linear"),
  y: scaleKind.default("linear"),
})

/** The items a plot is of: those of `lanes` (any of them) in the window. */
export const plotScope = z.strictObject({
  spec: viewSpec,
  lanes: laneKeys,
  /** the element and header keys the view shows (its display frontier) */
  shown: z.array(z.string().min(1)).max(5000),
  window,
  /** the scope's items, as the page counts them from the lanes' buckets (an admission hint) */
  count: z.number().int().min(0).default(0),
})
export type PlotScopeInput = z.input<typeof plotScope>

export const plotFieldsQuery = z.strictObject({ scope: plotScope })
export type PlotFieldsQueryInput = z.input<typeof plotFieldsQuery>

/** The most items a frame returns, whatever its rate (more: `truncated`). */
export const FRAME_HARD_MAX = 50_000

export const plotFrameQuery = z.strictObject({
  scope: plotScope,
  /** 1 in `rate` of the scope's items, by their sample bits */
  rate: z
    .number()
    .int()
    .refine(isPow2, "a rate is a power of two")
    .refine((r) => r <= 2 ** 20, "at most 1 in 2^20"),
  /** order ranks to compute among every item of the scope (a sampled frame can't) */
  order: z.array(timeOf).max(3).default([]),
  /** these items only, whatever the rate (a patch after a touch) */
  ids: z.array(z.guid()).min(1).max(1000).optional(),
})
export type PlotFrameQueryInput = z.input<typeof plotFrameQuery>

/**
 * What's picked, as a request names it: its scope's lanes (with a solo lane, that one) and a
 * brush, a lasso (on the axes' scales: log₁₀ on a log scale) or ids. An order axis is picked as
 * the range of the times it orders by (the page converts it), so a pick never moves as items
 * arrive.
 */
export const plotPick = z.strictObject({
  lanes: laneKeys,
  what: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("brush"),
      x: fieldKey,
      y: fieldKey.nullable(),
      xr: range.nullable(),
      yr: range.nullable(),
      scale: scales.default({ x: "linear", y: "linear" }),
    }),
    z.strictObject({
      kind: z.literal("lasso"),
      x: fieldKey,
      y: fieldKey,
      scale: scales.default({ x: "linear", y: "linear" }),
      polygon: z
        .array(z.tuple([z.number(), z.number()]))
        .min(3)
        .max(LASSO_MAX),
    }),
    z.strictObject({ kind: z.literal("ids"), ids: z.array(z.guid()).min(1).max(PICK_IDS_MAX) }),
  ]),
})
export type PlotPickInput = z.input<typeof plotPick>

export const plotGridQuery = z
  .strictObject({
    scope: plotScope,
    x: fieldKey,
    y: fieldKey,
    scale: scales.default({ x: "linear", y: "linear" }),
    /** each value axis's domain, on its scale (a lane axis: null) */
    domain: z.strictObject({ x: range.nullable(), y: range.nullable() }),
    /** cells across: GRID_N · 2^level */
    level: z.number().int().min(0).max(4).default(0),
    /** zoomed: only these cells [from, to) */
    tile: z
      .strictObject({
        ix: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
        iy: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
      })
      .optional(),
    /** per scope lane, over which value axes (a strip's or a distribution's) */
    marginals: z.enum(["none", "x", "y", "both"]).default("none"),
    /** lane keys a cell's items are counted by (the legend's colors) */
    colors: z.array(z.string().min(1).max(400)).max(10).default([]),
    pick: plotPick.optional(),
  })
  .refine(
    (q) => (q.x === "lane" || q.domain.x !== null) && (q.y === "lane" || q.domain.y !== null),
    "a value axis needs a domain"
  )
export type PlotGridQueryInput = z.input<typeof plotGridQuery>

/** Each lane's best so far of a metric over a scope, whole: the records that set it. */
export const plotBestQuery = z.strictObject({
  scope: plotScope,
  /** the time or order the plot runs along (an item with no such time isn't on the line) */
  x: fieldKey,
  /** the metric */
  y: fieldKey,
  scale: scaleKind.default("linear"),
  /** past this many a row shape, about this many of its records, evenly */
  max: z.number().int().min(2).max(10_000).default(2_000),
})
export type PlotBestQueryInput = z.input<typeof plotBestQuery>
