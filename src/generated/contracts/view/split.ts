// Generated from packages/core/src/view/split.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Split trees (docs/panels-design.md): how a workspace lays out its cards, and a card its panels.
 * A node is a leaf (a card, a panel) or a split: its children side by side (`row`) or stacked
 * (`column`), each taking a share of the split's room.
 *
 * Shares are kept apart from the structure, by split id (`Sizes`): resizing changes no structure,
 * a stale share (a split whose children changed) is ignored for even shares, and the two are
 * classified apart (a resize only looks further into a workspace; a split changes what it is).
 * A tree is normalized: a split has two children or more, none a split of its own direction (it
 * would be part of it), and every id in it is its own. Pure and browser-safe.
 */
import { z } from "zod"

/** A node's id: a card's, a panel's or a split's, made on the page (`newNodeId`). */
export const nodeId = z.string().regex(/^[a-z0-9]{1,24}$/)

export const splitDir = z.enum(["row", "column"])
/** `row`: side by side; `column`: stacked. */
export type Dir = z.output<typeof splitDir>
/** Where something goes against a node: beside it on a side, or above or below it. */
export type Edge = "top" | "bottom" | "left" | "right"

export interface Split<L> {
  id: string
  dir: Dir
  children: SplitNode<L>[]
}
export type SplitNode<L> = Split<L> | L
/** Each split's children's shares of its room, by its id: fractions summing to 1. */
export type Sizes = Record<string, number[]>
/** A tree and its shares: what every operation takes and gives back. */
export interface Tree<L> {
  root: SplitNode<L> | null
  sizes: Sizes
}
export interface Size {
  w: number
  h: number
}

export const sizesSchema = z.record(nodeId, z.array(z.number().positive().max(1)).min(2))

/** A new node's id: 8 base-36 characters. */
export function newNodeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("")
}

type Leaf = { id: string }

export const isSplit = <L extends Leaf>(n: SplitNode<L>): n is Split<L> =>
  "children" in n && "dir" in n

/** Its leaves, in order (left to right, top to bottom). */
export function leaves<L extends Leaf>(n: SplitNode<L> | null): L[] {
  if (!n) return []
  return isSplit(n) ? n.children.flatMap((c) => leaves(c)) : [n]
}

/** Its splits, outermost first. */
export function splits<L extends Leaf>(n: SplitNode<L> | null): Split<L>[] {
  if (!n || !isSplit(n)) return []
  return [n, ...n.children.flatMap((c) => splits(c))]
}

/** Every id in it: its splits' and its leaves'. */
export const nodeIds = <L extends Leaf>(n: SplitNode<L> | null): string[] =>
  !n ? [] : isSplit(n) ? [n.id, ...n.children.flatMap((c) => nodeIds(c))] : [n.id]

export function findLeaf<L extends Leaf>(n: SplitNode<L> | null, id: string): L | undefined {
  return leaves(n).find((l) => l.id === id)
}

/** The leaf of this id changed (`f` gives it back as it should be). */
export function updateLeaf<L extends Leaf>(
  n: SplitNode<L>,
  id: string,
  f: (leaf: L) => L
): SplitNode<L> {
  if (!isSplit(n)) return n.id === id ? f(n) : n
  let changed = false
  const children = n.children.map((c) => {
    const next = updateLeaf(c, id, f)
    if (next !== c) changed = true
    return next
  })
  return changed ? { ...n, children } : n
}

/** Every leaf mapped (the structure as it is). */
export function mapLeaves<L extends Leaf, M extends Leaf>(
  n: SplitNode<L>,
  f: (leaf: L) => M
): SplitNode<M> {
  return isSplit(n) ? { ...n, children: n.children.map((c) => mapLeaves(c, f)) } : f(n)
}

// ---------------------------------------------------------------- shares

const round = (x: number) => Math.round(x * 1e4) / 1e4
const even = (n: number) => Array.from({ length: n }, () => round(1 / n))

/** Shares summing to 1, rounded (so an address holds short numbers). */
function normalShares(raw: readonly number[]): number[] {
  const sum = raw.reduce((a, b) => a + b, 0)
  return raw.map((x) => round(x / sum))
}

/** A split's shares: its own, if they fit its children, else even ones. */
export function sharesOf(sizes: Sizes, s: Split<unknown>): number[] {
  const raw = sizes[s.id]
  if (!raw || raw.length !== s.children.length) return even(s.children.length)
  if (raw.some((x) => !Number.isFinite(x) || x <= 0)) return even(s.children.length)
  const sum = raw.reduce((a, b) => a + b, 0)
  return Math.abs(sum - 1) > 0.01 ? even(s.children.length) : raw
}

/** The shares of one split set (to fractions summing to 1; none that don't fit it). */
export function resizeSplit<L extends Leaf>(
  tree: Tree<L>,
  splitId: string,
  shares: number[]
): Tree<L> {
  const s = splits(tree.root).find((x) => x.id === splitId)
  if (!s || shares.length !== s.children.length || shares.some((x) => !(x > 0))) return tree
  return { root: tree.root, sizes: { ...tree.sizes, [splitId]: normalShares(shares) } }
}

/**
 * A tree normalized: a split of one child is that child, a split's child split of its own direction
 * is part of it (its children taking their shares of its share), and shares of splits that went
 * are dropped (the others are untouched: a record of shares can hold other trees').
 */
export function normalizeTree<L extends Leaf>(tree: Tree<L>): Tree<L> {
  const sizes: Sizes = { ...tree.sizes }
  const before = splits(tree.root).map((s) => s.id)
  const go = (n: SplitNode<L>): SplitNode<L> => {
    if (!isSplit(n)) return n
    const shares = sharesOf(sizes, n)
    const kids: SplitNode<L>[] = []
    const kidShares: number[] = []
    n.children.forEach((c0, i) => {
      const c = go(c0)
      const share = shares[i]!
      if (isSplit(c) && c.dir === n.dir) {
        const inner = sharesOf(sizes, c)
        c.children.forEach((cc, j) => {
          kids.push(cc)
          kidShares.push(share * inner[j]!)
        })
      } else {
        kids.push(c)
        kidShares.push(share)
      }
    })
    if (kids.length === 1) return kids[0]!
    sizes[n.id] = normalShares(kidShares)
    return { ...n, children: kids }
  }
  const root = tree.root ? go(tree.root) : null
  const after = new Set(splits(root).map((s) => s.id))
  for (const id of before) if (!after.has(id)) delete sizes[id]
  return { root, sizes }
}

// ---------------------------------------------------------------- operations

const axisOf = (e: Edge): Dir => (e === "left" || e === "right" ? "row" : "column")
const leads = (e: Edge) => e === "left" || e === "top"

/** The split holding a node, and where (none: it's the root, or not in the tree). */
function parentOf<L extends Leaf>(
  n: SplitNode<L>,
  id: string
): { parent: Split<L>; index: number } | null {
  if (!isSplit(n)) return null
  const index = n.children.findIndex((c) => c.id === id)
  if (index >= 0) return { parent: n, index }
  for (const c of n.children) {
    const found = parentOf(c, id)
    if (found) return found
  }
  return null
}

/** The node of this id replaced (by `f`'s answer). */
function replaceNode<L extends Leaf>(
  n: SplitNode<L>,
  id: string,
  f: (x: SplitNode<L>) => SplitNode<L>
): SplitNode<L> {
  if (n.id === id) return f(n)
  if (!isSplit(n)) return n
  return { ...n, children: n.children.map((c) => replaceNode(c, id, f)) }
}

/**
 * `node` put against the node `target` (null: the whole tree) on `edge`: beside it in its split
 * when that split runs that way (taking half its share), else in a new split (`splitId`) of the
 * two, half each. An empty tree is the node.
 */
export function insertAt<L extends Leaf>(
  tree: Tree<L>,
  target: string | null,
  edge: Edge,
  node: SplitNode<L>,
  splitId: string = newNodeId()
): Tree<L> {
  const { root } = tree
  if (!root) return normalizeTree({ root: node, sizes: tree.sizes })
  const dir = axisOf(edge)
  const pair = (t: SplitNode<L>): Split<L> => ({
    id: splitId,
    dir,
    children: leads(edge) ? [node, t] : [t, node],
  })
  const sizes: Sizes = { ...tree.sizes }
  const at = target === null || target === root.id ? null : parentOf(root, target)
  if (target !== null && target !== root.id && !at) return tree
  if (!at) {
    // against the whole tree: a row of rows (or column of columns) takes it at its end
    if (isSplit(root) && root.dir === dir) {
      const shares = sharesOf(sizes, root)
      const n = shares.length
      const scaled = shares.map((x) => (x * n) / (n + 1))
      sizes[root.id] = leads(edge) ? [1 / (n + 1), ...scaled] : [...scaled, 1 / (n + 1)]
      const children = leads(edge) ? [node, ...root.children] : [...root.children, node]
      return normalizeTree({ root: { ...root, children }, sizes })
    }
    sizes[splitId] = [0.5, 0.5]
    return normalizeTree({ root: pair(root), sizes })
  }
  const { parent, index } = at
  if (parent.dir === dir) {
    const shares = [...sharesOf(sizes, parent)]
    const half = shares[index]! / 2
    shares.splice(index, 1, half, half)
    const children = [...parent.children]
    children.splice(leads(edge) ? index : index + 1, 0, node)
    sizes[parent.id] = shares
    return normalizeTree({
      root: replaceNode(root, parent.id, () => ({ ...parent, children })),
      sizes,
    })
  }
  sizes[splitId] = [0.5, 0.5]
  return normalizeTree({ root: replaceNode(root, target!, (t) => pair(t)), sizes })
}

/** The node of this id, wherever it is in the tree. */
function nodeOf<L extends Leaf>(n: SplitNode<L> | null, id: string): SplitNode<L> | null {
  if (!n) return null
  if (n.id === id) return n
  if (!isSplit(n)) return null
  for (const c of n.children) {
    const found = nodeOf(c, id)
    if (found) return found
  }
  return null
}

/**
 * The node of this id taken out, its share going to the others in its split (by theirs). Its own
 * splits' shares are kept: it may be put back elsewhere (`move`). Null: it isn't in the tree.
 */
function detach<L extends Leaf>(tree: Tree<L>, id: string): Tree<L> | null {
  const { root } = tree
  if (!root) return null
  if (root.id === id) return { root: null, sizes: tree.sizes }
  const at = parentOf(root, id)
  if (!at) return null
  const { parent, index } = at
  const shares = sharesOf(tree.sizes, parent).filter((_, i) => i !== index)
  const children = parent.children.filter((_, i) => i !== index)
  const sizes = { ...tree.sizes, [parent.id]: normalShares(shares) }
  return normalizeTree<L>({
    root: replaceNode(root, parent.id, () => ({ ...parent, children })),
    sizes,
  })
}

/** The node of this id taken out (its share going to the others in its split, by theirs). */
export function removeNode<L extends Leaf>(tree: Tree<L>, id: string): Tree<L> {
  const node = nodeOf(tree.root, id)
  const out = node ? detach(tree, id) : null
  if (!node || !out) return tree
  const sizes = { ...out.sizes }
  for (const s of splits(node)) delete sizes[s.id]
  return { root: out.root, sizes }
}

/** Whether `id` is `inside` or under it. */
function within<L extends Leaf>(tree: SplitNode<L> | null, inside: string, id: string): boolean {
  const sub = nodeOf(tree, inside)
  return !!sub && nodeIds(sub).includes(id)
}

/** The node of this id moved against `target` on `edge` (nothing, if the target is in it). */
export function moveNode<L extends Leaf>(
  tree: Tree<L>,
  id: string,
  target: string | null,
  edge: Edge,
  splitId: string = newNodeId()
): Tree<L> {
  if (!tree.root || id === target) return tree
  if (target !== null && within(tree.root, id, target)) return tree
  const node = nodeOf(tree.root, id)
  const out = node ? detach(tree, id) : null
  if (!node || !out) return tree
  if (target !== null && !nodeIds(out.root).includes(target)) return tree
  return insertAt(out, target, edge, node, splitId)
}

// ---------------------------------------------------------------- room

/**
 * The least room a node takes: its leaves' least (`leafMin`) side by side in a row (widths added,
 * the tallest), stacked in a column (heights added, the widest), with `gap` between children.
 */
export function minSize<L extends Leaf>(
  n: SplitNode<L>,
  leafMin: (leaf: L) => Size,
  gap = 0
): Size {
  if (!isSplit(n)) return leafMin(n)
  const kids = n.children.map((c) => minSize(c, leafMin, gap))
  const gaps = gap * (kids.length - 1)
  return n.dir === "row"
    ? { w: kids.reduce((a, k) => a + k.w, 0) + gaps, h: Math.max(...kids.map((k) => k.h)) }
    : { w: Math.max(...kids.map((k) => k.w)), h: kids.reduce((a, k) => a + k.h, 0) + gaps }
}

/**
 * A tree as it's shown `width` wide: a row whose children's least widths don't fit is stacked
 * instead, its children evenly (`reflowed` names those, for the page not to resize or save them).
 * For display only: what's saved stays as it was.
 */
export function reflow<L extends Leaf>(
  tree: Tree<L>,
  width: number,
  leafMin: (leaf: L) => Size,
  gap = 0
): Tree<L> & { reflowed: string[] } {
  const reflowed: string[] = []
  const sizes: Sizes = { ...tree.sizes }
  const go = (n: SplitNode<L>, w: number): SplitNode<L> => {
    if (!isSplit(n)) return n
    if (n.dir === "row" && minSize(n, leafMin, gap).w > w) {
      reflowed.push(n.id)
      sizes[n.id] = even(n.children.length)
      return { ...n, dir: "column", children: n.children.map((c) => go(c, w)) }
    }
    if (n.dir === "column") return { ...n, children: n.children.map((c) => go(c, w)) }
    const shares = sharesOf(sizes, n)
    const room = w - gap * (n.children.length - 1)
    return {
      ...n,
      children: n.children.map((c, i) =>
        go(c, Math.max(shares[i]! * room, minSize(c, leafMin, gap).w))
      ),
    }
  }
  return { root: tree.root ? go(tree.root, width) : null, sizes, reflowed }
}

// ---------------------------------------------------------------- reading one

export interface TreeLimits {
  /** leaves at most */
  leaves: number
  /** splits nested at most */
  depth: number
}

/** What's wrong with a tree (none: it's normalized and within its limits). */
export function treeIssues<L extends Leaf>(n: SplitNode<L>, limits: TreeLimits): string[] {
  const issues: string[] = []
  const ids = nodeIds(n)
  if (new Set(ids).size !== ids.length) issues.push("a layout names a card, panel or split twice")
  if (leaves(n).length > limits.leaves) issues.push(`a layout holds at most ${limits.leaves}`)
  const depth = (x: SplitNode<L>): number =>
    isSplit(x) ? 1 + Math.max(...x.children.map(depth)) : 0
  if (depth(n) > limits.depth) issues.push(`a layout nests at most ${limits.depth} splits`)
  for (const s of splits(n)) {
    if (s.children.some((c) => isSplit(c) && c.dir === s.dir))
      issues.push("a split holds no split of its own direction")
  }
  return [...new Set(issues)]
}

/** A tree of `leaf`s, as a schema: normalized and within `limits`. */
export function splitNode<T extends z.ZodType<Leaf>>(
  leaf: T,
  limits: TreeLimits
): z.ZodType<SplitNode<z.output<T>>, SplitNode<z.input<T>>> {
  const node: z.ZodType<SplitNode<z.output<T>>, SplitNode<z.input<T>>> = z.lazy(() =>
    z.union([
      z.strictObject({
        id: nodeId,
        dir: splitDir,
        children: z.array(node).min(2).max(limits.leaves),
      }),
      leaf,
    ])
  )
  return node.superRefine((n, ctx) => {
    for (const message of treeIssues(n, limits)) ctx.addIssue({ code: "custom", message })
  })
}
