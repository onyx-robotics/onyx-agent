// Generated from packages/core/src/view/workspace.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Workspaces, version 5 (docs/panels-design.md): series cards laid out in a split tree, each card
 * a query (card.ts) and its panels (panel.ts), split again inside it. Browser-safe: the page and the
 * server read the same document.
 *
 * The document holds what every card counts from (its settings), its cards and their panels as
 * laid out (`layout`), and each split's shares (`sizes`, kept apart: a resize changes no
 * structure). What a page shows is its view (`workspaceView`): the document's fields as shown,
 * saved or not, and the viewer's own (each card's time window, what's chosen in it, what's
 * expanded); the page's URL holds what differs from what's saved (url-state.ts).
 *
 * Nothing older is read: a stored document before version 5 opens as the starter, and an address
 * of an older codec as nothing.
 */
import { z } from "zod"

import { card, cardFocus, copyCard, windowKey, type Card } from "./card"
import { type Panel, type PanelKind, type PanelOf } from "./panel"
import { pickWhat } from "./plot"
import { onlyLanes } from "./plot-state"
import type { SeriesSettings } from "./series"
import { viewSpec, type BucketKey } from "./spec"
import {
  findLeaf,
  insertAt,
  leaves,
  mapLeaves,
  moveNode,
  newNodeId,
  nodeId,
  nodeIds,
  removeNode,
  resizeSplit,
  sizesSchema,
  splitNode,
  splits,
  updateLeaf,
  type Edge,
  type Sizes,
  type SplitNode,
} from "./split"
import { readFields, sameValue, urlStateCodec, type Fields } from "./url-state"

/** Cards a workspace holds at most, and how deeply it splits them. */
export const CARDS_MAX = 24
const LAYOUT_DEPTH = 6
const DOC_VERSION = 5

// ---------------------------------------------------------------- the document

/**
 * What every card counts from (the item set, over all time), and where its time axis opens. (A
 * page picks bins by its zoom.)
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

export const workspaceLayout = splitNode(card, { leaves: CARDS_MAX, depth: LAYOUT_DEPTH })

/** Every item, one card: what a new workspace shows. */
export const allItemsCard = (): Card => card.parse({ id: "all" })

const docFields = z.strictObject({
  settings: workspaceSettings.default(DEFAULT_SETTINGS),
  /** its cards as laid out (none: no card, the page says so) */
  layout: workspaceLayout.nullable().default(() => allItemsCard()),
  /** each split's children's shares, by its id (the workspace's splits and every card's) */
  sizes: sizesSchema.default({}),
})

/** What's wrong across a document's trees (each tree's own is its schema's). */
function docIssues(d: { layout: SplitNode<Card> | null }): string[] {
  const ids = [...nodeIds(d.layout), ...leaves(d.layout).flatMap((c) => nodeIds(c.panels))]
  return new Set(ids).size === ids.length ? [] : ["a workspace names a card, panel or split twice"]
}

const checked = <T extends { layout: SplitNode<Card> | null }>(d: T, ctx: z.RefinementCtx) => {
  for (const message of docIssues(d)) ctx.addIssue({ code: "custom", message })
}

export const workspaceDoc = docFields
  .extend({ version: z.literal(DOC_VERSION).default(DOC_VERSION) })
  .superRefine(checked)
export type WorkspaceDoc = z.output<typeof workspaceDoc>
export type WorkspaceDocInput = z.input<typeof workspaceDoc>

/** A document as a client sends it: this version's alone (an older page's save is refused). */
export const workspaceDocInput = workspaceDoc

/** A new workspace: every item, one card. */
export const emptyWorkspace = (): WorkspaceDoc => workspaceDoc.parse({})

/** What a new org's default workspace starts as: its work (activities), one card of all of it. */
export const starterWorkspace = (): WorkspaceDoc =>
  workspaceDoc.parse({ settings: { itemKinds: ["activity"] } })

const isFields = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * How a stored document reads here: whole (`exact`); one before this version, or not a document
 * at all (`legacy`: the starter in its place, writable); or in part (`partial`: a newer version's,
 * or one this version can't read whole). A partial document is shown as far as it can be, each
 * field on its own, and is never written over here (during a deploy an older server reads what a
 * newer one saved).
 */
export type StoredDocRead = "exact" | "legacy" | "partial"

export function readStoredDoc(raw: unknown): { doc: WorkspaceDoc; read: StoredDocRead } {
  const parsed = workspaceDoc.safeParse(raw)
  if (parsed.success) return { doc: parsed.data, read: "exact" }
  const v = isFields(raw) ? raw.version : undefined
  if (!isFields(raw) || typeof v !== "number" || v < DOC_VERSION)
    return { doc: starterWorkspace(), read: "legacy" }
  const { version: _version, ...rest } = raw
  const { version: _empty, ...empty } = emptyWorkspace()
  const { value } = readFields(docFields, rest, empty)
  const doc = docIssues(value).length ? { ...value, layout: empty.layout } : value
  return { doc: { version: DOC_VERSION, ...doc }, read: "partial" }
}

/** What a workspace's cards count with: its item set over all time, in `base` buckets. */
export const countSettings = (s: WorkspaceSettings, base: BucketKey = "1d"): SeriesSettings => ({
  itemTypes: s.itemTypes,
  itemKinds: s.itemKinds,
  spaces: s.spaces,
  statusClasses: s.statusClasses,
  time: {},
  bucket: base,
})

// ---------------------------------------------------------------- the view

/** A time window: its ends, epoch ms. */
const timeWindow = z
  .strictObject({ t0: z.number().int().min(0), t1: z.number().int() })
  .refine((w) => w.t1 > w.t0, "a window ends after it starts")
const timeSetting = viewSpec.shape.time.unwrap()

/** What's picked in a plot panel of a card: its lanes drawn alone, and a brush, lasso or ids. */
export const cardPick = z.strictObject({ panel: nodeId, only: onlyLanes, what: pickWhat })
export type CardPick = z.output<typeof cardPick>

/** What's chosen in a card: its panels show it. */
export const cardView = z.strictObject({
  /** the item chosen (every panel marks it; an inspector shows it) */
  selected: z.guid().nullable().default(null),
  /** what's picked in one of its plots (every panel marks those items) */
  pick: cardPick.nullable().default(null),
  /** the lane its panels look at (none: all of it) */
  focus: cardFocus.nullable().default(null),
})
export type CardView = z.output<typeof cardView>
export const NO_CARD_VIEW: CardView = cardView.parse({})

export const workspaceView = docFields
  .extend({
    /**
     * each card's time window, by its window key (its sync's, or its id; card.ts `windowKey`):
     * zoomed or panned, a time setting it jumped to, or (`span`, ms) moved up to now, which it
     * follows (none: where the time setting opens)
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
      .refine((w) => Object.keys(w).length <= CARDS_MAX, `at most ${CARDS_MAX} windows`)
      .default({}),
    /** what's chosen in each card, by its id */
    cards: z
      .record(nodeId, cardView)
      .refine((c) => Object.keys(c).length <= CARDS_MAX, `at most ${CARDS_MAX} cards`)
      .default({}),
    /** a card (all its panels) or one of its panels filling the workspace */
    expanded: z.strictObject({ card: nodeId, panel: nodeId.optional() }).nullable().default(null),
  })
  .superRefine(checked)
export type WorkspaceView = z.output<typeof workspaceView>
export type CardWindow = WorkspaceView["windows"][string]

const VIEW_DEFAULTS: WorkspaceView = workspaceView.parse({})
const DOC_KEYS = Object.keys(docFields.shape) as (keyof typeof docFields.shape)[]

/** What a workspace shows when its URL holds nothing: its document, the viewer's fields empty. */
export function savedView(doc: WorkspaceDoc): WorkspaceView {
  const { version: _version, ...fields } = doc
  return { ...VIEW_DEFAULTS, ...fields }
}

/** The document a view shows (what "Save as new" keeps): its document's fields, over `saved`. */
export function shownDoc(view: WorkspaceView, saved: WorkspaceDoc): WorkspaceDoc {
  const out: Record<string, unknown> = { ...saved }
  for (const k of DOC_KEYS) out[k] = view[k]
  return out as WorkspaceDoc
}

/** A workspace's view in its page's URL: the fields that differ from what's saved, each whole. */
export const workspaceViewUrl = urlStateCodec(workspaceView, { version: 4 })

/** A view as a client sends it to be shared. */
export const workspaceViewInput = workspaceView

/**
 * A view with what names nothing on it dropped: what's chosen in a card that's gone, a pick in a
 * panel that's gone, an expanded card or panel that's gone, a window no card shows.
 */
export function tidyView(view: WorkspaceView): WorkspaceView {
  const cards = leaves(view.layout)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const keys = new Set(cards.map(windowKey))
  const chosen: Record<string, CardView> = {}
  for (const [id, v] of Object.entries(view.cards)) {
    const c = byId.get(id)
    if (!c) continue
    const pick = v.pick && findLeaf(c.panels, v.pick.panel) ? v.pick : null
    chosen[id] = pick === v.pick ? v : { ...v, pick }
  }
  const windows: WorkspaceView["windows"] = {}
  for (const [k, w] of Object.entries(view.windows)) if (keys.has(k)) windows[k] = w
  const e = view.expanded
  const shown = e && byId.get(e.card)
  const expanded = shown && (!e.panel || findLeaf(shown.panels, e.panel)) ? e : null
  const same =
    expanded === e &&
    Object.keys(chosen).length === Object.keys(view.cards).length &&
    Object.entries(chosen).every(([k, v]) => view.cards[k] === v) &&
    Object.keys(windows).length === Object.keys(view.windows).length
  return same ? view : { ...view, cards: chosen, windows, expanded }
}

// ---------------------------------------------------------------- layout and viewer

/**
 * A workspace's layout: what its cards are and how they're laid out, apart from how far someone
 * has looked into them (docs/ui.md, "Workspaces"). Someone else's workspace takes the viewer's
 * changes in their address alone; the first change to its layout makes them a copy of their own.
 * Each field is one or the other, declared once here: a new field doesn't typecheck until it's
 * classified.
 *
 * Layout: what a card counts (its conditions, splits, text, name), its panels (their kinds, how
 * they're split, a plot's axes, a graph's look), how cards are split, and what the workspace counts
 * from. Viewer: the shares of every split, how many values are listed, values opened and pairs
 * folded, a time sync, a plot's lanes alone, zoom and legend, a graph's solo, a queue's colors,
 * where the time axis opens.
 */
type Role = "layout" | "viewer"

const CARD = {
  id: "layout",
  label: "layout",
  where: "layout",
  by: "layout",
  then: "layout",
  expanded: "viewer",
  limit: "viewer",
  text: "layout",
  synced: "viewer",
  panels: "layout",
} as const satisfies Record<keyof Card, Role>

const THEN = { dim: "layout", closed: "viewer" } as const satisfies Record<
  keyof NonNullable<Card["then"]>,
  Role
>

const PLOT = {
  show: "layout",
  x: "layout",
  y: "layout",
  scale: "layout",
  only: "viewer",
  zoom: "viewer",
} as const satisfies Record<keyof PanelOf<"plot">["plot"], Role>

const NODE = {
  hidden: "layout",
  solo: "viewer",
  color: "layout",
  groupBy: "layout",
  layout: "layout",
  splits: "layout",
} as const satisfies Record<keyof PanelOf<"node">["graph"], Role>

const PANELS = {
  lanes: { id: "layout", kind: "layout" },
  queue: { id: "layout", kind: "layout", color: "viewer" },
  inspector: { id: "layout", kind: "layout" },
  plot: { id: "layout", kind: "layout", plot: "layout", legend: "viewer" },
  node: { id: "layout", kind: "layout", graph: "layout" },
} as const satisfies { [K in PanelKind]: Record<keyof PanelOf<K>, Role> }

const SETTINGS = {
  itemTypes: "layout",
  itemKinds: "layout",
  spaces: "layout",
  statusClasses: "layout",
  time: "viewer",
} as const satisfies Record<keyof WorkspaceSettings, Role>

/** An object's layout fields (by `roles`); a key `roles` doesn't name is kept (it's unknown here). */
function keep(o: object, roles: Record<string, Role>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (roles[k] !== "viewer") out[k] = v
  return out
}

function panelLayout(p: Panel): Record<string, unknown> {
  const out = keep(p, PANELS[p.kind])
  if (p.kind === "plot") out.plot = keep(p.plot, PLOT)
  if (p.kind === "node") out.graph = keep(p.graph, NODE)
  return out
}

/** A card's layout: its layout fields, its split's, and its panels' (laid out as they are). */
export function cardLayout(c: Card): Record<string, unknown> {
  const out = keep(c, CARD)
  if (c.then) out.then = keep(c.then, THEN)
  out.panels = mapLeaves(c.panels, (p) => ({ id: p.id, ...panelLayout(p) }))
  return out
}

export interface WorkspaceLayout {
  layout: unknown
  settings: Record<string, unknown>
}

/** A workspace's layout: its cards' as laid out (shares aside), and its settings' layout fields. */
export function layoutOf(doc: Pick<WorkspaceDoc, "layout" | "settings">): WorkspaceLayout {
  return {
    layout: doc.layout ? mapLeaves(doc.layout, (c) => ({ id: c.id, ...cardLayout(c) })) : null,
    settings: keep(doc.settings, SETTINGS),
  }
}

/** Whether two workspaces differ only in how far someone has looked into them. */
export const sameLayout = (
  a: Pick<WorkspaceDoc, "layout" | "settings">,
  b: Pick<WorkspaceDoc, "layout" | "settings">
) => sameValue(layoutOf(a), layoutOf(b))

// ---------------------------------------------------------------- editing it

/** What the edits below take and give back: a document or a view (its other fields kept). */
type Laid = { layout: SplitNode<Card> | null; sizes: Sizes }

export const cardsOf = (d: Pick<Laid, "layout">): Card[] => leaves(d.layout)
export const cardOf = (d: Pick<Laid, "layout">, id: string): Card | undefined =>
  findLeaf(d.layout, id)

/** The card holding a panel. */
export const cardOfPanel = (d: Pick<Laid, "layout">, panelId: string): Card | undefined =>
  leaves(d.layout).find((c) => findLeaf(c.panels, panelId))

/** One card changed (`f` gives it back as it should be). */
export function editCard<D extends Laid>(d: D, id: string, f: (c: Card) => Card): D {
  if (!d.layout) return d
  const layout = updateLeaf(d.layout, id, f)
  return layout === d.layout ? d : { ...d, layout }
}

/** A card put against another (`target`; null: the whole workspace) on `edge`. */
export function addCard<D extends Laid>(d: D, c: Card, target: string | null, edge: Edge): D {
  const t = insertAt({ root: d.layout, sizes: d.sizes }, target, edge, c)
  return { ...d, layout: t.root, sizes: t.sizes }
}

/** A card taken out, with its panels' shares. */
export function removeCard<D extends Laid>(d: D, id: string): D {
  const c = cardOf(d, id)
  if (!c) return d
  const t = removeNode({ root: d.layout, sizes: d.sizes }, id)
  const sizes = { ...t.sizes }
  for (const s of splits(c.panels)) delete sizes[s.id]
  return { ...d, layout: t.root, sizes }
}

/** A card (or a split of cards) moved against `target` on `edge`. */
export function moveCard<D extends Laid>(d: D, id: string, target: string | null, edge: Edge): D {
  const t = moveNode({ root: d.layout, sizes: d.sizes }, id, target, edge)
  return { ...d, layout: t.root, sizes: t.sizes }
}

/** A copy of a card beside it (to its right), its panels and their shares with it. */
export function duplicateCard<D extends Laid>(d: D, id: string, newId: string = newNodeId()): D {
  const c = cardOf(d, id)
  if (!c) return d
  const { card: copy, ids } = copyCard(c, newId)
  const sizes = { ...d.sizes }
  for (const [from, to] of ids) if (d.sizes[from]) sizes[to] = d.sizes[from]!
  return addCard({ ...d, sizes }, copy, id, "right")
}

/** One panel of a card changed. */
export function editPanel<D extends Laid>(
  d: D,
  cardId: string,
  panelId: string,
  f: (p: Panel) => Panel
): D {
  return editCard(d, cardId, (c) => {
    const panels = updateLeaf(c.panels, panelId, f)
    return panels === c.panels ? c : { ...c, panels }
  })
}

/** A panel put in a card, against one of its panels (null: the whole card) on `edge`. */
export function addPanel<D extends Laid>(
  d: D,
  cardId: string,
  p: Panel,
  target: string | null,
  edge: Edge
): D {
  const c = cardOf(d, cardId)
  if (!c) return d
  const t = insertAt({ root: c.panels, sizes: d.sizes }, target, edge, p)
  return editCard({ ...d, sizes: t.sizes }, cardId, (x) => ({ ...x, panels: t.root! }))
}

/** A panel taken out of its card; a card left with none goes too. */
export function removePanel<D extends Laid>(d: D, panelId: string): D {
  const c = cardOfPanel(d, panelId)
  if (!c) return d
  const t = removeNode({ root: c.panels, sizes: d.sizes }, panelId)
  if (!t.root) return removeCard({ ...d, sizes: t.sizes }, c.id)
  return editCard({ ...d, sizes: t.sizes }, c.id, (x) => ({ ...x, panels: t.root! }))
}

/**
 * A panel moved into a card (its own or another), against one of that card's panels (null: the
 * whole card) on `edge`. A card it leaves with no panels goes. In another card it shows that
 * card's query: a panel is a view of the card it's in.
 */
export function movePanel<D extends Laid>(
  d: D,
  panelId: string,
  toCard: string,
  target: string | null,
  edge: Edge
): D {
  const from = cardOfPanel(d, panelId)
  const to = cardOf(d, toCard)
  if (!from || !to || target === panelId) return d
  if (from.id === to.id) {
    const t = moveNode({ root: from.panels, sizes: d.sizes }, panelId, target, edge)
    return editCard({ ...d, sizes: t.sizes }, from.id, (x) => ({ ...x, panels: t.root! }))
  }
  const p = findLeaf(from.panels, panelId)!
  return addPanel(removePanel(d, panelId), toCard, p, target, edge)
}

/**
 * A panel moved out to a card of its own, against another card (null: the whole workspace) on
 * `edge`: the new card has its card's query (named as it was), so it shows what it showed.
 */
export function panelToCard<D extends Laid>(
  d: D,
  panelId: string,
  target: string | null,
  edge: Edge,
  newId: string = newNodeId()
): D {
  const from = cardOfPanel(d, panelId)
  if (!from) return d
  const p = findLeaf(from.panels, panelId)!
  const { card: copy } = copyCard(from, newId)
  const made: Card = {
    ...copy,
    ...(from.label ? { label: from.label } : {}),
    panels: p,
  }
  const out = removePanel(d, panelId)
  const at = target !== null && !cardOf(out, target) ? null : target
  return addCard(out, made, at, edge)
}

/**
 * One split's shares set, whichever tree it's in (the workspace's, or a card's); none that don't
 * fit it (a split that's gone, shares of another count).
 */
export function resizeShares<D extends Laid>(d: D, splitId: string, shares: number[]): D {
  const trees = [d.layout, ...leaves(d.layout).map((c) => c.panels)]
  for (const root of trees) {
    if (!splits(root).some((s) => s.id === splitId)) continue
    const t = resizeSplit({ root, sizes: d.sizes }, splitId, shares)
    return t.sizes === d.sizes ? d : { ...d, sizes: t.sizes }
  }
  return d
}

/** What the time edits below take and give back: a view (its other fields kept). */
type Timed = Laid & { windows: WorkspaceView["windows"] }

/**
 * A card's time window synced with another's (docs/panels-design.md, "On the page"): they share a
 * window key (the other's sync, else a new one), and show the window the other showed.
 */
export function syncCard<D extends Timed>(d: D, id: string, withId: string, key = newNodeId()): D {
  const a = cardOf(d, id)
  const b = cardOf(d, withId)
  if (!a || !b || id === withId || (a.synced && a.synced === b.synced)) return d
  const shared = b.synced ?? key
  const windows = { ...d.windows }
  const shown = d.windows[windowKey(b)]
  if (shown) windows[shared] = shown
  else delete windows[shared]
  let out = editCard(d, withId, (c) => ({ ...c, synced: shared }))
  out = editCard(out, id, (c) => ({ ...c, synced: shared }))
  return { ...out, windows }
}

/**
 * A card's window its own again (the one it showed, synced); a sync left with one card goes too.
 */
export function unsyncCard<D extends Timed>(d: D, id: string): D {
  const a = cardOf(d, id)
  if (!a?.synced) return d
  const key = a.synced
  const windows = { ...d.windows }
  if (d.windows[key]) windows[id] = d.windows[key]!
  const drop = (c: Card): Card => {
    const { synced: _was, ...rest } = c
    return rest
  }
  let out = editCard(d, id, drop)
  const left = cardsOf(out).filter((c) => c.synced === key)
  if (left.length === 1) {
    if (d.windows[key]) windows[left[0]!.id] = d.windows[key]!
    out = editCard(out, left[0]!.id, drop)
    delete windows[key]
  }
  return { ...out, windows }
}
