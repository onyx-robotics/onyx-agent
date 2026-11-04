// Generated from packages/core/src/contracts/kg.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Knowledge-graph reads (docs/knowledge-graph.md, "Reading it"): what's related to a text or an item,
 * by embedding and by the graph.
 */
import { z } from "zod"

const uuid = z.string().uuid()

export const kgRelatedInput = z
  .object({
    /** a text: an aspect, a question, a draft insight */
    q: z.string().min(1).max(4000).optional(),
    /** an item: what's near it, and what it's tied to */
    item: uuid.optional(),
    /** narrow to these types (and their subtypes); default every embedded type */
    types: z.array(z.string().min(1)).max(20).default([]),
    limit: z.number().int().min(1).max(50).default(10),
    /** follow the graph one hop from each result */
    expand: z.boolean().default(true),
  })
  .refine((x) => (x.q === undefined) !== (x.item === undefined), {
    message: "either q or item",
  })
export type KgRelatedInput = z.input<typeof kgRelatedInput>

/** An item as a related read names it (the fields of `ItemSummary` it needs). */
export interface KgItem {
  id: string
  name: string
  type: string
  typeLabel: string
  status: string | null
  statusClass: string | null
  /** epoch ms: started_at, else created_at */
  t: number
}

export interface KgLink {
  rel: string
  /** out: the result is the edge's source */
  dir: "out" | "in"
  item: KgItem
}

export interface KgResult {
  item: KgItem & { summary: string | null; noteKind: string | null; createdBy: string | null }
  /** fused rank score (higher is closer) */
  score: number
  /** cosine similarity of the embeddings, when it was found by them */
  similarity: number | null
  /** another insight supersedes it: shown, not to be relied on */
  superseded: boolean
  links: KgLink[]
}

export interface KgRelated {
  model: string
  results: KgResult[]
}
