import { z } from "zod"

const metadataSchema = z.record(z.string(), z.unknown())

export const gitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{7,64}$/, "must be a hex git SHA (7-64 hex chars)")

const gitRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^refs\/[A-Za-z0-9._/-]+$/, "must be a full git ref")

export const researchMetricDirectionSchema = z.enum(["maximize", "minimize"])

export const researchExperimentStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "checks_failed",
  "accepted",
  "rejected",
])

export const researchExperimentGitStatusSchema = z.enum([
  "pending",
  "verified",
  "missing",
  "mismatch",
  "unreachable",
])

export const createResearchCampaignRequestSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(500).optional(),
  repositoryFullName: z.string().trim().min(1).max(240).optional(),
  githubRepositoryId: z.string().trim().min(1).optional(),
  projectPath: z.string().trim().max(240).optional(),
  parentCampaignId: z.uuid().optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().trim().max(2000).optional(),
  baseCommitSha: gitShaSchema,
  metricName: z.string().trim().min(1).max(120),
  metricUnit: z.string().trim().max(80).optional(),
  metricDirection: researchMetricDirectionSchema.default("maximize"),
  promotionRefName: gitRefSchema.optional(),
})

const checksSchema = z
  .object({
    status: z.enum(["passed", "failed", "timed_out"]),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    outputSummary: z.string().trim().max(4000).nullable().optional(),
  })
  .nullable()
  .optional()

export const createResearchCampaignExperimentRequestSchema = z
  .object({
    sessionId: z.uuid().optional(),
    laneId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    workerId: z.uuid().optional(),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional(),
    runRef: z.string().trim().min(1).max(240),
    baseCommitSha: gitShaSchema,
    resultCommitSha: gitShaSchema,
    resultRef: gitRefSchema,
    status: researchExperimentStatusSchema.default("succeeded"),
    primaryMetricName: z.string().trim().min(1).max(120).optional(),
    primaryMetricValue: z.number().finite().optional(),
    secondaryMetrics: metadataSchema.default({}),
    artifactRefs: metadataSchema.default({}),
    agentNotes: metadataSchema.default({}),
    checks: checksSchema,
    durationMs: z.number().int().nonnegative().optional(),
    outputSummary: z.string().trim().max(4000).optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    provenance: z.array(z.unknown()).default([]),
  })
  .refine(
    (value) =>
      (value.status !== "succeeded" && value.status !== "accepted") ||
      value.primaryMetricValue !== undefined,
    {
      path: ["primaryMetricValue"],
      error:
        'primaryMetricValue is required when status is "succeeded" or "accepted"',
    }
  )

export type ResearchMetricDirection = z.infer<
  typeof researchMetricDirectionSchema
>
export type ResearchExperimentStatus = z.infer<
  typeof researchExperimentStatusSchema
>
export type ResearchExperimentGitStatus = z.infer<
  typeof researchExperimentGitStatusSchema
>
export type CreateResearchCampaignRequest = z.infer<
  typeof createResearchCampaignRequestSchema
>
export type CreateResearchCampaignExperimentRequest = z.infer<
  typeof createResearchCampaignExperimentRequestSchema
>
