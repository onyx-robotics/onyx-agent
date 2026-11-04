// Generated from packages/core/src/contracts/read.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Read-path contracts, shared by the API, the agent tools and the SDK.
 */
import { z } from "zod"

import { GRAPH_ITEMS, GRAPH_ITEMS_MAX } from "../view/graph"
import { nodeRef, viewSpec } from "../view/spec"
import { plotPick, plotScope } from "./plots"

const uuid = z.string().uuid()

/** Items behind view elements: a lane, a node, a flow (two keys), a time bucket. */
export const itemsQuery = z.object({
  spec: viewSpec,
  /** element keys of the view (AND): one for a node or lane, two for a flow */
  keys: z.array(z.string().min(1)).max(4).default([]),
  /**
   * lane keys of the view: the items in at least one of them (and in `keys`): a tree drawing the
   * items of its quiet lanes asks for them at once
   */
  lanes: z.array(z.string().min(1)).max(500).optional(),
  /**
   * the element and header keys the view shows (its display frontier), so Other means what the
   * view showed; without it, Other is recounted
   */
  shown: z.array(z.string().min(1)).max(5000).optional(),
  /** bucket start (epoch ms) on the view's time axis */
  bucket: z.number().int().optional(),
  highlighted: z.boolean().default(false),
  /** what a plot picked (docs/plots-design.md §10): each item says whether it's picked */
  pick: plotPick.optional(),
  /** with `pick`: only the picked items */
  picked: z.boolean().default(false),
  /**
   * each item's serving row as the viewer's views count it, so a client places it on the view's
   * lanes (`contrib`): a tree drawing the items of the window it shows
   */
  rows: z.boolean().default(false),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(50),
})
export type ItemsQueryInput = z.input<typeof itemsQuery>

/** An item's neighbours, one edge away, for drawing them on a tree's lanes (items/neighbours.ts). */
export const neighboursQuery = z.object({
  /** relation keys (sub-relations included); default: every relation */
  relations: z.array(z.string()).optional(),
  /** the newest per relation and direction */
  limit: z.number().int().min(1).max(100).default(20),
})
export type NeighboursQueryInput = z.input<typeof neighboursQuery>

/** A series' flow (docs/jobs.md): what's waiting, running and just finished among its items. */
export const flowQuery = z.strictObject({
  spec: viewSpec,
  /** the series' lanes: any of them (none: every item of the view) */
  lanes: z.array(z.string().min(1)).max(500),
  /** the element and header keys the view shows (its display frontier) */
  shown: z.array(z.string().min(1)).max(5000),
  /** how much of the queue's head, how many running and how many of the newest finished to send */
  head: z.number().int().min(1).max(1024).default(256),
  running: z.number().int().min(1).max(1024).default(256),
  done: z.number().int().min(1).max(200).default(100),
})
export type FlowQueryInput = z.input<typeof flowQuery>

/** What a flow's new items are, past what a delta says. */
export const flowItemsQuery = z.strictObject({ ids: z.array(z.guid()).min(1).max(200) })

/**
 * A series' graph (docs/graph-design.md): its scope's newest items (a plot's scope: the series'
 * lanes over the window) and their edges, both ways, with the neighbours at their other ends.
 */
export const graphQuery = z.strictObject({
  scope: plotScope,
  limit: z.number().int().min(1).max(GRAPH_ITEMS_MAX).default(GRAPH_ITEMS),
})
export type GraphQueryInput = z.input<typeof graphQuery>

export const lineageQuery = z.object({
  direction: z.enum(["up", "down", "both"]).default("both"),
  depth: z.number().int().min(1).max(6).default(3),
  limit: z.number().int().min(1).max(500).default(200),
  /** lineage relation keys (sub-relations included); default: every lineage relation */
  relations: z.array(z.string()).optional(),
})
export type LineageQueryInput = z.input<typeof lineageQuery>

export const searchQuery = z.object({
  q: z.string().min(1).max(200),
  types: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(100).default(20),
})
export type SearchQueryInput = z.input<typeof searchQuery>

export const feedQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  entity: uuid.optional(),
  eventTypes: z.array(z.string()).default([]),
})
export type FeedQueryInput = z.input<typeof feedQuery>

export const changesQuery = z.object({
  /** the cursor of the previous page; omit to read from the start of the log */
  after: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
})
export type ChangesQueryInput = z.input<typeof changesQuery>

export const facetTreeQuery = z.object({
  dim: z.string().min(1),
  /** children of this node; roots when omitted */
  parent: z.string().optional(),
  /** label search over the whole dimension instead of one level */
  q: z.string().max(200).optional(),
  /** these nodes (to label them), instead of a level or a search */
  keys: z.array(z.string().min(1)).max(200).optional(),
  /** with `keys`: their ancestors too, the branches down to them */
  ancestors: z.boolean().default(false),
  /** counts within this item set (its columns are ignored) */
  spec: viewSpec.partial({ columns: true }).optional(),
  limit: z.number().int().min(1).max(500).default(100),
})
export type FacetTreeQueryInput = z.input<typeof facetTreeQuery>

export const failureRatesQuery = z.object({
  spec: viewSpec.partial({ columns: true }).prefault({}),
  by: z.string().min(1),
  expanded: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(200).default(30),
})
export type FailureRatesQueryInput = z.input<typeof failureRatesQuery>

export const reusableDataQuery = z.object({
  q: z.string().max(200).optional(),
  /** facet nodes the data should relate to (hardware, topic, ...): all must match */
  near: z.array(nodeRef).default([]),
  types: z.array(z.string()).default(["dataset"]),
  limit: z.number().int().min(1).max(100).default(20),
})
export type ReusableDataQueryInput = z.input<typeof reusableDataQuery>

export const baselineQuery = z.object({
  id: uuid,
  /** metric context (evaluation protocol, dataset); default: every context */
  context: uuid.optional(),
})
export type BaselineQueryInput = z.input<typeof baselineQuery>
