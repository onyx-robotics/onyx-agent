// Generated from packages/core/src/view/types.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * A computed view. Also the client's live state: realtime deltas are applied to it in place
 * (view/delta.ts), so everything needed to place an item is in `match`.
 */
export interface Count {
  n: number
  /** highlighted by the selection */
  h: number
}

export type ElemMode = "rollup" | "direct" | "restricted" | "other" | "none"

export interface ElemResult {
  /**
   * unique within the view: `${col}:${dim}:r:${valueKey}` / `${col}:${dim}:x:${valueKey}`,
   * `${col}:${dim}:restricted`, `${col}:other` or `${col}:none`
   */
  key: string
  dim: string | null
  mode: ElemMode
  valueKey: string | null
  label: string
  /** keys of visible parents (a node under two expanded parents lists both) */
  parentKeys: string[]
  depth: number
  hasChildren: boolean
  expanded: boolean
  cluster: string
  count: Count
  lastT: number | null
}

export interface HeaderResult {
  /** an expanded node drawn as a group header; its count rolls up everything below it */
  key: string
  dim: string
  valueKey: string
  label: string
  parentKeys: string[]
  depth: number
  count: Count
}

export interface ColumnResult {
  index: number
  dims: { key: string; label: string }[]
  elems: ElemResult[]
  headers: HeaderResult[]
  /** visible nodes with items that the dim limits leave out (their items are in "other") */
  hidden: { nodes: number }
}

export interface FlowResult {
  a: string
  b: string
  count: Count
}

export interface LaneResult {
  key: string
  label: string
  cluster: string
  count: Count
  /** max t; on a time axis, the start of the newest bucket with items */
  lastT: number | null
  /** bucket start (epoch ms) -> count, when the axis is time */
  buckets: Record<string, Count> | null
  metric: { value: number | null; n: number } | null
  /** set by the client when a delta changed something it can't recompute (metric, lastT) */
  stale?: boolean
  /** a group lane's value has children of its own dim (it can be opened as a group under it) */
  hasChildren?: boolean
}

/**
 * The lanes of a group's sub-dimension under one of its lanes (`spec.lanes.groups[].sub`): a lane
 * per value of B among the A lane's items, with items, then B Restricted.
 */
export interface PairResult {
  /** the A lane's key; its pairs' keys start with it */
  of: string
  lanes: LaneResult[]
  /** the A lane's items with a value (or restricted association) in B */
  coverage: Count
}

/** Lanes of one value each of a dim, under conditions (`spec.lanes.groups`). */
export interface GroupResult {
  /** `g:` and a hash of its conditions, dim and parent; its lanes' keys start with it */
  key: string
  /** the spec's label, else its conditions in words */
  label: string
  dim: string
  dimLabel: string
  /** a lane per value with items (the busiest `limit` of a big dim), then Restricted and Other */
  lanes: LaneResult[]
  /** values with items that the limit leaves out (their items are in Other) */
  hidden: { nodes: number }
  /**
   * the items passing the gate with a value (or restricted association) in the dim, or under the
   * parent: those in at least one lane, but for a big dim's values left out (docs/SEMANTICS.md)
   */
  coverage: Count
  /** values shown, of the values with items */
  values: { shown: number; total: number }
  /** with a sub-dimension: its lanes under each A lane that has some (in the A lanes' order) */
  pairs: PairResult[]
}

/** How a group places an item, for deltas (docs/SEMANTICS.md, "Lane groups"). */
export interface MatchGroup {
  key: string
  /** the group's conditions as query_int; null: every item */
  gate: string | null
  /** an id every item passing the gate carries: only items carrying it are looked at (null: all) */
  head: number | null
  /** shown value ids (the members, and the parent's own value) -> lane key */
  laneIds: [number, string][]
  /** values left out with no items: an item reaching one needs a refetch */
  refetchIds: number[]
  dim: number
  /** an item with a value in the dim (under the parent): Other when it isn't in a lane */
  pid: number | null
  always: boolean
  /** null: a parent the viewer can't see (no lanes at all) */
  restrictedKey: string | null
  /** big dims only */
  otherKey: string | null
  /** a sub-dimension: lanes per value of B under each A lane (pair keys: `${aKey}:${suffix}`) */
  sub?: {
    dim: number
    /** B value id -> the pair key's suffix (`<B dim>:r:<value>`, `<B dim>:x:<parent>`) */
    laneIds: [number, string][]
    /** B's presence marker, or the parent's rollup value (null: nothing has one yet) */
    pid: number | null
    always: boolean
    /** the suffix of an A lane's B Restricted (null: under a B parent the viewer can't see) */
    restrictedSuffix: string | null
    /** A lane keys without pairs */
    except: string[]
  }
}

/** A ref the view names (a filter, the selection, a lane's conditions), labelled for the viewer. */
export interface RefLabel {
  dim: string
  key: string
  label: string
}

export interface MatchPlan {
  typeIds: number[] | null
  spaceIds: string[]
  statuses: string[] | null
  from: number | null
  to: number | null
  filter: string | null
  highlight: string | null
  /**
   * Per column: shown facet value id -> elem key; header ids; refetchIds: nodes left out of the
   * view because they were empty; per dim, its presence marker (null: no item has a value yet;
   * `always`: every item has one) and its Restricted element. An item goes to Restricted(dim)
   * when its row's `rs` names the dim, to Other when it has a value but no shown or restricted
   * element, else to None.
   */
  columns: {
    elemIds: [number, string][]
    headerIds: [number, string][]
    refetchIds: number[]
    otherKey: string
    noneKey: string
    dims: { id: number; pid: number | null; always: boolean; restrictedKey: string }[]
  }[]
  /** every dim the spec uses: a new value (`nv`) in one of them brings a node to show */
  dimIds: number[]
  /**
   * the viewer's restricted spaces: a row with `rs` can be placed exactly only by a viewer who
   * sees no restricted space but the row's own
   */
  restrictedSpaces: string[]
  laneColumn: number
  includeNone: boolean
  bucketMs: number | null
  originMs: number
  metric: boolean
  /** pinned lanes: an item counts in each whose conditions (query_int text) it matches */
  pinned: { key: string; expr: string }[]
  groups: MatchGroup[]
  /** a view of lanes only (no columns): it counts the items in at least one lane */
  scoped: boolean
}

export interface ViewResult {
  hash: string
  asOf: string
  snapshot: { xmin: string; xmax: string; xip: string[] }
  registryVersion: number
  /** bumped when what someone may see narrows: a view from an older generation is refetched */
  visibilityGen: number
  /** how current the serving rows are (docs/SEMANTICS.md, "Projection") */
  projection: ProjectionStatus
  total: Count
  columns: ColumnResult[]
  /** flows[i] connects columns i and i+1 */
  flows: FlowResult[][]
  /** the last column's elements as lanes */
  lanes: LaneResult[]
  /** lanes of their own conditions (`spec.lanes.pinned`), in the spec's order */
  pinned: LaneResult[]
  /** lane groups (`spec.lanes.groups`), in the spec's order */
  groups: GroupResult[]
  /**
   * labels of the refs the spec names that the viewer may see (a property value only when an
   * item the viewer can see carries it); a ref missing here is shown as restricted
   */
  refLabels: RefLabel[]
  match: MatchPlan
  /** set by the client when a delta couldn't be applied exactly: refetch */
  needsRefetch?: boolean
  /** set by the client: ids of the messages applied to this view since it was fetched */
  applied?: string[]
}

/**
 * How current the counted rows are:
 *   ready        everything is refreshed
 *   refreshing   deferred refreshes are waiting (a hub edge, a re-parent); counts lag by up to
 *                `oldestPendingAt`
 *   rebuilding   a registry change is being applied to every row (`progress` 0..1)
 *   restricting  a move into a restricted space is being staged
 *   failed       background work keeps failing: counts may stay stale until an operator acts
 * Background work (deferred refreshes, staged restrictions, rebuilds) publishes an invalidate with
 * each chunk it commits instead of its rows: a live view stops applying deltas until it has
 * fetched a view that includes those chunks (docs/SEMANTICS.md, "Realtime").
 */
export interface ProjectionStatus {
  status: "ready" | "refreshing" | "rebuilding" | "restricting" | "failed"
  progress: number | null
  pendingRefresh: number
  oldestPendingAt: string | null
  /** the continuous audit (null until it first ran for the org) */
  lastAudit: AuditStatus | null
}

/**
 * The continuous audit of serving rows against what derives (docs/SEMANTICS.md, "Projection").
 * An org with work always pending is skipped, and shows as overdue, not verified.
 */
export interface AuditStatus {
  /** when the last complete pass over the org ended, and what it found */
  verifiedAt: string | null
  checked: number | null
  differing: number | null
  /** the last attempt, and why it was skipped ('pending': unfinished work) */
  attemptedAt: string | null
  skippedReason: string | null
  /** no complete pass recently */
  overdue: boolean
  /** the repair of what it found keeps failing: an operator must look */
  repairFailed: boolean
}

/** One side of a serving-row change, as published by the database. */
export interface FacetRowState {
  ty: number
  sp: string
  st: string | null
  /** epoch ms */
  t: number
  /** facet value ids, stripped of restricted markers and of nodes the topic can't all see */
  v: number[]
  /** dims where the row has a restricted association outside its own space */
  rs?: number[]
  /**
   * values of nodes in restricted spaces were stripped from it (normally with a marker in `rs`;
   * alone, a row computed before a staged restriction narrows it)
   */
  rv?: true
}

/** A touched item's serving row as committed (the new side only), to place activity on lanes. */
export interface FacetTouchRow {
  id: string
  n: FacetRowState
}

export interface FacetDeltaRow {
  id: string
  /** absent on a row leaving the topic */
  nm?: string | null
  o: FacetRowState | null
  n: FacetRowState | null
}

/**
 * One realtime message (docs/architecture.md, "Realtime"). A message carries serving-row
 * changes, an invalidate, or a touch hint.
 */
export interface FacetDeltaMessage {
  v: 2
  /** `${txid}:${seq}`: unique per message (seq counts the transaction's messages) */
  id: string
  txid: string
  rows?: FacetDeltaRow[]
  /** values that first appeared in this transaction and that these rows carry: [id, dim] */
  nv?: [number, number][]
  /** refetch: what someone may see changed, rows were rebuilt, or too many rows for deltas */
  invalidate?: boolean
  reason?: "visibility" | "projection" | "size"
  /**
   * entities whose name, props, head or sealing (item), current metrics or refs changed: ids in
   * `touch`, and up to 200 a topic with their rows in `cur` (touchedIds gives both)
   */
  touch?: string[]
  cur?: FacetTouchRow[]
  /**
   * `job`: from the job fold, ids only: any of the others, and an order or a unit's availability;
   * `edges`: an edge from or to each was added, closed or removed (a graph reads their edges again)
   */
  what?: "item" | "metrics" | "refs" | "job" | "edges"
}
