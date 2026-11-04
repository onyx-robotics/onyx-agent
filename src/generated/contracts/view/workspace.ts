// Generated from packages/core/src/view/workspace.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Workspaces: a list of series, each a query of the org's items (docs/lane-series-design.md; the
 * series: series.ts). Browser-safe: the page and the server compile the same document.
 *
 * The document holds what the workspace counts from (its settings) and its pinned series, keys and
 * never labels; it compiles to one view of lanes (no columns) that runs with the viewer's context,
 * so what each viewer sees follows their own spaces. Every lane counts all time: the time setting
 * is where the page's time axis opens, which it zooms and pans from. What a page shows is its view
 * (`workspaceView`): the document's fields as shown, saved or not, and the viewer's own; the page's
 * URL holds what differs from what's saved (url-state.ts).
 *
 * Until version 3 a workspace was a tree (tree.ts): a document of version 2, and an address of
 * version 1, are read as the series their tree converts to (`seriesFromTree`). Until version 4
 * every item was a series shown first where a workspace didn't list it, and never removed: a
 * document of version 3, and an address of version 2, are read with it listed (`withAllItems`).
 */
import { z } from "zod"

import { pickState, plotState } from "./plot"
import {
  compileSeries,
  focusFromTree,
  seriesFocus,
  allItemsSeries,
  seriesFromTree,
  setPlot,
  windowKeys,
  withAllItems,
  workspaceSeries,
  type CompiledSeries,
  type Series,
  type SeriesSettings,
} from "./series"
import { MAX_LANE_REFS, nodeRef, viewSpec, type BucketKey } from "./spec"
import { TREE_DEPTH_MAX, workspaceTree } from "./tree"
import { readFields, urlStateCodec, type Fields } from "./url-state"

/**
 * What every lane of the workspace counts from (the view's item set, over all time), and where its
 * time axis opens. (An older document's bucket is dropped: the page picks bins by its zoom.)
 */
export const workspaceSettings = viewSpec
  .pick({ itemTypes: true, itemKinds: true, spaces: true, statusClasses: true })
  .extend({
    /** where the time axis opens: the last N days up to now, a range, or (no start) all of it */
    time: viewSpec.shape.time.unwrap().default({}),
  })
export type WorkspaceSettings = z.output<typeof workspaceSettings>

const DEFAULT_SETTINGS: WorkspaceSettings = {
  itemTypes: [],
  itemKinds: [],
  spaces: [],
  statusClasses: [],
  time: {},
}

/** A time window: its ends, epoch ms. */
const timeWindow = z
  .strictObject({ t0: z.number().int().min(0), t1: z.number().int() })
  .refine((w) => w.t1 > w.t0, "a window ends after it starts")
/** A time setting: the last N days up to now, a range, or (no start) all of it. */
const timeSetting = viewSpec.shape.time.unwrap()
/** The cards' windows an address holds at most. */
const MAX_WINDOWS = 64
export type CardWindow = z.output<typeof workspaceView>["windows"][string]

/**
 * The cards' windows (by key) once the series' syncs change from `was` to `next`, a sync made from
 * `from`'s chips: a card whose key changes takes its window there (none: the setting's), save that
 * a sync's window is `from`'s, the one each card joining it shows.
 */
export function syncedWindows(
  was: readonly Series[],
  next: readonly Series[],
  from: string,
  windows: Readonly<Record<string, CardWindow>>
): Record<string, CardWindow> {
  const before = windowKeys(was)
  const after = windowKeys(next)
  const out = { ...windows }
  // (from's key kept: the sync's window is its, none joining it takes it over)
  const kept = after.get(from)
  const done = new Set<string>(kept && kept === before.get(from) ? [kept] : [])
  for (const id of [from, ...next.map((s) => s.id)]) {
    const k = after.get(id)
    const b = before.get(id)
    if (!k || !b || k === b || done.has(k)) continue
    done.add(k)
    const w = windows[b]
    if (w) out[k] = w
    else delete out[k]
  }
  return out
}

/** The version of the document this code writes (2: a tree; 3: series; 4: every item listed). */
const DOC_VERSION = 4

export const workspaceDoc = z.strictObject({
  version: z.literal(DOC_VERSION).default(DOC_VERSION),
  settings: workspaceSettings.default(DEFAULT_SETTINGS),
  /** the pinned series: what everyone who opens the workspace starts from (none: every item) */
  series: workspaceSeries.default(() => [allItemsSeries()]),
})
export type WorkspaceDoc = z.output<typeof workspaceDoc>
export type WorkspaceDocInput = z.input<typeof workspaceDoc>

const isFields = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * A document of version 2 as this version reads it: its tree as series. A tree that isn't one is
 * left where the series go, for the read to refuse (and say so).
 */
function docFromTree(fields: Fields): Fields {
  const { tree, ...rest } = fields
  const t = workspaceTree.safeParse(tree ?? { series: [] })
  return { ...rest, version: DOC_VERSION, series: t.success ? seriesFromTree(t.data) : tree }
}

/**
 * A document of version 3 as this version reads it: every item listed first, where it isn't (it
 * was shown there). Series that aren't a list are left, for the read to refuse.
 */
function docFromV3(fields: Fields): Fields {
  const out: Fields = { ...fields, version: DOC_VERSION }
  if (Array.isArray(out.series)) out.series = withAllItems(out.series as never)
  return out
}

/** An older document's fields as this version reads them (2: a tree; 3: every item unlisted). */
function docFromOlder(fields: Fields): Fields {
  const v3 = fields.version === 2 ? { ...docFromTree(fields), version: 3 } : fields
  return v3.version === 3 ? docFromV3(v3) : v3
}

/**
 * A document as a client sends it: this version's, or version 2's or 3's (a page loaded before a
 * deploy keeps saving: what it sends is converted, which loses nothing).
 */
export const workspaceDocInput = z.preprocess(
  (raw) => (isFields(raw) && (raw.version === 2 || raw.version === 3) ? docFromOlder(raw) : raw),
  workspaceDoc
)

/** A new workspace: every item, one card. */
export const emptyWorkspace = (): WorkspaceDoc => workspaceDoc.parse({})

/**
 * What a new org's default workspace starts as: its work (activities: experiments, runs, tests),
 * opened on all of it, split by type and by status. Every org has these dims, whatever its packs.
 */
export const starterWorkspace = (): WorkspaceDoc =>
  workspaceDoc.parse({
    settings: { itemKinds: ["activity"] },
    series: [{ id: "all" }, { id: "type", by: "@type" }, { id: "status", by: "@status" }],
  })

/**
 * What a workspace page shows: every field of the document as shown (its settings and every
 * series, pinned or not; saved or not), and the viewer's own fields, which aren't saved. A field
 * added to the document is a field of the view; one the viewer keeps to themselves (and a link
 * carries) is added here, with a default.
 */
export const workspaceView = workspaceDoc.omit({ version: true }).extend({
  /** the values every lane shows how many of its items have (the page highlights one) */
  highlight: z.array(nodeRef).max(MAX_LANE_REFS).default([]),
  /**
   * the time window shown where `windows` says none, zoomed or panned (epoch ms); null: where the
   * time setting opens (an address before each card had its own: every card's)
   */
  window: timeWindow.nullable().default(null),
  /**
   * each card's time window (synced cards' one; series.ts `windowKeys`), by its key (its series'
   * id, or its sync's): zoomed or panned, a time setting it jumped to, or (`span`, ms) moved up to
   * now, which it follows (none: `window`'s)
   */
  windows: z
    .record(
      z.string(),
      z.union([
        timeWindow,
        z.strictObject({ time: timeSetting }),
        z.strictObject({ span: z.number().int().positive() }),
      ])
    )
    .refine((w) => Object.keys(w).length <= MAX_WINDOWS, `at most ${MAX_WINDOWS} windows`)
    .default({}),
  /**
   * what the page lists beside the lanes (none: every item): a series' lanes, its total or one of
   * its lanes, by the series' id (so it follows the series as it's edited); or a lane by its
   * conditions (an older link's)
   */
  focus: seriesFocus.nullable().default(null),
  /**
   * an older address's plot, of what was listed (its focus: a series, one of its lanes, or every
   * item): read, never written; `liftPlot` moves it where a plot is now
   */
  plot: plotState.nullable().default(null),
  /** what's picked in a plot (a brush, a lasso, points), of the series it was made in */
  pick: pickState.nullable().default(null),
})
export type WorkspaceView = z.output<typeof workspaceView>

const VIEW_DEFAULTS: WorkspaceView = workspaceView.parse({})
const DOC_FIELDS = Object.keys(workspaceDoc.shape).filter((k) => k !== "version")

/** What a workspace shows when its URL holds nothing: its document, the viewer's fields empty. */
export function savedView(doc: WorkspaceDoc): WorkspaceView {
  const { version: _version, ...fields } = doc
  return { ...VIEW_DEFAULTS, ...fields }
}

/** What an address of version 1 listed beside the lanes: a lane by its path, or a heading. */
const treeFocus = z
  .strictObject({
    path: z.array(nodeRef).max(TREE_DEPTH_MAX),
    dim: z.string().min(1).optional(),
  })
  .nullable()

/**
 * An address of version 1 (a tree) as version 2 reads it: its tree as series, its focus (and the
 * focus its pick was made in) as series name it; its plot as it was. A field that isn't valid
 * stays as it was, for the read to report.
 */
function viewFromTree(fields: Fields): Fields {
  const out: Fields = { ...fields }
  if ("tree" in out) {
    const t = workspaceTree.safeParse(out.tree)
    out.series = t.success ? seriesFromTree(t.data) : out.tree
    delete out.tree
  }
  if ("focus" in out) {
    const f = treeFocus.safeParse(out.focus)
    if (f.success) out.focus = focusFromTree(f.data)
  }
  if (isFields(out.pick) && "scope" in out.pick) {
    const f = treeFocus.safeParse(out.pick.scope)
    if (f.success) out.pick = { ...out.pick, scope: focusFromTree(f.data) }
  }
  return out
}

/**
 * An address of version 2 as version 3 reads it: series it holds with every item first, where they
 * don't list it (it was shown there). One that holds none shows what's saved, which lists it.
 */
function viewFromV2(fields: Fields): Fields {
  if (!Array.isArray(fields.series)) return fields
  return { ...fields, series: withAllItems(fields.series as never) }
}

/** Whether a view a client sent still names a tree, its focus or its pick's focus by path. */
const namesTree = (raw: Fields): boolean =>
  "tree" in raw ||
  (isFields(raw.focus) && "path" in raw.focus) ||
  (isFields(raw.pick) && isFields(raw.pick.scope) && "path" in raw.pick.scope)

/**
 * A view with an older address's plot (the view's, of its focus) where a plot is now: on the
 * series its focus names (its lane, if it named one, soloed), or every item's when it named none
 * (an older address lists it: `viewFromV2`), expanded (it took the table). One whose series isn't
 * shown is dropped.
 */
export function liftPlot(view: WorkspaceView): WorkspaceView {
  if (!view.plot) return view
  const plot = { ...view.plot, expanded: true }
  const f = view.focus
  const id = f ? ("series" in f ? f.series : null) : allItemsSeries().id
  if (!id || !view.series.some((s) => s.id === id)) return { ...view, plot: null }
  if (!f || !("series" in f)) return { ...view, plot: null, series: setPlot(view.series, id, plot) }
  const solo = f.lane && f.lane !== "total" ? f.lane.value : plot.solo
  return { ...view, plot: null, series: setPlot(view.series, id, { ...plot, solo }) }
}

/** A workspace's view in its page's URL: the fields that differ from what's saved, each whole. */
export const workspaceViewUrl = urlStateCodec(workspaceView, {
  version: 3,
  migrations: { 1: viewFromTree, 2: viewFromV2 },
})

/**
 * A view as a client sends it to be shared: this version's, or (a page loaded before a deploy)
 * one with a tree, converted.
 */
export const workspaceViewInput = z.preprocess(
  (raw) => (isFields(raw) && namesTree(raw) ? viewFromTree(raw) : raw),
  workspaceView
)

/** The document a view shows (what "Save as new" keeps): its document's fields, over `saved`. */
export function shownDoc(view: WorkspaceView, saved: WorkspaceDoc): WorkspaceDoc {
  const out: Record<string, unknown> = { ...saved }
  for (const k of DOC_FIELDS) out[k] = view[k as keyof WorkspaceView]
  return out as WorkspaceDoc
}

/**
 * How a stored document reads here: whole (`exact`, a version 2 document's tree as series too); a
 * version 1 document, the canvas, or not a document at all (`legacy`: the starter in its place, as
 * it always was); or in part (`partial`: a newer version's, or one this version can't read
 * whole). A partial document is shown as far as it can be, each field on its own (url-state.ts
 * `readFields`), and is never written over here: during a deploy an older server reads what a
 * newer one saved, and its owner's next save would replace the document with what this version
 * could make of it. A change to what a version accepts migrates the documents it would no longer
 * read.
 */
export type StoredDocRead = "exact" | "legacy" | "partial"

const docFields = workspaceDoc.omit({ version: true })

export function readStoredDoc(raw: unknown): { doc: WorkspaceDoc; read: StoredDocRead } {
  const parsed = workspaceDoc.safeParse(raw)
  if (parsed.success) return { doc: parsed.data, read: "exact" }
  let fields = isFields(raw) ? raw : null
  const v = fields?.version
  if (!fields || (typeof v === "number" && v < 2))
    return { doc: starterWorkspace(), read: "legacy" }
  if (v === 2 || v === 3) {
    fields = docFromOlder(fields)
    const migrated = workspaceDoc.safeParse(fields)
    if (migrated.success) return { doc: migrated.data, read: "exact" }
  }
  const { version: _version, ...rest } = fields
  const { version: _empty, ...empty } = emptyWorkspace()
  const { value } = readFields(docFields, rest, empty)
  return { doc: { version: DOC_VERSION, ...value }, read: "partial" }
}

/**
 * What a workspace's series count with: its item set over all time, in `base` buckets (the page
 * draws coarser bins by summing them, and asks for finer ones over the window it shows).
 */
export const seriesSettings = (s: WorkspaceSettings, base: BucketKey = "1d"): SeriesSettings => ({
  itemTypes: s.itemTypes,
  itemKinds: s.itemKinds,
  spaces: s.spaces,
  statusClasses: s.statusClasses,
  time: {},
  bucket: base,
})

/** A workspace's view: its settings, the scope lane, and each open series' lanes. */
export const compileWorkspace = (
  doc: Pick<WorkspaceDoc, "series" | "settings">,
  base: BucketKey = "1d"
): CompiledSeries => compileSeries(doc.series, seriesSettings(doc.settings, base))
