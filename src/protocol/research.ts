import { z } from "zod"

const metadataSchema = z.record(z.string(), z.unknown())

export const gitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{7,64}$/, "must be a hex git SHA (7-64 hex chars)")

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

export const createResearchBranchRequestSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(500).optional(),
  repositoryFullName: z.string().trim().min(1).max(240).optional(),
  githubRepositoryId: z.string().trim().min(1).optional(),
  projectPath: z.string().trim().max(240).optional(),
  // Explicit parentBranchId wins. parentGitBranchName is the CLI-friendly
  // alternative: the git branch HEAD was on at creation, resolved
  // server-side against the project's branches; no match (e.g. "main" or an
  // untracked branch) stores a null parent.
  parentBranchId: z.uuid().optional(),
  parentGitBranchName: z.string().trim().min(1).max(240).optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().trim().max(2000).optional(),
  gitBranchName: z.string().trim().min(1).max(240).optional(),
  baseCommitSha: gitShaSchema,
  currentHeadCommitSha: gitShaSchema.optional(),
  metricName: z.string().trim().min(1).max(120),
  metricUnit: z.string().trim().max(80).optional(),
  metricDirection: researchMetricDirectionSchema.default("maximize"),
})

export const createResearchExperimentRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  runRef: z.string().trim().min(1).max(240).optional(),
  commitSha: gitShaSchema,
  status: researchExperimentStatusSchema.default("succeeded"),
  primaryMetricName: z.string().trim().min(1).max(120).optional(),
  primaryMetricValue: z.number().finite().optional(),
  secondaryMetrics: metadataSchema.default({}),
  artifactRefs: metadataSchema.default({}),
  agentNotes: metadataSchema.default({}),
  checks: z
    .object({
      status: z.enum(["passed", "failed", "timed_out"]),
      durationMs: z.number().int().nonnegative().nullable().optional(),
      outputSummary: z.string().trim().max(4000).nullable().optional(),
    })
    .nullable()
    .optional(),
  durationMs: z.number().int().nonnegative().optional(),
  outputSummary: z.string().trim().max(4000).optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
})

export type ResearchMetricDirection = z.infer<
  typeof researchMetricDirectionSchema
>
export type ResearchExperimentStatus = z.infer<
  typeof researchExperimentStatusSchema
>
export type CreateResearchBranchRequest = z.infer<
  typeof createResearchBranchRequestSchema
>
export type CreateResearchExperimentRequest = z.infer<
  typeof createResearchExperimentRequestSchema
>
