// Generated from packages/core/src/view/plot-state.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * What a plot shows (docs/plots-design.md §4, §5; docs/inline-plots-design.md): the fields an
 * axis can show, what it draws of them, and a plot's state. Apart from plot.ts so a Plot panel
 * (panel.ts) can hold its plot: plot.ts names cards' lanes in its picks. Browser-safe.
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

/** What a plot draws: its items' points, each lane's best so far, or both. */
export const plotShow = z.enum(["both", "points", "best"])
export type PlotShow = z.output<typeof plotShow>

/** Whether these axes can show a best so far: time or order across, a metric up. */
export const canBest = (x: Field, y: Field) =>
  (x.k === "time" || x.k === "order") && y.k === "metric"

/** A range along an axis, low to high. */
export const axisRange = z
  .tuple([z.number(), z.number()])
  .refine(([a, b]) => b > a, "a range ends after it starts")

/** The most lanes of a series a plot draws alone (their value keys are in its address). */
export const ONLY_MAX = 64

/** Lanes of a series alone (their value keys); the others aren't drawn. None: every lane. */
export const onlyLanes = z.array(z.guid()).max(ONLY_MAX).default([])

const plotFields = z.strictObject({
  /** what it draws, where its axes can show it (only points, where they can't a best so far) */
  show: plotShow.default("both"),
  x: field,
  y: field,
  scale: axisScales.default({ x: "linear", y: "linear" }),
  only: onlyLanes,
  /** zoomed in, in each axis's own units (times and order: epoch ms and rank) */
  zoom: z.strictObject({ x: axisRange, y: axisRange }).nullable().default(null),
})

/** An older document's or address's one lane alone (`solo`) as `only`, that lane. */
export function onlyFromSolo(raw: Record<string, unknown>): Record<string, unknown> {
  if (!("solo" in raw)) return raw
  const { solo, ...p } = raw
  return { ...p, only: solo === null ? [] : [solo] }
}

/**
 * A plot as older documents and addresses hold it, as this version reads it: its one lane alone
 * is `only` that lane; `expanded` goes (it's a row of its card), and so does its `mark` (a strip, a
 * distribution or a trend draws as `show`'s default), with a strip's or a distribution's lane axis:
 * time across, its value up on its scale, unzoomed.
 */
function fromOlder(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw
  if (!("mark" in raw) && !("expanded" in raw)) return onlyFromSolo(raw as Record<string, unknown>)
  const { mark: _mark, expanded: _expanded, ...p } = onlyFromSolo(raw as Record<string, unknown>)
  const isLane = (f: unknown) => (f as { k?: unknown } | null | undefined)?.k === "lane"
  if (!isLane(p.x) && !isLane(p.y)) return p
  const value = isLane(p.y) ? "x" : "y"
  const scale = p.scale as Partial<Record<"x" | "y", unknown>> | null | undefined
  return {
    ...p,
    x: { k: "time", of: "t" },
    y: p[value],
    scale: { x: "linear", y: scale?.[value] ?? "linear" },
    zoom: null,
  }
}

/** What a plot shows (the view's `plot` field; null: the lanes). */
export const plotState = z.preprocess(fromOlder, plotFields)
export type PlotState = z.output<typeof plotFields>
export type PlotStateInput = z.input<typeof plotFields>
