// Generated from packages/core/src/view/card.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Series cards (docs/panels-design.md): a query of the org's items and the panels that show it.
 * The query is the card's conditions, the dim it's split by (a lane per value, its busiest
 * `limit`), optionally a second that splits each value again (pairs), and the hierarchy values it
 * opens in place. Its panels are views of it, laid out in a split tree; they share the card's
 * header, its time window and what's chosen in it (workspace-doc.ts, the view's `cards`).
 * Browser-safe.
 *
 * A card compiles to a view of its own (`compileCard`): editing one card changes what no other
 * card reads.
 */
import { z } from "zod"

import { newPanel, panel, DEFAULT_PANEL, type Panel } from "./panel"
import {
  countedTime,
  EXPANDED_MAX,
  groupLaneKey,
  parentOf,
  seriesGroup,
  seriesText,
  SERIES_LIMIT,
  type SeriesGroup,
  type SeriesQueryOf,
  type SeriesSettings,
  type SeriesText,
} from "./series"
import {
  canonicalWhere,
  groupKey,
  MAX_GROUPS,
  MAX_LANE_REFS,
  MAX_LANE_REFS_TOTAL,
  pinnedKey,
  refCount,
  viewWhere,
  type LaneGroupInput,
  type ViewSpecInput,
  type ViewWhereInput,
} from "./spec"
import { retitle, seriesTitle, type TitleWords } from "./title"
import { isSplit, mapLeaves, newNodeId, nodeId, splitNode, splits, type SplitNode } from "./split"

/** Panels a card holds at most, and how deeply it splits them. */
export const CARD_PANELS_MAX = 8
const CARD_PANELS_DEPTH = 4

const uuid = z.guid()
const dim = z.string().min(1).max(100)

/** The panel a card written without any has: its id the card's, so two such cards differ. */
const defaultPanelId = (cardId: string) => `${cardId.slice(0, 23)}q`

export const cardPanels = splitNode(panel, { leaves: CARD_PANELS_MAX, depth: CARD_PANELS_DEPTH })

export const card = z
  .strictObject({
    id: nodeId,
    /** its name; none: what's typed in its text bar, else its query in words */
    label: z.string().trim().min(1).max(80).optional(),
    /** its conditions: every `all` ref, and one of each `any` group */
    where: viewWhere
      .refine((w) => refCount(w) <= MAX_LANE_REFS, `a card has at most ${MAX_LANE_REFS} conditions`)
      .default({ all: [], any: [] }),
    /** split by: a lane per value; none: its total lane alone */
    by: dim.optional(),
    /** each value split again by another dim (pairs); `closed`: values whose pairs are folded */
    then: z.strictObject({ dim, closed: z.array(uuid).max(500).default([]) }).optional(),
    /** hierarchy values of `by` opened in place: their children's lanes under them */
    expanded: z.array(uuid).max(EXPANDED_MAX).default([]),
    /** its busiest values shown */
    limit: z.number().int().min(1).max(500).default(SERIES_LIMIT),
    /** what its text bar says (none: it's empty) */
    text: seriesText.optional(),
    /** its time window is shared with every card of the same key (none: its own) */
    synced: nodeId.optional(),
    /** its panels: views of its query (none written: a queue, named after the card) */
    panels: cardPanels.optional(),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message })
    if (c.then && !c.by) issue("a card splits its values again only when it splits")
    if (c.then && c.then.dim === c.by) issue(`split ${c.by}'s values by another dim`)
    if (c.expanded.length && !c.by) issue("a card opens values only of what it splits by")
  })
  .transform(
    ({ panels, ...c }): typeof c & { panels: SplitNode<Panel> } => ({
      ...c,
      panels: panels ?? newPanel(DEFAULT_PANEL, defaultPanelId(c.id)),
    })
  )
export type Card = z.output<typeof card>
export type CardInput = z.input<typeof card>
/** What a card counts: its query, apart from how it's shown. */
export type CardQuery = Pick<Card, "where" | "by" | "then" | "expanded" | "limit">

/**
 * A card's name, its title: the name it was given, else what's typed in its text bar, else its
 * query in words.
 */
export const cardName = (c: Card, words: TitleWords): string =>
  c.label ?? c.text?.value ?? seriesTitle(queryOfCard(c), words).value

/** A card's time window's key: its sync's, or its own id. */
export const windowKey = (c: Pick<Card, "id" | "synced">): string => c.synced ?? c.id

/**
 * A new card of these conditions, split by `by` (none: its total lane), showing `panels` (none:
 * one panel of the kind a card opens with).
 */
export function makeCard(
  id: string,
  query: { where?: ViewWhereInput; by?: string; label?: string } = {},
  panels?: SplitNode<Panel>
): Card {
  return card.parse({
    id,
    where: canonicalWhere(query.where ?? {}),
    ...(query.by ? { by: query.by } : {}),
    ...(query.label ? { label: query.label } : {}),
    panels: panels ?? newPanel(DEFAULT_PANEL, newNodeId()),
  })
}

/**
 * A copy of a card under new ids (its own, its panels', its splits'), unnamed, for a variant or
 * for a panel moved out to a card of its own. `ids` maps each old split id to its new one, for
 * the copy to take the original's shares.
 */
export function copyCard(
  c: Card,
  id: string = newNodeId()
): { card: Card; ids: Map<string, string> } {
  const ids = new Map<string, string>()
  for (const s of splits(c.panels)) ids.set(s.id, newNodeId())
  const renamed = (n: SplitNode<Panel>): SplitNode<Panel> =>
    isSplit(n)
      ? { ...n, id: ids.get(n.id)!, children: n.children.map(renamed) }
      : { ...n, id: newNodeId() }
  const { label: _label, synced: _synced, ...rest } = c
  return { card: { ...rest, id, panels: renamed(c.panels) }, ids }
}

/** A card's panels mapped (each `f`'s answer; the layout as it is). */
export const mapPanels = (c: Card, f: (p: Panel) => Panel): Card => ({
  ...c,
  panels: mapLeaves(c.panels, f),
})

// ---------------------------------------------------------------- what's chosen in it

/**
 * The lane a card's panels look at (none: all of it): its total, one of its lanes, or a node of
 * its tree (its values from the origin, one per split: docs/tree-design.md).
 */
export const cardFocus = z.union([
  z.strictObject({ lane: z.literal("total") }),
  z.strictObject({
    lane: z.strictObject({
      value: uuid,
      pair: uuid.optional(),
      direct: z.literal(true).optional(),
    }),
  }),
  z.strictObject({ path: z.array(uuid).min(1).max(4) }),
])
export type CardFocus = z.output<typeof cardFocus>

// ---------------------------------------------------------------- compiling

export interface CompiledCard {
  /** what the card counts: its total lane and its groups */
  spec: ViewSpecInput
  /** its total lane's key (every item's, when it has no conditions) */
  total: string
  /** its group's key, when it's split */
  group: string | null
  /** each opened value's key, of the group of its children */
  expansions: Map<string, string>
  /** what's beyond the budget: the view would be refused (docs/SEMANTICS.md, "Budget") */
  issues: string[]
}

/**
 * A card as one view of lanes: its total lane (its conditions), and a group per value it lists
 * (its own, each opened value's). Groups are sorted by key, so renaming a card or changing how it's
 * shown changes nothing counted.
 */
export function compileCard(c: CardQuery, settings: SeriesSettings): CompiledCard {
  const where = canonicalWhere(c.where)
  const total = pinnedKey(where)
  const groups = new Map<string, LaneGroupInput>()

  const addGroup = (g: SeriesGroup): string => {
    const subParent = c.then ? parentOf(g.where, c.then.dim) : undefined
    const base: LaneGroupInput = {
      where: g.where,
      dim: c.by!,
      ...(g.parent ? { parent: g.parent } : {}),
      limit: c.limit,
      other: false,
      ...(c.then ? { sub: { dim: c.then.dim, ...(subParent ? { parent: subParent } : {}) } } : {}),
    }
    const key = groupKey(base)
    // a value whose pairs are folded isn't counted under them (`except` names lane keys)
    const except = c.then
      ? c.then.closed.map((v) => groupLaneKey(key, c.by!, { value: v })).sort()
      : []
    groups.set(key, c.then ? { ...base, sub: { ...base.sub!, except } } : base)
    return key
  }

  let group: string | null = null
  const expansions = new Map<string, string>()
  if (c.by) {
    group = addGroup(seriesGroup(c))
    for (const v of c.expanded) expansions.set(v, addGroup(seriesGroup(c, v)))
  }

  const grouped = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g)
  const issues: string[] = []
  if (grouped.length > MAX_GROUPS)
    issues.push(`a card counts at most ${MAX_GROUPS} splits (its own and opened values)`)
  const refs = [refCount(where), ...grouped.map((g) => refCount(g.where))]
  if (refs.reduce((a, b) => a + b, 0) > MAX_LANE_REFS_TOTAL)
    issues.push(`a card's lanes have at most ${MAX_LANE_REFS_TOTAL} conditions in all`)
  return {
    spec: {
      itemTypes: settings.itemTypes,
      itemKinds: settings.itemKinds,
      spaces: settings.spaces,
      statusClasses: settings.statusClasses,
      time: countedTime(settings.time),
      columns: [],
      axis: { mode: "time", bucket: settings.bucket },
      lanes: { pinned: [{ where }], groups: grouped },
    },
    total,
    group,
    expansions,
    issues,
  }
}

// ---------------------------------------------------------------- editing its query

/**
 * A card after a change to its query by its chips (`after`), its typed title kept saying what it
 * is (`retitle`). A title the change set itself is its own.
 */
export function keepCardTitle(before: Card, after: Card, words: TitleWords): Card {
  if (!before.text || !after.text || after.text !== before.text) return after
  const text = retitle(after.text, queryOfCard(before), queryOfCard(after), words)
  if (text === after.text) return after
  const { text: _t, ...rest } = after
  return text ? { ...rest, text } : rest
}

/** Its conditions changed. */
export const withWhere = (c: Card, where: ViewWhereInput): Card => ({
  ...c,
  where: canonicalWhere(where),
})

/** Split by another dim (none: its total lane alone); what it opened goes. */
export function withBy(c: Card, by: string | null): Card {
  if ((c.by ?? null) === by) return c
  const { by: _by, then, expanded: _e, ...rest } = c
  return {
    ...rest,
    expanded: [],
    ...(by ? { by } : {}),
    ...(by && then && then.dim !== by ? { then: { dim: then.dim, closed: [] } } : {}),
  }
}

/** Split each value again by another dim (null: stop). */
export function withThen(c: Card, then: string | null): Card {
  const { then: was, ...rest } = c
  if (!then || !c.by || then === c.by) return rest
  return { ...rest, then: { dim: then, closed: was?.dim === then ? was.closed : [] } }
}

export const withLimit = (c: Card, limit: number): Card => ({ ...c, limit })

/**
 * Named: its title is the name, and what was typed in its text bar goes (title.ts). None: neither,
 * its title is its query in words again.
 */
export function withLabel(c: Card, label: string | null): Card {
  const { label: _was, text: _text, ...rest } = c
  const name = label?.trim()
  return name ? { ...rest, label: name.slice(0, 80) } : rest
}

/** Its query, as its text bar sends it to be refined. */
export const queryOfCard = (c: Card): SeriesQueryOf => ({
  where: c.where,
  ...(c.by ? { by: c.by } : {}),
  ...(c.then ? { then: c.then.dim } : {}),
  ...(c.limit !== SERIES_LIMIT ? { limit: c.limit } : {}),
})

/**
 * Its query replaced (its text resolved): conditions, splits and limit in one edit, and with
 * `text` what its text bar says (null: nothing; absent: as it was), its title instead of a name.
 * The values it opened stay while it's split by the same dim, and its folded pairs while each
 * value is split again by the same.
 */
export function withQuery(c: Card, q: SeriesQueryOf, text?: SeriesText | null): Card {
  const { by: _by, then: was, expanded, text: had, label, ...rest } = c
  const by = q.by || undefined
  const then = by && q.then && q.then !== by ? q.then : undefined
  const same = by === c.by
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
}

/** Fold or show one value's pairs. */
export function togglePairsOf(c: Card, value: string): Card {
  if (!c.then) return c
  const closed = c.then.closed.includes(value)
    ? c.then.closed.filter((v) => v !== value)
    : [...c.then.closed, value].sort()
  return { ...c, then: { ...c.then, closed } }
}

/** Open or close a hierarchy value of what it splits by: its children's lanes under it. */
export function toggleExpandedOf(c: Card, value: string): Card {
  if (!c.by) return c
  if (c.expanded.includes(value)) return { ...c, expanded: c.expanded.filter((v) => v !== value) }
  return c.expanded.length >= EXPANDED_MAX ? c : { ...c, expanded: [...c.expanded, value] }
}
