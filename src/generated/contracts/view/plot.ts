// Generated from packages/core/src/view/plot.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Workspace plots (docs/plots-design.md; docs/SEMANTICS.md, "Plots"): a lane series' items drawn
 * with other axes than time and lane. Browser-safe: the page, the server and the URL share these
 * schemas, the sample rule, the grid's cells and how a pick is evaluated, so the browser and SQL
 * place and pick the same items.
 */
import { z } from "zod"

import {
  axisRange as range,
  axisScales as scales,
  field,
  onlyFromSolo,
  onlyLanes,
  timeOf,
  type Field,
  type FieldInput,
  type ScaleKind,
} from "./plot-state"
import { seriesFocus } from "./series"
import type { MatchPlan, ViewResult } from "./types"

export * from "./plot-state"

/** The most vertices a lasso keeps (simplified before it's written). */
export const LASSO_MAX = 64
/** The most points picked one by one. */
export const PICK_IDS_MAX = 200

export const pickWhat = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("brush"),
    x: field,
    y: field.nullable(),
    xr: range.nullable(),
    yr: range.nullable(),
    scale: scales,
  }),
  z.strictObject({
    kind: z.literal("lasso"),
    x: field,
    y: field,
    scale: scales,
    polygon: z
      .array(z.tuple([z.number(), z.number()]))
      .min(3)
      .max(LASSO_MAX),
  }),
  z.strictObject({ kind: z.literal("ids"), ids: z.array(z.guid()).min(1).max(PICK_IDS_MAX) }),
])
export type PickWhat = z.output<typeof pickWhat>

/**
 * What's picked in a plot (the view's `pick` field): a brush, a lasso (in the axes' transformed
 * units: log₁₀ on a log scale) or ids, of the items of the series it was made in (its scope: the
 * focus it was made in, a series, one of its lanes, or an older link's lane by its conditions; and
 * the lanes drawn alone, an older link's one lane alone as those), wherever they're drawn.
 */
export const pickState = z.preprocess(
  (raw) =>
    typeof raw === "object" && raw !== null ? onlyFromSolo(raw as Record<string, unknown>) : raw,
  z.strictObject({
    scope: seriesFocus.nullable(),
    only: onlyLanes,
    what: pickWhat,
  })
)
export type PickState = z.output<typeof pickState>

/** A field as a key (maps, columns, query keys, the API). */
export function fieldKey(f: FieldInput): string {
  switch (f.k) {
    case "time":
      return f.of ?? "t"
    case "order":
      return `order:${f.of ?? "t"}`
    case "duration":
      return "duration"
    case "metric":
      return `m:${f.key}:${f.context ?? "-"}`
    case "prop":
      return `p:${f.key}`
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A key back as a field (null: not one). */
export function parseFieldKey(key: string): Field | null {
  if (key === "t" || key === "ended" || key === "recorded") return { k: "time", of: key }
  if (key === "duration") return { k: "duration" }
  if (key.startsWith("order:")) {
    const of = timeOf.safeParse(key.slice(6))
    return of.success ? { k: "order", of: of.data } : null
  }
  if (key.startsWith("p:") && key.length > 2) return { k: "prop", key: key.slice(2) }
  if (key.startsWith("m:")) {
    const at = key.lastIndexOf(":")
    const ctx = key.slice(at + 1)
    const k = key.slice(2, at)
    if (!k || at <= 2) return null
    if (ctx === "-") return { k: "metric", key: k, context: null }
    return GUID.test(ctx) ? { k: "metric", key: k, context: ctx.toLowerCase() } : null
  }
  return null
}

// ----------------------------------------------------------------------------------- the sample

const rot = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0

/**
 * An item's place in a plot's sample: its id's hash, as Postgres's `uuid_hash` computes it
 * (lookup3 over the uuid's 16 bytes, on a little-endian machine; onyx_private.sample_bits), so the
 * browser and SQL agree on which items a sample holds (a test holds them equal). Unsigned.
 */
export function sampleBits(id: string): number {
  const hex = id.replace(/-/g, "")
  const word = (i: number) => {
    const o = i * 8
    const b = (j: number) => parseInt(hex.slice(o + j * 2, o + j * 2 + 2), 16)
    return (b(0) | (b(1) << 8) | (b(2) << 16) | (b(3) << 24)) >>> 0
  }
  let a = (0x9e3779b9 + 16 + 3923095) >>> 0
  let b = a
  let c = a
  a = (a + word(0)) >>> 0
  b = (b + word(1)) >>> 0
  c = (c + word(2)) >>> 0
  // mix
  a = ((a - c) ^ rot(c, 4)) >>> 0
  c = (c + b) >>> 0
  b = ((b - a) ^ rot(a, 6)) >>> 0
  a = (a + c) >>> 0
  c = ((c - b) ^ rot(b, 8)) >>> 0
  b = (b + a) >>> 0
  a = ((a - c) ^ rot(c, 16)) >>> 0
  c = (c + b) >>> 0
  b = ((b - a) ^ rot(a, 19)) >>> 0
  a = (a + c) >>> 0
  c = ((c - b) ^ rot(b, 4)) >>> 0
  b = (b + a) >>> 0
  // the last four bytes
  a = (a + word(3)) >>> 0
  // final
  c = ((c ^ b) - rot(b, 14)) >>> 0
  a = ((a ^ c) - rot(c, 11)) >>> 0
  b = ((b ^ a) - rot(a, 25)) >>> 0
  c = ((c ^ b) - rot(b, 16)) >>> 0
  a = ((a ^ c) - rot(c, 4)) >>> 0
  b = ((b ^ a) - rot(a, 14)) >>> 0
  c = ((c ^ b) - rot(b, 24)) >>> 0
  return c
}

/**
 * Is an item in a sample of 1 in `rate` (a power of two)? Its hash's low bits are zero: so a
 * denser sample holds every item of a sparser one, and whether a new item belongs is known from
 * its id alone.
 */
export const inSample = (id: string, rate: number) => (sampleBits(id) & (rate - 1)) === 0

/** The most items a frame holds (about 2–3 MB with every field). */
export const FRAME_MAX = 20_000

/** Is `n` a power of two (≥ 1)? */
export const isPow2 = (n: number) => Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0

/**
 * The sample rate for a scope of `count` items: the smallest power of two that brings it to at
 * most `max`. Given the rate in use, it's kept while the scope stays within a quarter past `max`
 * and above half of it, so a scope growing live doesn't refetch at every crossing.
 */
export function rateFor(count: number, prev: number | null = null, max = FRAME_MAX): number {
  if (prev !== null && isPow2(prev)) {
    const n = count / prev
    if (n <= max * 1.25 && (prev === 1 || n > max / 2)) return prev
  }
  let rate = 1
  while (count / rate > max) rate *= 2
  return rate
}

// ------------------------------------------------------------------------------------- the grid

/** Cells across a grid of level 0; each level doubles them, so levels nest exactly. */
export const GRID_N = 128
/** Bins of a lane's marginal over an axis's domain. */
export const MARGINAL_BINS = 256
/** A cell with at most this many items sends them (outliers are always real points). */
export const OUTLIER_N = 3
/** The most outliers a grid sends. */
export const OUTLIERS_MAX = 5000

/** Cells across at a level. */
export const cellsAt = (level: number) => GRID_N * 2 ** level

/** A value on an axis's scale: log₁₀ on a log scale (null when it isn't positive). */
export function transform(v: number | null | undefined, scale: ScaleKind): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  if (scale === "log") return v > 0 ? Math.log10(v) : null
  return v
}

/**
 * The bin of `u` among `n` across [lo, hi] (the last includes hi), or null outside it. The same
 * arithmetic as the SQL (onyx_private.plot_bin), in the same order.
 */
export function binOf(u: number | null, lo: number, hi: number, n: number): number | null {
  if (u === null || u < lo || u > hi) return null
  return Math.min(n - 1, Math.floor(((u - lo) / (hi - lo)) * n))
}

const NICE = [1, 2, 2.5, 5, 10]

/**
 * A domain about [lo, hi] on round numbers (about eight steps), with a little room past the
 * largest value. An empty or single-valued extent gets a span of its own.
 */
export function niceDomain(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  if (hi < lo) [lo, hi] = [hi, lo]
  if (hi === lo) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1
    lo -= pad
    hi += pad
  }
  const raw = (hi - lo) / 8
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = (NICE.find((s) => s * mag >= raw) ?? 10) * mag
  const a = Math.floor(lo / step) * step
  let b = Math.ceil(hi / step) * step
  if (b - hi < step * 0.02) b += step
  return [round(a, step), round(b, step)]
}

/** Floating noise off a multiple of a step (0.30000000000000004 → 0.3). */
const round = (v: number, step: number) => {
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 2)
  return Number(v.toFixed(Math.min(20, digits)))
}

/**
 * A domain grown to hold [lo, hi]: it never shrinks while live, and grows by steps of √2 of its
 * span on the side that needs it, so a plot's grid and scale change rarely.
 */
export function growDomain(d: [number, number], lo: number, hi: number): [number, number] {
  let [a, b] = d
  const span = () => b - a
  while (hi > b) b = a + span() * Math.SQRT2
  while (lo < a) a = b - span() * Math.SQRT2
  return a === d[0] && b === d[1] ? d : [a, b]
}

// ------------------------------------------------------------------------------------- picks

/**
 * A lasso as both sides evaluate it: its bounding box and its vertices mapped into it ×1000, so
 * Postgres's point-in-polygon (which compares within 1e-6) works whatever the axes' units.
 */
export interface NormPolygon {
  box: [number, number, number, number]
  pts: [number, number][]
}

export function normPolygon(polygon: readonly (readonly [number, number])[]): NormPolygon | null {
  const xs = polygon.map((p) => p[0])
  const ys = polygon.map((p) => p[1])
  const box: [number, number, number, number] = [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ]
  if (!(box[2] > box[0] && box[3] > box[1])) return null
  return { box, pts: polygon.map(([x, y]) => normPoint(box, x, y)) }
}

/** A point in a lasso's normalized space (onyx_private.plot_pick_sql does the same). */
export const normPoint = (box: NormPolygon["box"], x: number, y: number): [number, number] => [
  ((x - box[0]) / (box[2] - box[0])) * 1000,
  ((y - box[1]) / (box[3] - box[1])) * 1000,
]

/** The polygon as Postgres reads it. */
export const polygonText = (p: NormPolygon) => `(${p.pts.map(([x, y]) => `(${x},${y})`).join(",")})`

const EPSILON = 1e-6
const fpZero = (a: number) => Math.abs(a) <= EPSILON
const fpGt = (a: number, b: number) => a - b > EPSILON
const fpLt = (a: number, b: number) => b - a > EPSILON
const fpGe = (a: number, b: number) => b - a <= EPSILON
const fpLe = (a: number, b: number) => a - b <= EPSILON
const ON = Number.MAX_SAFE_INTEGER

/** Postgres's lseg_crossing (geo_ops.c): how a segment crosses the positive x axis. */
function crossing(x: number, y: number, px: number, py: number): number {
  if (fpZero(y)) {
    if (fpZero(x)) return ON
    if (fpGt(x, 0)) {
      if (fpZero(py)) return fpGt(px, 0) ? 0 : ON
      return fpLt(py, 0) ? 1 : -1
    }
    if (fpZero(py)) return fpLt(px, 0) ? 0 : ON
    return 0
  }
  const ySign = fpGt(y, 0) ? 1 : -1
  if (fpZero(py)) return fpLt(px, 0) ? 0 : ySign
  if ((ySign < 0 && fpLt(py, 0)) || (ySign > 0 && fpGt(py, 0))) return 0
  if (fpGe(x, 0) && fpGt(px, 0)) return 2 * ySign
  if (fpLt(x, 0) && fpLe(px, 0)) return 0
  const z = (x - px) * y - (y - py) * x
  if (fpZero(z)) return ON
  if ((ySign < 0 && fpLt(z, 0)) || (ySign > 0 && fpGt(z, 0))) return 0
  return 2 * ySign
}

/** `point <@ polygon` as Postgres decides it (point_inside: on an edge counts as in). */
export function pointInPolygon(x: number, y: number, pts: readonly [number, number][]): boolean {
  if (pts.length < 3) return false
  const x0 = pts[0]![0] - x
  const y0 = pts[0]![1] - y
  let px = x0
  let py = y0
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const cx = pts[i]![0] - x
    const cy = pts[i]![1] - y
    const c = crossing(cx, cy, px, py)
    if (c === ON) return true
    total += c
    px = cx
    py = cy
  }
  const c = crossing(x0, y0, px, py)
  if (c === ON) return true
  return total + c !== 0
}

/** Does an item with these (transformed) values match what's picked? Its scope is checked apart. */
export function pickMatches(
  what: PickWhat,
  item: { id: string; x: number | null; y: number | null },
  lasso: NormPolygon | null = what.kind === "lasso" ? normPolygon(what.polygon) : null
): boolean {
  switch (what.kind) {
    case "ids":
      return what.ids.includes(item.id)
    case "brush": {
      if (what.xr && (item.x === null || item.x < what.xr[0] || item.x > what.xr[1])) return false
      if (what.yr && (item.y === null || item.y < what.yr[0] || item.y > what.yr[1])) return false
      return !!(what.xr || what.yr)
    }
    case "lasso": {
      if (!lasso || item.x === null || item.y === null) return false
      const [bx0, by0, bx1, by1] = lasso.box
      if (item.x < bx0 || item.x > bx1 || item.y < by0 || item.y > by1) return false
      const [nx, ny] = normPoint(lasso.box, item.x, item.y)
      return pointInPolygon(nx, ny, lasso.pts)
    }
  }
}

// ----------------------------------------------------------------------------------- results

/** What a plot read was computed from: its snapshot, as a view's (the resync protocol reads it). */
export interface PlotMeta {
  asOf: string
  snapshot: ViewResult["snapshot"]
  registryVersion: number
  visibilityGen: number
}

export type FieldKind = "time" | "order" | "duration" | "metric" | "prop"

/** A field the scope's items carry, with exact counts. */
export interface FieldInfo {
  key: string
  kind: FieldKind
  label: string
  unit: string | null
  better: "higher" | "lower" | null
  /** a metric's context */
  context: { id: string; name: string } | null
  /** items with a value */
  count: number
  min: number | null
  max: number | null
  /** the smallest positive value (a log scale's start) */
  minPositive: number | null
}

export interface FieldsResult extends PlotMeta {
  /** the scope's items in the window */
  scope: number
  fields: FieldInfo[]
}

/** A sample of the scope's items with every field, in columns aligned with `ids`. */
export interface FrameResult extends PlotMeta {
  rate: number
  ids: string[]
  names: (string | null)[]
  /** serving row t, epoch ms */
  t: number[]
  ty: number[]
  /** index into `spaces` */
  sp: number[]
  spaces: string[]
  st: (string | null)[]
  /** each row's facet ids that the view's plan names (enough for `contrib`) */
  v: number[][]
  /** dims with a restricted association the viewer can't see */
  rs: (number[] | null)[]
  /** matches the view's highlight */
  hl: boolean[]
  /** field key → values (times: epoch ms; duration: s); fields no item carries are left out */
  cols: Record<string, (number | null)[]>
  /** order ranks asked for (order:<time>) */
  order: Record<string, (number | null)[]>
  /** the metric contexts its columns name */
  contexts: { id: string; name: string }[]
  /** more items matched than a frame holds: the rest are left out */
  truncated: boolean
  /**
   * how its rows place on the view's lanes, as of its own snapshot (as a view carries its own):
   * deltas past it are placed with it too
   */
  match: MatchPlan
}

/** Rows like a frame's, for the items of sparse cells. */
export interface OutlierRows {
  ids: string[]
  names: (string | null)[]
  t: number[]
  ty: number[]
  sp: number[]
  spaces: string[]
  st: (string | null)[]
  v: number[][]
  rs: (number[] | null)[]
  hl: boolean[]
  pk: boolean[]
  x: (number | null)[]
  y: (number | null)[]
  /** the scope's lanes each is in */
  lanes: string[][]
}

/** Exact counts of the scope over an encoding: cells, marginals, coverage, outliers. */
export interface GridResult extends PlotMeta {
  domain: { x: [number, number] | null; y: [number, number] | null }
  /** cells across at its level */
  size: number
  /** the cells with items (columns), `by`: per color (the request's order), then the rest */
  cells: {
    ix: number[]
    iy: number[]
    n: number[]
    h: number[]
    pk: number[]
    mt: number[]
    by: number[][]
  }
  /** per scope lane, over each value axis asked for (MARGINAL_BINS bins over its domain) */
  marginals: { x: Record<string, number[]>; y: Record<string, number[]> }
  coverage: {
    scope: number
    x: number
    y: number
    both: number
    nonPositive: { x: number; y: number }
    /** values outside the domain */
    outside: number
  }
  /** the values' extent (transformed) */
  extent: { x: [number, number] | null; y: [number, number] | null }
  outliers: OutlierRows
  truncated: boolean
}

/**
 * Each lane's best so far of a metric, whole: the items that set a record in a lane, in order along
 * x (its time, in epoch ms; y on its scale), and where each lane's values end along x (lanes with
 * no value left out; a metric with no direction: none).
 */
export interface BestResult extends PlotMeta {
  records: OutlierRows
  ends: { key: string; end: number }[]
}

/** Picked items per lane and bucket. */
export interface PickCountsResult extends PlotMeta {
  lanes: { key: string; buckets: [number, number][] }[]
  total: number
}
