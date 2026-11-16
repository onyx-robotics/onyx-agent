// Generated from packages/core/src/contracts/jobs.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * Jobs (docs/jobs.md): work a unit carries out. To the platform a job says what it is (a type of
 * activity), what kind of unit it waits for, and nothing about what it means: props are the job's
 * own, handed to the unit as given, and links are edges like any other.
 */
import { z } from "zod"

import { ingestMetrics, ingestRef, itemRef } from "./write"

const uuid = z.string().uuid()
const isoDate = z.string().datetime({ offset: true })

/** A job's props travel with it to its runner: small, with what's large behind a pointer. */
export const JOB_PROPS_MAX = 16 * 1024
const bounded = (max: number) =>
  z
    .record(z.string(), z.unknown())
    .refine(
      (p) => new TextEncoder().encode(JSON.stringify(p)).length <= max,
      `at most ${max} bytes`
    )

export const jobLink = z.object({
  rel: z.string().min(1),
  dst: itemRef,
  props: z.record(z.string(), z.unknown()).optional(),
})

export const JOB_PRIORITY_MAX = 1_000_000

export const jobSubmit = z.object({
  /** client-minted UUIDv7 (the SDK mints one): the same id again is the same job */
  id: uuid.optional(),
  /** an activity type (default: `job`) */
  type: z.string().min(1).optional(),
  /** the type of unit it runs on: that asset type or any subtype of it */
  on: z.string().min(1),
  name: z.string().min(1).max(500).optional(),
  summary: z.string().max(4000).optional(),
  /** space key or id; defaults to the org's default space */
  space: z.string().min(1).optional(),
  props: bounded(JOB_PROPS_MAX).optional(),
  /** edges from the job, recorded with it */
  links: z.array(jobLink).max(32).optional(),
  /** how much of its unit it occupies */
  units: z.number().int().min(1).max(100_000).default(1),
  /** higher goes first; among equals, oldest first */
  priority: z.number().int().min(-JOB_PRIORITY_MAX).max(JOB_PRIORITY_MAX).default(0),
  /** only this unit will do */
  pin: itemRef.optional(),
  /** how many times to try again after a failure that isn't the job's own (default: none) */
  retries: z.number().int().min(0).max(100).default(0),
  /** give up waiting after this long */
  ttlS: z.number().int().min(1).max(31_536_000).optional(),
  /** who it's by (a person or AI agent); defaults to the caller */
  createdBy: itemRef.optional(),
})
export type JobSubmit = z.input<typeof jobSubmit>

export const submitJobsInput = z.object({ jobs: z.array(jobSubmit).min(1).max(1000) })
export type SubmitJobsInput = z.input<typeof submitJobsInput>

export interface SubmitJobsResult {
  jobs: { id: string; duplicate: boolean }[]
}

export const jobIds = z.array(uuid).min(1).max(1000)

export const setJobPriorityInput = z
  .object({
    ids: jobIds,
    priority: z.number().int().min(-JOB_PRIORITY_MAX).max(JOB_PRIORITY_MAX).optional(),
    /** ahead of everything waiting for the same kind of unit */
    bump: z.literal(true).optional(),
  })
  .refine((x) => (x.priority === undefined) !== (x.bump === undefined), {
    message: "either a priority or bump",
  })

export const cancelJobsInput = z.object({
  ids: jobIds,
  reason: z.string().max(500).optional(),
})

export const JOB_STATES = ["queued", "assigned", "running", "ended"] as const
export const listJobsQuery = z.object({
  state: z.enum(JOB_STATES).optional(),
  on: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  after: uuid.optional(),
})

export const setUnitsInput = z.object({
  ids: z.array(uuid).min(1).max(1000),
  reason: z.string().max(500).optional(),
})

// ---------------------------------------------------------------- a runner's side

export const JOB_OUTCOMES = ["succeeded", "failed", "cancelled", "unknown"] as const
/** The status classes a job can reach: a type needs a status for each to be a job. */
export const JOB_CLASSES = ["pending", "running", ...JOB_OUTCOMES] as const
export const JOB_FAILURES = ["job", "unit", "infra", "invalid", "refused", "lost"] as const

export const runnerUnit = z.object({
  /** its name for the unit, unique to the runner */
  key: z.string().min(1).max(200),
  /** an asset type */
  type: z.string().min(1),
  name: z.string().min(1).max(500).optional(),
  capacity: z.number().int().min(1).max(100_000).default(1),
  /** how much of it is free now */
  free: z.number().int().min(0).max(100_000),
  /** whether it's healthy: false takes it offline until it says otherwise */
  ok: z.boolean().default(true),
  reason: z.string().max(500).optional(),
})

export const runnerHeld = z.object({ id: uuid, attempt: z.number().int().min(1) })

export const runnerReport = z.object({
  id: uuid,
  attempt: z.number().int().min(1),
  state: z.enum(["started", "ended"]),
  /** when it happened; clamped to between its assignment and now */
  at: isoDate.optional(),
  outcome: z.enum(JOB_OUTCOMES).optional(),
  failure: z.enum(JOB_FAILURES).optional(),
  reason: z.string().max(1000).optional(),
  /** merged into its record when it ends: what it observed, as it reports it */
  props: bounded(JOB_PROPS_MAX).optional(),
  metrics: z
    .array(ingestMetrics.omit({ entity: true, id: true, series: true }))
    .max(64)
    .optional(),
  /** where what it made is: pointers, never content */
  refs: z
    .array(ingestRef.omit({ entity: true }))
    .max(64)
    .optional(),
})

export const runnerSyncInput = z.object({
  /** this process: another's on a live lease is refused */
  instance: z.string().min(1).max(128),
  version: z.string().max(64).optional(),
  /** every unit it offers, each call: only a change costs anything */
  units: z.array(runnerUnit).max(1000),
  /** every attempt it holds, in its journal and not finally reported */
  held: z.array(runnerHeld).max(10_000).default([]),
  /** each checked on its own: one that's wrong comes back in `rejected` */
  reports: z.array(z.unknown()).max(1000).default([]),
  /** take at most this many new jobs */
  maxAssign: z.number().int().min(0).max(500).default(100),
  /** a clean stop: this sync's reports go in, nothing is assigned, and the lease is given up so
   *  the next process needn't wait it out. Not sent on a crash: the lease protects that */
  leaving: z.boolean().optional(),
})
export type RunnerSyncInput = z.input<typeof runnerSyncInput>

export interface RunnerAssignment {
  id: string
  attempt: number
  type: string
  name: string
  summary: string | null
  unit: string
  units: number
  props: Record<string, unknown>
  /** retries left: while it has any, it must stop if it can't reach the platform for `leaseMs` */
  retries: number
  links: { rel: string; dst: string }[]
}

export interface RunnerSyncResult {
  assign: RunnerAssignment[]
  /** stop these, then report them cancelled */
  cancel: string[]
  /** no longer this runner's: stop them and forget them */
  stale: string[]
  /** reports that couldn't be taken as sent */
  rejected: { index: number; id: string | null; attempt: number | null; reason: string }[]
  /** when to call again */
  nextInMs: number
  /** how long without a successful sync before its jobs with retries left must stop */
  leaseMs: number
}

/** POST /jobs/queue/pause: a reason, if given, goes in the org's events */
export const pauseQueueInput = z.object({
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((r) => r || undefined),
})
/**
 * POST /jobs/queue/clear: cancel every waiting job the caller may cancel (anyone's for an admin,
 * their own otherwise); or only those waiting for one kind of unit (`on`, pinned ones included); or
 * only those pinned to one unit (`unit`, its id), its own line. What's running is left alone:
 * stopping it is a cancel of that job.
 */
export const clearQueueInput = z
  .object({
    on: z.string().min(1).optional(),
    unit: uuid.optional(),
    reason: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((r) => r || undefined),
  })
  .refine((x) => !(x.on && x.unit), { message: "a kind of unit or a unit, not both" })
export interface ClearQueueResult {
  /** how many waiting jobs it cancelled */
  cancelled: number
}
/** POST /jobs/queue/resume */
export const resumeQueueInput = z.object({ reason: z.string().trim().max(500).optional() })

export interface QueueState {
  paused: boolean
  pausedAt: string | null
  /** the actor entity that paused it */
  pausedBy: string | null
  reason: string | null
}

/** POST /sites/me: what a site says about itself when it starts */
export const siteReportInput = z.object({
  /** where its file server is, as people's browsers reach it */
  filesUrl: z
    .string()
    .url()
    .max(500)
    .regex(/^https?:\/\//, "an http(s) URL")
    .optional(),
  version: z.string().max(64).optional(),
})

/** A key a site checks download links with (Ed25519, as a JWK). */
export interface SiteLinkKey {
  kid: string
  alg: "EdDSA"
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string }
}

/** GET /sites/me */
export interface SiteSelf {
  site: { id: string; name: string }
  org: { id: string; name: string; slug: string }
  linkKeys: SiteLinkKey[]
}

/** GET /sites (admins) */
export interface SiteRow {
  id: string
  name: string
  agentEntityId: string
  filesUrl: string | null
  version: string | null
  createdAt: string
  revokedAt: string | null
  /** the runner's last sync: what "online" is judged by */
  lastSyncAt: string | null
}

/** A file a job's run left on its site, with a link that works for a few minutes. */
export interface JobFile {
  locator: string
  /** its path within the run */
  path: string
  contentHash: string | null
  sizeBytes: number | null
  mediaType: string | null
  url: string
  expiresAt: string
}

/** The ref system a site-runner reports its files under: `<job>/<attempt>/<path>` on its file server. */
export const SITE_FILES_SYSTEM = "onyx-site"
