// Generated from packages/core/src/view/graph.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * A series' graph (docs/graph-design.md): its items over the window as nodes, the edges between
 * them and to their neighbours, in its card in place of its lanes. What the page keeps of it
 * (`graphState`, in the URL with its series) and what the read returns (`GraphResult`). Browser-safe.
 */
import { z } from "zod"

import type { PlotMeta } from "./plot"

/** The most items a graph reads (its scope's newest); past it, `truncated`. */
export const GRAPH_ITEMS_MAX = 5000
/** The items a graph reads unless it asks for fewer or more. */
export const GRAPH_ITEMS = 2000
/** The edges read per item and direction (a hub's are its first by relation; more: `capped`). */
export const GRAPH_EDGES_PER_ITEM = 32

export const graphState = z.strictObject({
  /** relations not drawn, by key */
  hidden: z.array(z.string().min(1).max(200)).max(64).default([]),
  /** one lane of the series alone (its value key); the others fade */
  solo: z.guid().nullable().default(null),
  /** what an item's color says: its lane, its type, or the group it's in (`groupBy`) */
  color: z.enum(["lane", "type", "group"]).default("lane"),
  /**
   * what the force layout holds together as islands: "lane", "clusters", "none" or `rel:<relation>`
   * (unset: its split, if it has one, else the clusters it finds)
   */
  groupBy: z.string().min(1).max(220).nullable().default(null),
  /** how it's laid out: as a tree growing from the series' split, or by its relations' pull alone */
  layout: z.enum(["branches", "force"]).default("branches"),
  /**
   * what its tree splits by, left to right from its origin (docs/tree-design.md; none: what its
   * lanes are split by, then ideas)
   */
  splits: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(4)
    .refine((d) => new Set(d).size === d.length, "a tree splits by a dimension once")
    .optional(),
  /** its tree as it was at this time (epoch ms; none: as it is now) */
  asOf: z.number().int().positive().nullable().default(null),
  /** given the table's height (as a plot is); otherwise a row of its card */
  expanded: z.boolean().default(false),
})
export type GraphState = z.output<typeof graphState>

/** A node: an item of the scope (`lanes`: the scope's lanes it's in), or a neighbour outside it. */
export interface GraphNode {
  id: string
  name: string
  type: string
  typeLabel: string
  kind: string
  status: string | null
  /** epoch ms: started_at, else created_at */
  t: number
  /** indexes into the request's lanes (none: a neighbour outside the scope) */
  lanes: number[]
}

export interface GraphRelation {
  key: string
  /** read from its source ("tested") */
  label: string
  /** read from its target ("tested by") */
  inverse: string
  /**
   * a lineage relation: its source came from its target (`generated_by`, `used`, `derived_from`),
   * so what came first is its target
   */
  lineage: boolean
  /** a hierarchy relation: its source is part of its target */
  hierarchy: boolean
}

export interface GraphResult extends PlotMeta {
  /** the scope's items, newest first (the first `items` of them), then their neighbours */
  nodes: GraphNode[]
  items: number
  /** [source, target, relation]: indexes into `nodes` and `relations`, each edge once */
  edges: [number, number, number][]
  relations: GraphRelation[]
  /** the scope has more items than were read (the newest are shown) */
  truncated: boolean
  /** nodes with more edges in a direction than were read */
  capped: number[]
  /** the realtime messages applied to it (a signal read: none, it's refetched) */
  applied?: string[]
}

/** An empty graph state: every relation drawn, a row of its card. */
export const defaultGraph = (): GraphState => graphState.parse({})
