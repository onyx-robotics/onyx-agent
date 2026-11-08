// Generated from packages/core/src/view/panel.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Panels (docs/panels-design.md): the views a series card holds of its query. Each kind draws the
 * card's items its own way, from the card's scope, window and selection: its lanes over time, its
 * work as it queues and runs, the item chosen in it, a plot of its items by other axes, or its items
 * as a graph of their relations. A panel keeps only how it draws (its axes, its look); what it
 * draws is the card's. Browser-safe.
 */
import { z } from "zod"

import { graphState } from "./graph"
import { axisRange, axisScales, field, moreY, onlyLanes, plotShow } from "./plot-state"
import { nodeId } from "./split"

export const PANEL_KINDS = ["lanes", "queue", "inspector", "plot", "node"] as const
export const panelKind = z.enum(PANEL_KINDS)
export type PanelKind = z.output<typeof panelKind>

/**
 * A plot panel's axes and what it draws. An axis not chosen (null) is the plot's default, worked
 * out where it opens (time across; the scope's best-covered metric up, else duration), so a plot
 * made before its fields are read stores nothing it would have to correct.
 */
export const plotPanelState = z.strictObject({
  show: plotShow.default("both"),
  x: field.nullable().default(null),
  y: field.nullable().default(null),
  more: moreY,
  scale: axisScales.default({ x: "linear", y: "linear" }),
  /** lanes of the card drawn alone (their value keys); none: every lane */
  only: onlyLanes,
  /** zoomed in, in each axis's own units (times and order: epoch ms and rank) */
  zoom: z.strictObject({ x: axisRange, y: axisRange }).nullable().default(null),
})
export type PlotPanelState = z.output<typeof plotPanelState>

/** A plot's legend: how wide (none: its default) and whether it's folded to swatches. */
export const legendState = z.strictObject({
  w: z.number().int().min(0).max(480).nullable().default(null),
  collapsed: z.boolean().default(false),
})

/**
 * A node panel's look: the graph's, without its time (the card's window: a tree as of its end) or
 * its size (the panel's).
 */
export const nodePanelState = graphState.omit({ asOf: true, expanded: true })
export type NodePanelState = z.output<typeof nodePanelState>

/** What colors the queue's boxes: the item's type, or its status. */
export const queueColor = z.enum(["type", "status"])

/**
 * How a queue's timeline is opened: the kinds of unit folded to one row (their type ids; each
 * opens unfolded), and the units that run several jobs at once opened to a row for each run at a
 * time (their ids; each opens folded, its runs nested in its row).
 */
const queueFolded = z.array(z.number().int()).max(64).default([])
const queueOpened = z.array(z.string().min(1).max(64)).max(64).default([])

/**
 * Where a queue's timeline looks: `span` (ms) up to now, which it follows; or a stretch of the past,
 * its ends (epoch ms). None: the last hour, up to now.
 */
export const queueWindow = z.union([
  z.strictObject({ span: z.number().int().positive() }),
  z
    .strictObject({ t0: z.number().int().min(0), t1: z.number().int() })
    .refine((w) => w.t1 > w.t0, "a window ends after it starts"),
])
export type QueueWindow = z.output<typeof queueWindow>

export const panel = z.discriminatedUnion("kind", [
  z.strictObject({ id: nodeId, kind: z.literal("lanes") }),
  z.strictObject({
    id: nodeId,
    kind: z.literal("queue"),
    color: queueColor.default("type"),
    folded: queueFolded,
    opened: queueOpened,
    window: queueWindow.nullable().default(null),
  }),
  z.strictObject({ id: nodeId, kind: z.literal("inspector") }),
  z.strictObject({
    id: nodeId,
    kind: z.literal("plot"),
    plot: plotPanelState.default(() => plotPanelState.parse({})),
    legend: legendState.default(() => legendState.parse({})),
  }),
  z.strictObject({
    id: nodeId,
    kind: z.literal("node"),
    graph: nodePanelState.default(() => nodePanelState.parse({})),
  }),
])
export type Panel = z.output<typeof panel>
export type PanelInput = z.input<typeof panel>
export type PanelOf<K extends PanelKind> = Extract<Panel, { kind: K }>

/** A new panel of a kind, as it opens (each kind's defaults). */
export const newPanel = <K extends PanelKind>(kind: K, id: string): PanelOf<K> =>
  panel.parse({ id, kind }) as PanelOf<K>

/** The kind a new card opens with. */
export const DEFAULT_PANEL: PanelKind = "queue"

/** Whether a panel draws over the card's time window (its card then shows the time control). */
export const usesWindow = (p: Panel): boolean =>
  p.kind === "lanes" || p.kind === "plot" || p.kind === "node"
