// Generated from packages/core/src/contracts/write.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Write-path contracts, shared by the API and the SDK.
 *
 * An ItemRef names an entity by id, by a batch-local ref, or by its external source key. A plain
 * string is an id if it looks like a UUID, otherwise a batch-local ref.
 */
import { z } from "zod"

const uuid = z.string().uuid()
const isoDate = z.string().datetime({ offset: true })

export const sourceKey = z.object({
  system: z.string().min(1).max(64),
  key: z.string().min(1).max(512),
})

export const itemRef = z.union([
  z
    .string()
    .min(1)
    .transform((s): { id: string } | { ref: string } =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
        ? { id: s }
        : { ref: s }
    ),
  z.object({ id: uuid }).strict(),
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ source: sourceKey }).strict(),
])
export type ItemRefInput = z.input<typeof itemRef>
export type ItemRef = z.output<typeof itemRef>

export const ingestItem = z.object({
  /** batch-local handle other rows can point at */
  ref: z.string().min(1).max(200).optional(),
  /** client-minted UUIDv7 (recommended: makes retries idempotent) */
  id: uuid.optional(),
  /** external identity for idempotent upserts from other tools (mlflow run id, git sha, ...) */
  source: sourceKey.optional(),
  type: z.string().min(1),
  /** space key or id; defaults to the org's default space */
  space: z.string().min(1).optional(),
  name: z.string().min(1).max(500),
  summary: z.string().max(4000).optional(),
  status: z.string().min(1).optional(),
  startedAt: isoDate.optional(),
  endedAt: isoDate.optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  createdBy: itemRef.optional(),
  /** this item is a revision (a version) of that identity: an artifact of the same type and space */
  identity: itemRef.optional(),
  /** the revision's number within its identity (default: the next one). With it, a replay finds the revision */
  revision: z.number().int().positive().optional(),
  /** make this revision its identity's head: what pins resolve to */
  head: z.boolean().optional(),
})
export type IngestItem = z.input<typeof ingestItem>

export const ingestEdge = z.object({
  rel: z.string().min(1),
  src: itemRef,
  dst: itemRef,
  /** when it became true (world time; defaults to now, can't be in the future) */
  validFrom: isoDate.optional(),
  /** backfill of a past, ended edge of a temporal relation (an assignment that is over) */
  validTo: isoDate.optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  assertion: z.enum(["declared", "observed", "inferred"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** close the source's other current edges of this relation first (e.g. reassignment) */
  replaceCurrent: z.boolean().optional(),
  /** point at the target identity's head revision (and seal it) instead of the identity */
  pin: z.boolean().optional(),
})
export type IngestEdge = z.input<typeof ingestEdge>

export const ingestMetrics = z.object({
  /**
   * the report's id (the SDK mints one): each value's observation id derives from it, so a
   * retried report is recognised and a reused id with other values is a conflict
   */
  id: uuid.optional(),
  entity: itemRef,
  /** metric property key -> value */
  values: z.record(z.string(), z.number().finite()),
  /** the dataset / split / evaluation protocol the values are relative to */
  context: itemRef.optional(),
  /** training step, epoch or trial */
  step: z.number().int().nonnegative().optional(),
  /** when it was measured (world time; default now) */
  observedAt: isoDate.optional(),
  /** a summary over n samples, with their standard deviation */
  n: z.number().int().positive().optional(),
  stddev: z.number().nonnegative().finite().optional(),
  /**
   * the dense series these values summarize (every step, in a file or a time-series store): a
   * ref of the same entity, by id, or by system and locator (and version, when it has several).
   * A batch can attach the ref and report against it.
   */
  series: z
    .union([
      uuid,
      z.object({
        system: z.string().min(1).max(64),
        locator: z.string().min(1).max(2000),
        version: z.string().max(200).optional(),
      }),
    ])
    .optional(),
  /** anything else about how it was measured (at most 8 KB) */
  props: z
    .record(z.string(), z.unknown())
    .refine((p) => new TextEncoder().encode(JSON.stringify(p)).length <= 8192, "at most 8 KB")
    .optional(),
})
export type IngestMetrics = z.input<typeof ingestMetrics>

export const ingestRef = z.object({
  entity: itemRef,
  /**
   * content: the entity's own content, pinned by a version or content hash (the default when
   * one is given); mirror: another copy of it (same hash); annotation: a link about it (the
   * default otherwise)
   */
  role: z.enum(["content", "mirror", "annotation"]).optional(),
  system: z.string().min(1).max(64),
  locator: z.string().min(1).max(2000),
  version: z.string().max(200).optional(),
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "hex sha256")
    .optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  mediaType: z.string().max(200).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
})
export type IngestRef = z.input<typeof ingestRef>

/** One batch is one transaction: bounded so its commit (and its locks) stay short. */
export const ingestBatch = z.object({
  items: z.array(ingestItem).max(2000).default([]),
  edges: z.array(ingestEdge).max(5000).default([]),
  metrics: z.array(ingestMetrics).max(2000).default([]),
  refs: z.array(ingestRef).max(2000).default([]),
})
export type IngestBatch = z.input<typeof ingestBatch>

export interface IngestResult {
  /** ref (or source "system:key") -> entity id, for every item in the batch */
  ids: Record<string, string>
  /**
   * each item's entity id, in the batch's order: the id it was given, or the one the server
   * found by its source key or revision
   */
  itemIds: string[]
  items: { created: number; updated: number; unchanged: number }
  edges: { created: number; unchanged: number; closed: number }
  /** metric values in the batch */
  metrics: number
  /** of those, values recorded now, and values already recorded (a report sent again) */
  observations: { new: number; recognised: number }
  refs: number
  txid: string
  /**
   * moves into a restricted space that were staged instead of applied (many items derive through
   * the entity): each stays where it was until its restriction job has narrowed them, then moves
   */
  restricting?: { id: string; jobId: string }[]
}

export const updateEntityInput = z.object({
  name: z.string().min(1).max(500).optional(),
  summary: z.string().max(4000).nullable().optional(),
  status: z.string().min(1).nullable().optional(),
  startedAt: isoDate.nullable().optional(),
  endedAt: isoDate.nullable().optional(),
  space: z.string().min(1).optional(),
  /** merged into existing props; a null value removes the key */
  props: z.record(z.string(), z.unknown()).optional(),
  /** optimistic concurrency: fail with 409 if the entity changed since this version */
  expectedVersion: z.number().int().positive().optional(),
})
export type UpdateEntityInput = z.input<typeof updateEntityInput>

/** An item that exists: its id, or a source key (a batch-local ref names nothing outside a batch). */
export const existingItemRef = itemRef.refine(
  (r) => !("ref" in r),
  "name an existing item: its id, or a source key"
)

/** The current edge between two items, to close (`unlink`). */
export const closeEdgeInput = z.object({
  src: existingItemRef,
  rel: z.string().min(1),
  dst: existingItemRef,
  /** ended: it was true until now (temporal relations); retracted: recorded in error */
  kind: z.enum(["ended", "retracted"]).optional(),
})
export type CloseEdgeInput = z.input<typeof closeEdgeInput>

export const reassignInput = z.object({
  agents: z.array(uuid).min(1).max(500),
  to: uuid,
  rel: z.string().default("assigned_to"),
  reason: z.string().max(1000).optional(),
})
export type ReassignInput = z.input<typeof reassignInput>

export const createSpaceInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  visibility: z.enum(["org", "restricted"]).default("org"),
})

export const addMemberInput = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
})

export const createApiKeyInput = z.object({
  name: z.string().min(1).max(200),
  /** no `run`: a runner's key is a site's, minted when it's enrolled (docs/jobs.md, "Sites") */
  scopes: z
    .array(z.enum(["read", "ingest", "actions", "jobs"]))
    .min(1)
    .default(["read", "ingest"]),
  /** the spaces the key can use; default: the org-visible spaces (later spaces aren't added) */
  spaceIds: z.array(uuid).optional(),
  /** the AI agent entity the key acts as; created (named after the key) when omitted */
  agentEntityId: uuid.optional(),
  /** the key stops working after this many days; default: until revoked */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})

/**
 * A member's personal token: it acts as them, narrowed to its scopes (`read` always; `admin`
 * only for admins), and always expires.
 */
export const createPersonalTokenInput = z.object({
  name: z.string().trim().min(1).max(200),
  /** default: what the member's role allows, but `admin` (which is only ever asked for) */
  scopes: z.array(z.enum(["read", "ingest", "actions", "jobs", "admin"])).optional(),
  expiresInDays: z.number().int().min(1).max(365).default(90),
})
export type CreatePersonalTokenInput = z.input<typeof createPersonalTokenInput>
