// Generated from packages/core/src/view/plot-state.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * What a plot shows (docs/plots-design.md §4, §5; docs/inline-plots-design.md): the fields an
 * axis can show, the marks and what each needs, and a plot's state. Apart from plot.ts so a
 * series (series.ts) can hold its plot: plot.ts names series in its picks. Browser-safe.
 */
import { z } from "zod"

// ------------------------------------------------------------------------------------- fields

/** An item's times: its time on the lanes (start, else creation), when it ended, when it came in. */
export const timeOf = z.enum(["t", "ended", "recorded"])
export type TimeOf = z.output<typeof timeOf>

/** A per-item value an axis can show (docs/plots-design.md §5). */
export const field = z.discriminatedUnion("k", [
  z.strictObject({ k: z.literal("time"), of: timeOf.default("t") }),
  /** rank by that time among the scope's items in the window (1…n), at the read: never stored */
  z.strictObject({ k: z.literal("order"), of: timeOf.default("t") }),
  /** ended − started, seconds */
  z.strictObject({ k: z.literal("duration") }),
  /** a metric's current value under one context (null: none); contexts are never mixed */
  z.strictObject({
    k: z.literal("metric"),
    key: z.string().min(1).max(100),
    context: z.guid().nullable(),
  }),
  /** a property declared `number` or `integer` on the item's type */
  z.strictObject({ k: z.literal("prop"), key: z.string().min(1).max(100) }),
  /** the scope's lanes, as categories */
  z.strictObject({ k: z.literal("lane") }),
])
export type Field = z.output<typeof field>
export type FieldInput = z.input<typeof field>

export const scaleKind = z.enum(["linear", "log"])
export type ScaleKind = z.output<typeof scaleKind>
/** An axis scale per axis. */
export const axisScales = z.strictObject({
  x: scaleKind.default("linear"),
  y: scaleKind.default("linear"),
})

export const MARKS = ["point", "strip", "box", "trend", "best"] as const
export type Mark = (typeof MARKS)[number]

const numeric = (f: Field) => f.k !== "lane"
const timeLike = (f: Field) => f.k === "time" || f.k === "order"

/** Why a mark can't show these axes (null: it can). */
export function markIssue(mark: Mark, x: Field, y: Field): string | null {
  switch (mark) {
    case "point":
      return numeric(x) && numeric(y) ? null : "a point plot has two value axes"
    case "strip":
      return (x.k === "lane") !== (y.k === "lane") ? null : "a strip plot has one lane axis"
    case "box":
      return x.k === "lane" && numeric(y) ? null : "a distribution has lanes across, values up"
    case "trend":
      return timeLike(x) && numeric(y) ? null : "a trend has time or order across, values up"
    case "best":
      return timeLike(x) && y.k === "metric"
        ? null
        : "a best so far has time or order across and a metric up"
  }
}

/** A range along an axis, low to high. */
export const axisRange = z
  .tuple([z.number(), z.number()])
  .refine(([a, b]) => b > a, "a range ends after it starts")

/** What a plot shows (the view's `plot` field; null: the lanes). */
export const plotState = z
  .strictObject({
    mark: z.enum(MARKS).default("point"),
    x: field,
    y: field,
    scale: axisScales.default({ x: "linear", y: "linear" }),
    /** one lane of the series alone (its value key); the others fade */
    solo: z.guid().nullable().default(null),
    /** zoomed in, in each axis's own units (times and order: epoch ms and rank) */
    zoom: z.strictObject({ x: axisRange, y: axisRange }).nullable().default(null),
    /** given the table's height (docs/inline-plots-design.md §1); otherwise a row of its card */
    expanded: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    const issue = markIssue(p.mark, p.x, p.y)
    if (issue) ctx.addIssue({ code: "custom", message: issue })
  })
export type PlotState = z.output<typeof plotState>
export type PlotStateInput = z.input<typeof plotState>
