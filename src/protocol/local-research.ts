import {
  gitShaSchema,
  researchExperimentStatusSchema,
  researchMetricDirectionSchema,
} from "./research"
import { z } from "zod"

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/)

const metricsSchema = z.record(z.string().min(1), z.number().finite())
const metadataSchema = z.record(z.string(), z.unknown())

const checksSchema = z.object({
  status: z.enum(["passed", "failed", "timed_out"]),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  outputSummary: z.string().trim().max(4000).nullable().optional(),
})

export const localResearchSyncMetadataSchema = z.object({
  projectId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  experimentId: z.uuid().optional(),
  syncedAt: z.iso.datetime().optional(),
})

export const localResearchBranchStartedRecordSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("branch_started"),
  createdAt: z.iso.datetime(),
  name: nameSchema,
  description: z.string().trim().max(2000).nullable().optional(),
  gitBranchName: z.string().trim().min(1).max(240),
  projectPath: z.string().trim().max(240).optional(),
  baseCommitSha: gitShaSchema,
  metricName: z.string().trim().min(1).max(120),
  metricUnit: z.string().trim().max(80).nullable().optional(),
  metricDirection: researchMetricDirectionSchema,
  sync: localResearchSyncMetadataSchema.optional(),
})

export const localResearchExperimentLoggedRecordSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("experiment_logged"),
  createdAt: z.iso.datetime(),
  runRef: z.string().trim().min(1).max(240),
  branchName: nameSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  gitBranchName: z.string().trim().min(1).max(240),
  projectPath: z.string().trim().max(240).optional(),
  commitSha: gitShaSchema,
  status: researchExperimentStatusSchema,
  primaryMetricName: z.string().trim().min(1).max(120),
  primaryMetricValue: z.number().finite().nullable(),
  metrics: metricsSchema.default({}),
  agentNotes: metadataSchema.default({}),
  checks: checksSchema.nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  startedAt: z.iso.datetime().nullable().optional(),
  completedAt: z.iso.datetime().nullable().optional(),
  outputSummary: z.string().trim().max(4000).nullable().optional(),
  sync: localResearchSyncMetadataSchema.optional(),
})

export const localResearchRecordSchema = z.union([
  localResearchBranchStartedRecordSchema,
  localResearchExperimentLoggedRecordSchema,
])

export const localResearchJsonlSchema = z.array(localResearchRecordSchema)

/**
 * One experiment in `.git/onyx/history.jsonl` — the permanent, offline-
 * searchable cache of the project's research history. Unlike the outbox,
 * entries are never deleted on flush: `onyx exp log` appends provisional
 * records (`source: "local"`) and `onyx sync` rewrites the file to the
 * canonical API state (`source: "api"`), keeping still-pending local records.
 * The Onyx app remains the source of truth; this is a cache keyed by runRef.
 */
export const localResearchHistoryRecordSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(["local", "api"]),
  branchName: nameSchema,
  gitBranchName: z.string().trim().min(1).max(240).optional(),
  runRef: z.string().trim().min(1).max(240),
  commitSha: gitShaSchema,
  status: researchExperimentStatusSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  primaryMetricName: z.string().trim().min(1).max(120),
  primaryMetricValue: z.number().finite().nullable(),
  metrics: metricsSchema.default({}),
  agentNotes: metadataSchema.default({}),
  checks: checksSchema.nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  outputSummary: z.string().trim().max(4000).nullable().optional(),
  startedAt: z.iso.datetime().nullable().optional(),
  completedAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
  // Server-assigned fields, present when source === "api".
  experimentId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  sequenceNumber: z.number().int().positive().optional(),
})

export const localResearchEventTypeSchema = z.enum([
  "branch_created",
  "exp_run_started",
  "eval_finished",
  "checks_finished",
  "run_finished",
  "exp_logged",
  "flush_finished",
  "pushed",
])

/**
 * One line in `.git/onyx/events.jsonl` — a best-effort local activity feed
 * emitted by CLI commands so `onyx listen` can show what a running agent
 * session is doing. Never authoritative; periodically truncated.
 */
export const localResearchEventSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.iso.datetime(),
  type: localResearchEventTypeSchema,
  branchName: z.string().trim().max(240).optional(),
  commitSha: gitShaSchema.optional(),
  message: z.string().max(1000).optional(),
})

export type LocalResearchSyncMetadata = z.infer<
  typeof localResearchSyncMetadataSchema
>
export type LocalResearchBranchStartedRecord = z.infer<
  typeof localResearchBranchStartedRecordSchema
>
export type LocalResearchExperimentLoggedRecord = z.infer<
  typeof localResearchExperimentLoggedRecordSchema
>
export type LocalResearchRecord = z.infer<typeof localResearchRecordSchema>
export type LocalResearchHistoryRecord = z.infer<
  typeof localResearchHistoryRecordSchema
>
export type LocalResearchEventType = z.infer<
  typeof localResearchEventTypeSchema
>
export type LocalResearchEvent = z.infer<typeof localResearchEventSchema>
