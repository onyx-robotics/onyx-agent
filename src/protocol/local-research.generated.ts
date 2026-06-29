// Generated from packages/contracts. Do not edit by hand.

import {
  gitShaSchema,
  researchExperimentGitStatusSchema,
  researchExperimentStatusSchema,
  researchMetricDirectionSchema,
  researchSetupComplianceSchema,
  researchSetupFileSchema,
} from "./research.generated"
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

export const localResearchRemoteMetadataSchema = z.object({
  projectId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
  experimentId: z.uuid().optional(),
  workerId: z.uuid().optional(),
  hypothesisId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  acceptedIndex: z.number().int().positive().nullable().optional(),
  reportedAt: z.iso.datetime().optional(),
})

export const localResearchCampaignStartedRecordSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("campaign_started"),
  createdAt: z.iso.datetime(),
  name: nameSchema,
  description: z.string().trim().max(2000).nullable().optional(),
  projectPath: z.string().trim().max(240).optional(),
  baseCommitSha: gitShaSchema,
  setup: researchSetupFileSchema,
  metricName: z.string().trim().min(1).max(120),
  metricUnit: z.string().trim().max(80).nullable().optional(),
  metricDirection: researchMetricDirectionSchema,
  humanFeedback: z.string().trim().max(4000).nullable().optional(),
  promotionRefName: z.string().trim().min(1).max(300).nullable().optional(),
  remote: localResearchRemoteMetadataSchema.optional(),
})

export const localResearchCampaignExperimentLoggedRecordSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("campaign_experiment_logged"),
  createdAt: z.iso.datetime(),
  runRef: z.string().trim().min(1).max(240),
  campaignName: nameSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  projectPath: z.string().trim().max(240).optional(),
  baseCommitSha: gitShaSchema,
  resultCommitSha: gitShaSchema,
  resultRef: z.string().trim().min(1).max(300),
  status: researchExperimentStatusSchema,
  setupCompliance: researchSetupComplianceSchema.default({
    status: "passed",
    protectedPathsChanged: [],
    outOfScopePathsChanged: [],
    setupPathsChanged: [],
    notes: null,
  }),
  primaryMetricName: z.string().trim().min(1).max(120),
  primaryMetricValue: z.number().finite().nullable(),
  metrics: metricsSchema.default({}),
  agentNotes: metadataSchema.default({}),
  checks: checksSchema.nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  startedAt: z.iso.datetime().nullable().optional(),
  completedAt: z.iso.datetime().nullable().optional(),
  outputSummary: z.string().trim().max(4000).nullable().optional(),
  sessionId: z.uuid().optional(),
  workerId: z.uuid().optional(),
  hypothesisId: z.uuid().optional(),
  remote: localResearchRemoteMetadataSchema.optional(),
})

export const localResearchRecordSchema = z.union([
  localResearchCampaignStartedRecordSchema,
  localResearchCampaignExperimentLoggedRecordSchema,
])

export const localResearchJsonlSchema = z.array(localResearchRecordSchema)

/**
 * One experiment in a local runtime history export. The Onyx API remains the
 * source of truth; this cache is keyed by runRef and refreshed from direct API
 * reads.
 */
export const localResearchHistoryRecordSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(["local", "api"]),
  campaignName: nameSchema,
  runRef: z.string().trim().min(1).max(240),
  baseCommitSha: gitShaSchema,
  resultCommitSha: gitShaSchema,
  resultRef: z.string().trim().min(1).max(300),
  gitStatus: researchExperimentGitStatusSchema.optional(),
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
  acceptedIndex: z.number().int().positive().nullable().optional(),
  experimentId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  workerId: z.uuid().optional(),
  hypothesisId: z.uuid().optional(),
})

export const localResearchEventTypeSchema = z.enum([
  "campaign_created",
  "campaign_deleted",
  "setup_created",
  "setup_validated",
  "setup_validation_failed",
  "session_started",
  "session_stopped",
  "hypothesis_created",
  "hypothesis_started",
  "hypothesis_heartbeat",
  "hypothesis_completed",
  "worker_started",
  "worker_heartbeat",
  "worker_stopped",
  "research_started",
  "exp_run_started",
  "eval_finished",
  "checks_finished",
  "run_finished",
  "exp_logged",
  "flush_finished",
  "pushed",
])

/**
 * One line in `.git/onyx/events.jsonl`, a best-effort local activity feed for
 * `onyx listen`. It is never authoritative and must never fail a command.
 */
export const localResearchEventSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.iso.datetime(),
  type: localResearchEventTypeSchema,
  campaignName: z.string().trim().max(240).optional(),
  campaignId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  workerId: z.uuid().optional(),
  hypothesisId: z.uuid().optional(),
  runRef: z.string().trim().max(240).optional(),
  commitSha: gitShaSchema.optional(),
  resultRef: z.string().trim().max(300).optional(),
  message: z.string().max(1000).optional(),
})

export type LocalResearchRemoteMetadata = z.infer<
  typeof localResearchRemoteMetadataSchema
>
export type LocalResearchCampaignStartedRecord = z.infer<
  typeof localResearchCampaignStartedRecordSchema
>
export type LocalResearchCampaignExperimentLoggedRecord = z.infer<
  typeof localResearchCampaignExperimentLoggedRecordSchema
>
export type LocalResearchRecord = z.infer<typeof localResearchRecordSchema>
export type LocalResearchHistoryRecord = z.infer<
  typeof localResearchHistoryRecordSchema
>
export type LocalResearchEventType = z.infer<
  typeof localResearchEventTypeSchema
>
export type LocalResearchEvent = z.infer<typeof localResearchEventSchema>
