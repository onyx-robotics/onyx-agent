// Generated from packages/core/src/view/sketch.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * A workspace's sketch: its thumbnail, drawn in someone's browser from what they saw in it (their
 * own spaces'), and kept for them alone (the table: `workspace_sketch`). A few of its cards, each
 * as little as tells them apart: a lane card's total over time, a plot's points, a graph's glyph.
 * Coordinates are integers over a card's own box (0…1000), heights 0…100. Browser-safe.
 */
import { z } from "zod"

/** The bins of a lane card's curve. */
export const SKETCH_BINS = 24
/** The cards a sketch draws, at most (the workspace's first). */
export const SKETCH_CARDS = 8
/** A sketch, at most (its JSON). */
export const SKETCH_MAX_BYTES = 6 * 1024

const label = z.string().max(40)
const height = z.number().int().min(0).max(100)
const coord = z.number().int().min(0).max(1000)
const curve = z.array(height).length(SKETCH_BINS)
const point = z.tuple([coord, coord])

export const sketchCard = z.discriminatedUnion("k", [
  /** its total lane's count over its time (`h`), and its first lanes' (`parts`) */
  z.strictObject({
    k: z.literal("lanes"),
    label,
    h: curve,
    parts: z.array(curve).max(2).default([]),
  }),
  /** some of its points, and each lane's best so far, as drawn */
  z.strictObject({
    k: z.literal("plot"),
    label,
    pts: z.array(point).max(40),
    best: z.array(point).max(SKETCH_BINS).default([]),
  }),
  /** a glyph of it: nodes and the edges between them, and how many items and edges it drew */
  z.strictObject({
    k: z.literal("graph"),
    label,
    n: z.number().int().min(0),
    e: z.number().int().min(0),
    nodes: z.array(point).max(24),
    edges: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).max(40),
  }),
  /** a closed card: its header */
  z.strictObject({ k: z.literal("closed"), label }),
])
export type SketchCard = z.output<typeof sketchCard>

export const workspaceSketch = z
  .strictObject({ v: z.literal(1), cards: z.array(sketchCard).max(SKETCH_CARDS) })
  .refine(
    (s) => JSON.stringify(s).length <= SKETCH_MAX_BYTES,
    `a sketch is at most ${SKETCH_MAX_BYTES / 1024} KB`
  )
export type WorkspaceSketch = z.output<typeof workspaceSketch>

/** A sketch as stored, read by this version: none when it can't be read (a newer one's). */
export function readSketch(raw: unknown): WorkspaceSketch | null {
  const r = workspaceSketch.safeParse(raw)
  return r.success ? r.data : null
}
