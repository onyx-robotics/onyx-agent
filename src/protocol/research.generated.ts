// Generated from packages/contracts. Do not edit by hand.

import { z } from "zod"

const metadataSchema = z.record(z.string(), z.unknown())
const projectPathSchema = z
  .string()
  .trim()
  .max(240)
  .transform((value) =>
    value
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\/+/g, "/")
  )
  .refine(
    (value) =>
      value
        .split("/")
        .filter(Boolean)
        .every((segment) => segment !== "." && segment !== ".."),
    "must be a relative repository path"
  )

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
  .refine((value) => value.split("/").length >= 3, "must have a ref namespace")

export const researchMetricDirectionSchema = z.enum(["maximize", "minimize"])
export const researchExperimentStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "checks_failed",
  "setup_violation",
])
export const researchExperimentDispositionSchema = z.enum([
  "received",
  "accepted",
  "discarded",
])
export const researchProjectProviderSchema = z.literal("github")
export const researchRepositoryAccessModeSchema = z.enum([
  "local_reported",
  "github_public",
  "github_app",
])
export const researchRepositorySyncStatusSchema = z.enum([
  "not_synced",
  "syncing",
  "synced",
  "failed",
])
export const researchCampaignStatusSchema = z.enum(["active", "archived"])
export const researchHypothesisStatusSchema = z.enum(["active", "closed"])
export const researchSessionRuntimeStateSchema = z.enum([
  "starting",
  "active",
  "stale",
  "abandoned",
  "ended",
])
export const researchSessionEndReasonSchema = z.enum([
  "experiment_target_reached",
  "deadline_reached",
  "user_stopped",
  "provider_capacity_exhausted",
  "all_hypotheses_closed",
  "supervisor_failed",
  "failed",
  "abandoned",
])
export const researchWorkerRuntimeSchema = z.enum(["local", "hosted"])
export const researchWorkerStatusSchema = z.enum([
  "registered",
  "running",
  "completed",
  "failed",
  "stopped",
])
export const researchWorkerLivenessSchema = z.enum([
  "active",
  "stale",
  "lost",
  "unknown",
  "terminal",
])
export const researchStopReasonCodeSchema = z.enum([
  "user_stopped",
  "session_ended",
  "deadline_reached",
  "experiment_target_reached",
  "hypothesis_closed",
])
export const researchExperimentGitStatusSchema = z.enum([
  "local_reported",
  "pending",
  "verified",
  "missing",
  "mismatch",
  "unreachable",
])
export const researchResultRefPushStatusSchema = z.enum([
  "pushed",
  "failed",
  "skipped",
])
export const researchExperimentLinkTypeSchema = z.enum([
  "inspired_by",
  "code_derived_from",
  "supersedes",
  "conflicts_with",
])
export const researchKnowledgeKindSchema = z.enum([
  "insight",
  "dead_end",
  "promising_direction",
  "risk",
  "transfer_note",
])

export const researchSetupIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    "must use lowercase path-safe namespaced segments"
  )

const researchSetupToolSchema = z
  .object({
    description: z.string().trim().max(1000).optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    shell: z.boolean().default(false),
    cwd: z.string().trim().min(1).default("project"),
    env: z.record(z.string(), z.string()).default({}),
    resources: z.array(researchSetupIdSchema).default([]),
    timeoutSeconds: z.number().positive().default(600),
    leaseTimeoutSeconds: z.number().positive().default(120),
    outputLimitBytes: z.number().int().positive().default(4000),
    fingerprintPaths: z
      .array(projectPathSchema.pipe(z.string().min(1)))
      .default([]),
  })
  .strict()

const researchSetupResourceSchema = z
  .object({
    slots: z.number().int().positive().default(1),
    description: z.string().trim().max(1000).optional(),
  })
  .strict()

const researchSetupScopeSchema = z
  .object({
    editable: z.array(z.string().trim().min(1).max(240)).default([]),
    protected: z.array(z.string().trim().min(1).max(240)).default([]),
  })
  .strict()

const researchSetupMetricSchema = z
  .object({
    name: researchSetupIdSchema,
    unit: z.string().trim().max(80).nullable().default(null),
    direction: researchMetricDirectionSchema,
  })
  .strict()

const researchSetupWorkflowStepSchema = z
  .object({
    id: researchSetupIdSchema,
    agent: z.string().trim().min(1).max(2000).optional(),
    run: researchSetupIdSchema.optional(),
    metric: z.literal(true).optional(),
    optional: z.boolean().default(false),
    pause: z.literal(true).optional(),
    guardrail: z.literal(true).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const hasAgent = step.agent !== undefined
    const hasRun = step.run !== undefined
    if (hasAgent === hasRun) {
      ctx.addIssue({
        code: "custom",
        message: "workflow step must have exactly one of agent or run",
        path: ["agent"],
      })
    }
    if (hasAgent && (step.metric || step.guardrail || step.optional)) {
      ctx.addIssue({
        code: "custom",
        message: "agent steps cannot be metric, guardrail, or optional steps",
        path: ["agent"],
      })
    }
  })

export const researchSetupFileSchema = z
  .object({
    schemaVersion: z.literal(2).default(2),
    goal: z.string().trim().min(1).max(4000),
    projectPath: projectPathSchema.default(""),
    scope: researchSetupScopeSchema.default({ editable: [], protected: [] }),
    metric: researchSetupMetricSchema,
    resources: z
      .record(researchSetupIdSchema, researchSetupResourceSchema)
      .default({}),
    tools: z.record(researchSetupIdSchema, researchSetupToolSchema).default({}),
    workflow: z.array(researchSetupWorkflowStepSchema).min(2),
  })
  .strict()
  .superRefine((setup, ctx) => {
    const stepIds = new Set<string>()
    for (const [index, step] of setup.workflow.entries()) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate workflow step id: ${step.id}`,
          path: ["workflow", index, "id"],
        })
      }
      stepIds.add(step.id)
      if (step.run && !Object.hasOwn(setup.tools, step.run)) {
        ctx.addIssue({
          code: "custom",
          message: `workflow step references unknown tool: ${step.run}`,
          path: ["workflow", index, "run"],
        })
      }
    }

    const agentSteps = setup.workflow.filter((step) => step.agent !== undefined)
    if (agentSteps.length !== 1 || setup.workflow[0]?.agent === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "workflow v1 must have exactly one leading agent step",
        path: ["workflow"],
      })
    }

    const metricSteps = setup.workflow.filter(
      (step) => step.metric && !step.optional
    )
    if (metricSteps.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "workflow v1 must have exactly one required metric step",
        path: ["workflow"],
      })
    }
    const metricToolId = metricSteps[0]?.run
    if (
      metricToolId &&
      (setup.tools[metricToolId]?.fingerprintPaths.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: `required metric tool ${metricToolId} must declare fingerprintPaths`,
        path: ["tools", metricToolId, "fingerprintPaths"],
      })
    }

    for (const [toolId, tool] of Object.entries(setup.tools)) {
      for (const [resourceIndex, resource] of tool.resources.entries()) {
        if (!Object.hasOwn(setup.resources, resource)) {
          ctx.addIssue({
            code: "custom",
            message: `tool ${toolId} references unknown resource: ${resource}`,
            path: ["tools", toolId, "resources", resourceIndex],
          })
        }
      }
    }
  })

export const researchSetupValidationCheckStatusSchema = z.enum([
  "passed",
  "warning",
  "failed",
])

export const researchSetupValidationCheckSchema = z
  .object({
    id: researchSetupIdSchema,
    status: researchSetupValidationCheckStatusSchema,
    message: z.string().trim().max(1000),
    evidence: metadataSchema.default({}),
  })
  .strict()

export const researchSetupValidationFileSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    status: z
      .enum(["passed", "warning", "failed", "blocked"])
      .default("passed"),
    setupHash: z
      .string()
      .trim()
      .regex(/^sha256:[0-9a-f]{64}$/),
    generatedAt: z.iso.datetime(),
    checks: z.array(researchSetupValidationCheckSchema).default([]),
    summary: z.string().trim().max(4000).nullable().default(null),
  })
  .strict()

export const researchHypothesisPlanSchema = z.object({
  focus: z.string().trim().min(1).max(1000),
  statement: z.string().trim().min(1).max(2000),
  startingPoints: z.array(z.string().trim().min(1).max(500)).default([]),
  avoidList: z.array(z.string().trim().min(1).max(500)).default([]),
  successSignals: z.array(z.string().trim().min(1).max(500)).default([]),
  giveUpSignals: z.array(z.string().trim().min(1).max(500)).default([]),
})

export const researchSetupComplianceSchema = z.object({
  status: z.enum(["passed", "setup_violation"]),
  protectedPathsChanged: z.array(z.string()).default([]),
  outOfScopePathsChanged: z.array(z.string()).default([]),
  setupPathsChanged: z.array(z.string()).default([]),
  notes: z.string().nullable().default(null),
})

const sha256Schema = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/)

export const researchEvaluationFingerprintFileSchema = z.object({
  path: projectPathSchema.pipe(z.string().min(1)),
  sha256: sha256Schema,
})

export const researchEvaluationManifestSchema = z
  .object({
    algorithmVersion: z.literal(1),
    metric: researchSetupMetricSchema,
    metricStep: researchSetupWorkflowStepSchema,
    metricToolId: researchSetupIdSchema,
    metricTool: researchSetupToolSchema,
    files: z.array(researchEvaluationFingerprintFileSchema).min(1),
  })
  .strict()

export const researchEvaluationRevisionSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  fingerprint: sha256Schema,
  setupHash: sha256Schema,
  manifest: researchEvaluationManifestSchema,
  firstSeenCommitSha: z.string().min(1),
  gitStatus: researchExperimentGitStatusSchema,
  gitVerifiedAt: z.iso.datetime().nullable(),
  gitStatusReason: z.string().nullable(),
  bestExperimentId: z.uuid().nullable(),
  bestMetricValue: z.number().finite().nullable(),
  bestCommitSha: z.string().nullable(),
  experimentCount: z.number().int().nonnegative(),
  lastExperimentAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const researchProjectSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  name: z.string().min(1),
  repositoryUrl: z.url(),
  repositoryOwner: z.string().min(1),
  repositoryName: z.string().min(1),
  repositoryProvider: researchProjectProviderSchema,
  repositoryAccessMode: researchRepositoryAccessModeSchema,
  githubInstallationId: z.string().min(1).nullable(),
  githubRepositoryId: z.string().min(1).nullable(),
  repositoryFullName: z.string().min(1).nullable(),
  repositoryIsPrivate: z.boolean(),
  defaultBranch: z.string().min(1),
  projectPath: projectPathSchema,
  syncStatus: researchRepositorySyncStatusSchema,
  lastSyncedAt: z.iso.datetime().nullable(),
  lastSyncedCommitSha: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  startCommitSha: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

const repositoryFullNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .transform((value) => value.replace(/^\/+|\/+$/g, ""))
  .refine(
    (value) => /^[^/\s]+\/[^/\s]+$/.test(value),
    "must be a GitHub repository full name like owner/repo"
  )

const researchRepositoryIdentitySchema = z
  .object({
    repositoryUrl: z.string().trim().min(1).max(500).optional(),
    repositoryFullName: repositoryFullNameSchema.optional(),
    githubRepositoryId: z.string().trim().min(1).optional(),
    projectPath: projectPathSchema.default(""),
  })
  .refine(
    (value) =>
      Boolean(
        value.repositoryUrl ||
        value.repositoryFullName ||
        value.githubRepositoryId
      ),
    "repositoryUrl, repositoryFullName, or githubRepositoryId is required"
  )

const researchChecksSchema = z
  .object({
    status: z.enum(["passed", "failed", "timed_out"]),
    durationMs: z.number().int().nonnegative().nullable(),
    outputSummary: z.string().nullable(),
  })
  .nullable()

export const researchCampaignSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  parentCampaignId: z.uuid().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  createdFromCommitSha: z.string().nullable(),
  currentEvaluationRevisionId: z.uuid().nullable(),
  status: researchCampaignStatusSchema,
  metricName: z.string().min(1),
  metricUnit: z.string().nullable(),
  metricDirection: researchMetricDirectionSchema,
  currentEvaluationRevision: researchEvaluationRevisionSchema.nullable(),
  experimentCount: z.number().int().nonnegative(),
  lastExperimentAt: z.iso.datetime().nullable(),
  promotionRefName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const createResearchCampaignRequestSchema =
  researchRepositoryIdentitySchema.extend({
    parentCampaignId: z.uuid().optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    description: z.string().trim().max(2000).optional(),
    createdFromCommitSha: gitShaSchema.optional(),
    setup: researchSetupFileSchema,
    humanFeedback: z.string().trim().max(4000).optional(),
    promotionRefName: gitRefSchema.optional(),
  })

export const researchCampaignExperimentSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid(),
  evaluationRevisionId: z.uuid(),
  assignmentId: z.uuid(),
  hypothesisId: z.uuid(),
  workerId: z.uuid().nullable(),
  acceptedIndex: z.number().int().positive().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  runRef: z.string().min(1),
  baseCommitSha: z.string().min(1),
  resultCommitSha: z.string().min(1),
  resultRef: z.string().min(1),
  gitStatus: researchExperimentGitStatusSchema,
  gitVerifiedAt: z.iso.datetime().nullable(),
  gitStatusReason: z.string().nullable(),
  resultRefPushStatus: researchResultRefPushStatusSchema.nullable(),
  resultRefPushedAt: z.iso.datetime().nullable(),
  resultRefPushError: z.string().nullable(),
  status: researchExperimentStatusSchema,
  disposition: researchExperimentDispositionSchema,
  dispositionReason: z.string().nullable(),
  settledAt: z.iso.datetime().nullable(),
  setupCompliance: researchSetupComplianceSchema.nullable(),
  primaryMetricName: z.string().min(1),
  primaryMetricValue: z.number().finite().nullable(),
  secondaryMetrics: metadataSchema,
  artifactRefs: metadataSchema,
  agentNotes: metadataSchema,
  checks: researchChecksSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  outputSummary: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const researchExperimentLinkSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sourceExperimentId: z.uuid(),
  targetExperimentId: z.uuid(),
  linkType: researchExperimentLinkTypeSchema,
  note: z.string().nullable(),
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
})

export const createResearchCampaignExperimentRequestSchema = z
  .object({
    sessionId: z.uuid(),
    assignmentId: z.uuid(),
    hypothesisId: z.uuid(),
    workerId: z.uuid().optional(),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional(),
    runRef: z.string().trim().min(1).max(240),
    baseCommitSha: gitShaSchema,
    resultCommitSha: gitShaSchema,
    resultRef: gitRefSchema,
    resultRefPushStatus: researchResultRefPushStatusSchema.optional(),
    resultRefPushedAt: z.iso.datetime().optional(),
    resultRefPushError: z.string().trim().max(2000).optional(),
    status: researchExperimentStatusSchema.default("succeeded"),
    setupCompliance: researchSetupComplianceSchema.default({
      status: "passed",
      protectedPathsChanged: [],
      outOfScopePathsChanged: [],
      setupPathsChanged: [],
      notes: null,
    }),
    primaryMetricName: z.string().trim().min(1).max(120).optional(),
    primaryMetricValue: z.number().finite().optional(),
    secondaryMetrics: metadataSchema.default({}),
    artifactRefs: metadataSchema.default({}),
    agentNotes: metadataSchema.default({}),
    checks: researchChecksSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    outputSummary: z.string().trim().max(4000).optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    provenance: z
      .array(
        z.object({
          targetExperimentId: z.uuid(),
          linkType: researchExperimentLinkTypeSchema,
          note: z.string().trim().max(1000).optional(),
          metadata: metadataSchema.default({}),
        })
      )
      .default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "succeeded" || value.primaryMetricValue !== undefined,
    {
      path: ["primaryMetricValue"],
      error: 'primaryMetricValue is required when status is "succeeded"',
    }
  )

export const batchResearchCampaignExperimentRequestSchema = z.object({
  experiments: z
    .array(createResearchCampaignExperimentRequestSchema)
    .min(1)
    .max(100),
})

export const batchResearchCampaignExperimentResultStatusSchema = z.enum([
  "recorded",
  "duplicate",
  "deleted",
  "invalid",
])

export const batchResearchCampaignExperimentResponseSchema = z.object({
  data: z.object({
    results: z.array(
      z.object({
        runRef: z.string().min(1),
        status: batchResearchCampaignExperimentResultStatusSchema,
        experiment: researchCampaignExperimentSchema.nullable(),
        error: z
          .object({
            code: z.string().min(1),
            message: z.string().min(1),
          })
          .nullable(),
      })
    ),
  }),
})

export const researchSessionHypothesisAssignmentSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid(),
  hypothesisId: z.uuid(),
  startingCommitSha: z.string().min(1),
  sourceExperimentId: z.uuid().nullable(),
  setupHash: sha256Schema,
  evaluationFingerprint: sha256Schema,
  gitStatus: researchExperimentGitStatusSchema,
  gitVerifiedAt: z.iso.datetime().nullable(),
  gitStatusReason: z.string().nullable(),
  canceledAt: z.iso.datetime().nullable(),
  cancelReason: z.string().nullable(),
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const researchSessionSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  name: z.string().min(1),
  evaluationRevisionId: z.uuid(),
  baseCommitSha: z.string().min(1),
  setupHash: sha256Schema,
  baseGitStatus: researchExperimentGitStatusSchema,
  baseGitVerifiedAt: z.iso.datetime().nullable(),
  baseGitStatusReason: z.string().nullable(),
  runtimeState: researchSessionRuntimeStateSchema,
  workerTarget: z.number().int().positive(),
  experimentTarget: z.number().int().positive().nullable(),
  acceptedExperimentCount: z.number().int().nonnegative(),
  remainingExperimentCount: z.number().int().nonnegative().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  schedulerSiteId: z.string().min(1).nullable(),
  endedAt: z.iso.datetime().nullable(),
  endReason: researchSessionEndReasonSchema.nullable(),
  assignments: z.array(researchSessionHypothesisAssignmentSchema).default([]),
  metadata: metadataSchema,
  startedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

const researchSessionAssignmentInputSchema = z.object({
  hypothesisId: z.uuid(),
  startingCommitSha: gitShaSchema,
  sourceExperimentId: z.uuid().optional(),
  setupHash: sha256Schema,
  evaluationFingerprint: sha256Schema,
})

export const createResearchSessionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    baseCommitSha: gitShaSchema,
    setupHash: sha256Schema,
    evaluationFingerprint: sha256Schema,
    evaluationManifest: researchEvaluationManifestSchema,
    workerTarget: z.number().int().positive().max(500).default(1),
    experimentTarget: z.number().int().positive().max(100000).optional(),
    deadlineAt: z.iso.datetime().optional(),
    schedulerSiteId: z.string().trim().min(1).max(240).optional(),
    assignments: z.array(researchSessionAssignmentInputSchema).min(1).max(500),
    metadata: metadataSchema.default({}),
  })
  .refine(
    (value) =>
      value.experimentTarget !== undefined || value.deadlineAt !== undefined,
    {
      path: ["experimentTarget"],
      error: "experimentTarget or deadlineAt is required",
    }
  )
  .refine(
    (value) =>
      value.assignments.every(
        (assignment) =>
          assignment.setupHash === value.setupHash &&
          assignment.evaluationFingerprint === value.evaluationFingerprint
      ),
    {
      path: ["assignments"],
      error:
        "assignment setup and evaluation fingerprints must match the session",
    }
  )

export const createResearchHypothesisRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  plan: researchHypothesisPlanSchema,
  metadata: metadataSchema.default({}),
})

export const updateResearchHypothesisRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  plan: researchHypothesisPlanSchema.optional(),
  metadata: metadataSchema.optional(),
})

export const researchHypothesisSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  createdBySessionId: z.uuid().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: researchHypothesisStatusSchema,
  plan: researchHypothesisPlanSchema,
  summaryEvaluationRevisionId: z.uuid().nullable(),
  bestExperimentId: z.uuid().nullable(),
  bestMetricValue: z.number().finite().nullable(),
  bestCommitSha: z.string().nullable(),
  experimentCount: z.number().int().nonnegative(),
  lastWorkedAt: z.iso.datetime().nullable(),
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const researchKnowledgeSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid().nullable(),
  hypothesisId: z.uuid().nullable(),
  authoredByWorkerId: z.uuid().nullable(),
  experimentId: z.uuid().nullable(),
  kind: researchKnowledgeKindSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const createResearchKnowledgeRequestSchema = z.object({
  sessionId: z.uuid().optional(),
  hypothesisId: z.uuid().optional(),
  authoredByWorkerId: z.uuid().optional(),
  experimentId: z.uuid().optional(),
  kind: researchKnowledgeKindSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  confidence: z.number().min(0).max(1).nullable().optional(),
  metadata: metadataSchema.default({}),
})

export const researchWorkerSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid(),
  assignmentId: z.uuid(),
  hypothesisId: z.uuid(),
  workerName: z.string().min(1),
  agentKind: z.string().min(1),
  runtime: researchWorkerRuntimeSchema,
  status: researchWorkerStatusSchema,
  liveness: researchWorkerLivenessSchema.default("unknown"),
  startedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  currentExperimentId: z.uuid().nullable(),
  phase: z.string().nullable(),
  progressMessage: z.string().nullable(),
  gitLabel: z.string().nullable(),
  siteId: z.uuid().nullable().optional(),
  supervisorRunId: z.string().nullable().optional(),
  workerRef: z.string().nullable().optional(),
  leaseExpiresAt: z.iso.datetime().nullable().optional(),
  leaseReleasedAt: z.iso.datetime().nullable().optional(),
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const researchWorkerHeartbeatSchema = z.object({
  id: z.uuid(),
  workerId: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid().nullable(),
  hypothesisId: z.uuid(),
  experimentId: z.uuid().nullable(),
  status: researchWorkerStatusSchema,
  phase: z.string().nullable(),
  event: z.string().nullable(),
  progressMessage: z.string().nullable(),
  gitLabel: z.string().nullable(),
  resourceStats: metadataSchema,
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
})

const researchWorkerHeartbeatRequestBaseSchema = z.object({
  leaseToken: z.string().trim().min(16).max(200).optional(),
  status: researchWorkerStatusSchema.default("running"),
  sessionId: z.uuid().optional(),
  hypothesisId: z.uuid().optional(),
  experimentId: z.uuid().nullable().optional(),
  phase: z.string().trim().max(120).nullable().optional(),
  event: z.string().trim().max(160).nullable().optional(),
  progressMessage: z.string().trim().max(1000).nullable().optional(),
  gitLabel: z.string().trim().max(240).nullable().optional(),
  resourceStats: metadataSchema.default({}),
  metadata: metadataSchema.default({}),
})

function validateHeartbeatLeaseToken(
  value: z.infer<typeof researchWorkerHeartbeatRequestBaseSchema>,
  ctx: z.RefinementCtx
) {
  if (
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "stopped" &&
    !value.leaseToken
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["leaseToken"],
      message: "leaseToken is required for nonterminal worker heartbeats",
    })
  }
}

export const researchWorkerHeartbeatRequestSchema =
  researchWorkerHeartbeatRequestBaseSchema.superRefine(
    validateHeartbeatLeaseToken
  )

export const researchWorkerHeartbeatBatchRequestSchema = z.object({
  heartbeats: z
    .array(
      researchWorkerHeartbeatRequestBaseSchema
        .extend({
          workerId: z.uuid(),
        })
        .superRefine(validateHeartbeatLeaseToken)
    )
    .min(1)
    .max(500),
})

export const acquireResearchWorkerLeaseRequestSchema = z.object({
  siteId: z.uuid(),
  supervisorRunId: z.string().trim().min(1).max(120),
  workerName: z.string().trim().min(1).max(160),
  agentKind: z.string().trim().min(1).max(80).default("codex"),
  runtime: researchWorkerRuntimeSchema.default("local"),
  leaseSeconds: z.number().int().min(30).max(3600).default(300),
  metadata: metadataSchema.default({}),
})

export const acquireResearchWorkerLeaseBatchRequestSchema = z.object({
  siteId: z.uuid(),
  supervisorRunId: z.string().trim().min(1).max(120),
  workers: z
    .array(
      z.object({
        workerRef: z.string().trim().min(1).max(160),
        workerName: z.string().trim().min(1).max(160),
        agentKind: z.string().trim().min(1).max(80).default("codex"),
        runtime: researchWorkerRuntimeSchema.default("local"),
        leaseSeconds: z.number().int().min(30).max(3600).default(300),
        metadata: metadataSchema.default({}),
      })
    )
    .min(1)
    .max(500),
})

export const researchPresenceWorkerSnapshotSchema = z.object({
  id: z.uuid(),
  status: researchWorkerStatusSchema.default("running"),
  phase: z.string().trim().max(120).nullable().optional(),
  progressMessage: z.string().trim().max(1000).nullable().optional(),
  gitLabel: z.string().trim().max(240).nullable().optional(),
  currentExperimentId: z.uuid().nullable().optional(),
  lastOutputAt: z.iso.datetime().nullable().optional(),
  activitySummary: metadataSchema.default({}),
  metadata: metadataSchema.default({}),
  observedAt: z.iso.datetime(),
})

export const researchPresenceSiteSnapshotSchema = z.object({
  providerBackoff: metadataSchema.nullable().optional(),
  ignoredPresence: metadataSchema.default({}),
  activeWorkerCount: z.number().int().nonnegative().default(0),
  launchedWorkerCount: z.number().int().nonnegative().default(0),
  failedLaunchCount: z.number().int().nonnegative().default(0),
  uploadedWorkerCount: z.number().int().nonnegative().default(0),
  unchangedWorkerCount: z.number().int().nonnegative().default(0),
  droppedOrDeferredWorkerCount: z.number().int().nonnegative().default(0),
  lastUploadAt: z.iso.datetime().nullable().optional(),
  metadata: metadataSchema.default({}),
})

export const upsertResearchPresenceRequestSchema = z.object({
  siteId: z.uuid(),
  supervisorRunId: z.string().trim().min(1).max(120),
  sequence: z.number().int().nonnegative(),
  sessionId: z.uuid(),
  site: researchPresenceSiteSnapshotSchema.default({
    ignoredPresence: {},
    activeWorkerCount: 0,
    launchedWorkerCount: 0,
    failedLaunchCount: 0,
    uploadedWorkerCount: 0,
    unchangedWorkerCount: 0,
    droppedOrDeferredWorkerCount: 0,
    metadata: {},
  }),
  workers: z.array(researchPresenceWorkerSnapshotSchema).max(250),
})

export const researchPresenceIgnoredWorkerSchema = z.object({
  id: z.uuid(),
  reason: z.enum([
    "not_found",
    "session_mismatch",
    "stale_sequence",
    "unmatched_cap",
    "update_failed",
    "session_not_found",
  ]),
  message: z.string().trim().min(1),
})

export const upsertResearchPresenceResponseSchema = z.object({
  data: z.object({
    ignoredWorkers: z.array(researchPresenceIgnoredWorkerSchema).default([]),
    ignoredByReason: z.object({
      notFound: z.number().int().nonnegative(),
      sessionMismatch: z.number().int().nonnegative(),
      staleSequence: z.number().int().nonnegative(),
      unmatchedCap: z.number().int().nonnegative(),
      updateFailed: z.number().int().nonnegative(),
      sessionNotFound: z.number().int().nonnegative(),
    }),
    acceptedCount: z.number().int().nonnegative(),
    ignoredCount: z.number().int().nonnegative(),
    unmatchedCount: z.number().int().nonnegative(),
    uploadedWorkerCount: z.number().int().nonnegative().default(0),
    unchangedWorkerCount: z.number().int().nonnegative().default(0),
    droppedOrDeferredWorkerCount: z.number().int().nonnegative().default(0),
    deferredStartupTelemetryCount: z.number().int().nonnegative().default(0),
    splitCount: z.number().int().nonnegative().default(1),
    siteAccepted: z.boolean(),
  }),
})

export const stopResearchSessionRequestSchema = z.object({
  campaignId: z.uuid(),
  endReason: researchSessionEndReasonSchema
    .extract([
      "user_stopped",
      "provider_capacity_exhausted",
      "supervisor_failed",
      "failed",
    ])
    .default("user_stopped"),
  reason: z.string().trim().max(1000).optional(),
  metadata: metadataSchema.default({}),
})

export const scaleResearchSessionRequestSchema = z.object({
  campaignId: z.uuid(),
  workerTarget: z.number().int().min(1).max(500),
  actor: z.string().trim().min(1).max(160).optional(),
  siteId: z.uuid().optional(),
  metadata: metadataSchema.default({}),
})

export const researchSessionCapacityEventSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid(),
  previousTarget: z.number().int().min(1).max(500),
  newTarget: z.number().int().min(1).max(500),
  actor: z.string().nullable(),
  siteId: z.uuid().nullable(),
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
})

export const listResearchProjectsResponseSchema = z.object({
  data: z.array(researchProjectSchema),
})

export const resolveResearchProjectQuerySchema =
  researchRepositoryIdentitySchema

export const resolveResearchProjectResponseSchema = z.object({
  data: researchProjectSchema,
})

export const syncResearchProjectResponseSchema = z.object({
  data: researchProjectSchema,
})

export const createResearchCampaignResponseSchema = z.object({
  data: z.object({
    project: researchProjectSchema,
    campaign: researchCampaignSchema,
  }),
})

export const listResearchCampaignsResponseSchema = z.object({
  data: z.array(researchCampaignSchema),
})

export const createResearchCampaignExperimentResponseSchema = z.object({
  data: z.object({
    outcome: z
      .enum(["recorded", "duplicate"])
      .describe(
        "Delivery outcome. A newly recorded report normally has disposition received; workers must not wait for acceptance."
      ),
    experiment: researchCampaignExperimentSchema,
  }),
})

export const researchCampaignExperimentSummarySchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid(),
  evaluationRevisionId: z.uuid(),
  assignmentId: z.uuid(),
  hypothesisId: z.uuid(),
  workerId: z.uuid().nullable(),
  acceptedIndex: z.number().int().positive().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  runRef: z.string().min(1),
  resultCommitSha: z.string().min(1),
  resultRef: z.string().min(1),
  gitStatus: researchExperimentGitStatusSchema,
  gitVerifiedAt: z.iso.datetime().nullable(),
  gitStatusReason: z.string().nullable(),
  resultRefPushStatus: researchResultRefPushStatusSchema.nullable(),
  resultRefPushedAt: z.iso.datetime().nullable(),
  resultRefPushError: z.string().nullable(),
  status: researchExperimentStatusSchema,
  disposition: researchExperimentDispositionSchema,
  dispositionReason: z.string().nullable(),
  settledAt: z.iso.datetime().nullable(),
  primaryMetricName: z.string().min(1),
  primaryMetricValue: z.number().finite().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

const gitStatusCountSchema = z.number().int().nonnegative()

export const researchCampaignGitVerificationSummarySchema = z.object({
  repositoryAccessMode: researchRepositoryAccessModeSchema,
  baseGitStatus: researchExperimentGitStatusSchema,
  baseGitVerifiedAt: z.iso.datetime().nullable(),
  baseGitStatusReason: z.string().nullable(),
  acceptedExperimentGitStatusCounts: z.object({
    local_reported: gitStatusCountSchema,
    pending: gitStatusCountSchema,
    verified: gitStatusCountSchema,
    missing: gitStatusCountSchema,
    mismatch: gitStatusCountSchema,
    unreachable: gitStatusCountSchema,
  }),
  needsVerificationCount: z.number().int().nonnegative(),
  hardFailureCount: z.number().int().nonnegative(),
  lastVerifiedAt: z.iso.datetime().nullable(),
  recommendedAction: z.enum([
    "connect_github",
    "resolve_ref_mismatch",
    "push_refs",
    "verify_git",
    "retry_later",
    "none",
  ]),
  message: z.string().min(1),
})

const researchCampaignBaseGitVerificationResultSchema = z.object({
  checked: z.boolean(),
  updated: z.boolean(),
  previousStatus: researchExperimentGitStatusSchema.nullable(),
  status: researchExperimentGitStatusSchema,
  verifiedAt: z.iso.datetime().nullable(),
  statusReason: z.string().nullable(),
})

export const researchGitVerificationRateLimitSchema = z.object({
  limited: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
  limit: z.number().int().nonnegative().nullable(),
  resetAt: z.iso.datetime().nullable(),
})

const researchCampaignGitVerificationCountsSchema = z.object({
  checkedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  remainingCount: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  rateLimit: researchGitVerificationRateLimitSchema.nullable(),
  base: researchCampaignBaseGitVerificationResultSchema,
  summary: researchCampaignGitVerificationSummarySchema,
})

export const researchCampaignOverviewResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
    gitVerification: researchCampaignGitVerificationSummarySchema,
    bestExperiment: researchCampaignExperimentSummarySchema.nullable(),
    latestExperiments: z.array(researchCampaignExperimentSummarySchema),
    sessions: z.array(researchSessionSchema),
    workers: z.array(researchWorkerSchema),
    hypotheses: z.array(researchHypothesisSchema),
    knowledge: z.array(researchKnowledgeSchema),
    counts: z.object({
      experiments: z.number().int().nonnegative(),
      hypothesisCount: z.number().int().nonnegative(),
      activeWorkers: z.number().int().nonnegative(),
    }),
  }),
})

export const archiveResearchCampaignResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
  }),
})

export const researchCampaignTimelinePointSchema = z.object({
  experimentId: z.uuid(),
  displayIndex: z.number().int().positive(),
  name: z.string().min(1),
  primaryMetricValue: z.number().finite().nullable(),
  status: researchExperimentStatusSchema,
  gitStatus: researchExperimentGitStatusSchema,
  createdAt: z.iso.datetime(),
})

export const researchCampaignTimelineBestStepSchema = z.object({
  experimentId: z.uuid(),
  displayIndex: z.number().int().positive(),
  metricValue: z.number().finite(),
})

export const researchCampaignTimelineQuerySchema = z.object({
  evaluationRevisionId: z.uuid().optional(),
})

export const researchCampaignTimelineResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
    selectedEvaluationRevisionId: z.uuid().nullable(),
    gitVerification: researchCampaignGitVerificationSummarySchema,
    experiments: z.array(researchCampaignExperimentSummarySchema),
    points: z.array(researchCampaignTimelinePointSchema),
    bestSteps: z.array(researchCampaignTimelineBestStepSchema),
    defaultExperiment: researchCampaignExperimentSummarySchema.nullable(),
    total: z.number().int().nonnegative(),
    sampled: z.boolean(),
    window: z.object({
      maxPoints: z.number().int().positive(),
      startIndex: z.number().int().positive().nullable(),
      endIndex: z.number().int().positive().nullable(),
    }),
  }),
})

export const listResearchCampaignExperimentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
  sessionId: z.uuid().optional(),
  hypothesisId: z.uuid().optional(),
  workerId: z.uuid().optional(),
  resultCommitSha: z.string().trim().min(1).max(80).optional(),
  runRef: z.string().trim().min(1).max(500).optional(),
  status: researchExperimentStatusSchema.optional(),
  disposition: z.literal("accepted").default("accepted"),
  order: z.enum(["asc", "desc"]).default("desc"),
})

export const listResearchCampaignExperimentsResponseSchema = z.object({
  data: z.object({
    items: z.array(researchCampaignExperimentSchema),
    page: z.object({
      nextCursor: z.string().nullable(),
    }),
  }),
})

// Slim row for the team experiments table: only the displayed fields, so the
// query/response avoids reading and shipping the heavy experiment jsonb columns.
export const researchExperimentRowSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string().min(1),
  campaignName: z.string().min(1),
  hypothesisId: z.uuid().nullable(),
  hypothesisName: z.string().min(1).nullable(),
  hypothesisDescription: z.string().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  resultCommitSha: z.string().min(1),
  status: researchExperimentStatusSchema,
  gitStatus: researchExperimentGitStatusSchema,
  resultRefPushStatus: researchResultRefPushStatusSchema.nullable(),
  primaryMetricName: z.string().min(1),
  primaryMetricValue: z.number().finite().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.iso.datetime(),
})

// Multi-value query params are passed as comma-separated strings (the route
// query parser collapses repeated keys), so split + validate as an array.
function csvEnumQueryParam<T extends z.ZodTypeAny>(item: T) {
  return z
    .preprocess((value) => {
      if (typeof value !== "string") return value
      const parts = value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
      return parts.length > 0 ? parts : undefined
    }, z.array(item).optional())
    .optional()
}

const csvUuidQueryParam = () => csvEnumQueryParam(z.uuid())

export const researchExperimentSortFieldSchema = z.enum([
  "createdAt",
  "primaryMetricValue",
  "durationMs",
  "hypothesisName",
])

export const listResearchExperimentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().min(1).max(200).optional(),
  projectId: csvUuidQueryParam(),
  campaignId: csvUuidQueryParam(),
  hypothesisId: csvUuidQueryParam(),
  status: csvEnumQueryParam(researchExperimentStatusSchema),
  sortBy: researchExperimentSortFieldSchema.default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
})

export const listResearchExperimentsResponseSchema = z.object({
  data: z.object({
    items: z.array(researchExperimentRowSchema),
    // Echo only — the total/pageCount come from the facets endpoint so paging
    // and sorting don't re-run the count.
    page: z.object({
      page: z.number().int().positive(),
      pageSize: z.number().int().positive(),
    }),
  }),
})

// Filters-only query (no page/pageSize/sort) so the count + facet breakdowns
// are cached across pages and sort changes.
export const listResearchExperimentsFacetsQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  projectId: csvUuidQueryParam(),
  campaignId: csvUuidQueryParam(),
  hypothesisId: csvUuidQueryParam(),
  status: csvEnumQueryParam(researchExperimentStatusSchema),
})

export const researchExperimentsFacetsResponseSchema = z.object({
  data: z.object({
    total: z.number().int().nonnegative(),
    // Keyed by facet value; only present values are included.
    project: z.record(z.string(), z.number().int().nonnegative()),
    campaign: z.record(z.string(), z.number().int().nonnegative()),
    hypothesis: z.record(z.string(), z.number().int().nonnegative()),
    status: z.record(z.string(), z.number().int().nonnegative()),
  }),
})

export const createResearchKnowledgeResponseSchema = z.object({
  data: researchKnowledgeSchema,
})

export const listResearchKnowledgeResponseSchema = z.object({
  data: z.array(researchKnowledgeSchema),
})

export const researchMetricSeriesQuerySchema = z.object({
  evaluationRevisionId: z.uuid().optional(),
  mode: z.enum(["chart", "raw"]).default("chart"),
  maxPoints: z.coerce.number().int().min(10).max(5000).default(1000),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  order: z.enum(["asc", "desc"]).default("asc"),
})

export const researchMetricSeriesPointSchema = z.object({
  id: z.uuid(),
  runRef: z.string().min(1),
  name: z.string().min(1),
  evaluationRevisionId: z.uuid(),
  assignmentId: z.uuid(),
  hypothesisId: z.uuid(),
  baseCommitSha: z.string().min(1),
  createdAt: z.iso.datetime(),
  resultCommitSha: z.string().min(1),
  status: researchExperimentStatusSchema,
  gitStatus: researchExperimentGitStatusSchema,
  primaryMetricName: z.string().min(1),
  primaryMetricValue: z.number().finite().nullable(),
  isBest: z.boolean(),
})

export const researchMetricSeriesResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
    evaluationRevision: researchEvaluationRevisionSchema,
    points: z.array(researchMetricSeriesPointSchema),
    sampled: z.boolean(),
    total: z.number().int().nonnegative(),
    page: z.object({
      nextCursor: z.string().nullable(),
    }),
  }),
})

export const researchProjectGraphRecentExperimentSchema = z.object({
  id: z.uuid(),
  commitSha: z.string().min(1),
  name: z.string().min(1),
})

export const researchProjectGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["project", "campaign"]),
  label: z.string().min(1),
  description: z.string().nullable(),
  parentCampaignId: z.uuid().nullable(),
  baseCommitSha: z.string().nullable(),
  promotionRefName: z.string().nullable(),
  metricName: z.string().nullable(),
  metricUnit: z.string().nullable(),
  metricDirection: researchMetricDirectionSchema.nullable(),
  status: researchCampaignStatusSchema.nullable(),
  experimentCount: z.number().int().nonnegative(),
  activeExperimentCount: z.number().int().nonnegative(),
  recentExperiments: z.array(researchProjectGraphRecentExperimentSchema),
  latestExperimentAt: z.iso.datetime().nullable(),
  gitStatus: researchExperimentGitStatusSchema.nullable(),
  position: z.object({
    x: z.number(),
    y: z.number(),
  }),
})

export const researchProjectGraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
})

export const researchProjectGraphResponseSchema = z.object({
  data: z.object({
    project: researchProjectSchema,
    nodes: z.array(researchProjectGraphNodeSchema),
    edges: z.array(researchProjectGraphEdgeSchema),
  }),
})

export const researchProjectOutlineCampaignSchema =
  researchCampaignSchema.extend({
    latestExperiments: z.array(researchCampaignExperimentSummarySchema),
    hypothesisCount: z.number().int().nonnegative(),
    activeWorkerCount: z.number().int().nonnegative(),
  })

export const researchProjectTreeResponseSchema = z.object({
  data: z.object({
    project: researchProjectSchema,
    campaigns: z.array(researchProjectOutlineCampaignSchema),
  }),
})

export const researchSessionStateResponseSchema = z.object({
  data: z.object({
    session: researchSessionSchema,
    campaign: researchCampaignSchema,
    latestExperiments: z.array(researchCampaignExperimentSummarySchema),
    bestExperiment: researchCampaignExperimentSummarySchema.nullable(),
    hypotheses: z.array(researchHypothesisSchema),
    workers: z.array(researchWorkerSchema),
    knowledge: z.array(researchKnowledgeSchema),
    updatedAt: z.iso.datetime(),
  }),
})

export const researchSessionBriefResponseSchema = z.object({
  data: z.object({
    session: researchSessionSchema,
    campaign: researchCampaignSchema,
    project: researchProjectSchema,
    hypothesis: researchHypothesisSchema.nullable(),
    latestExperiments: z.array(researchCampaignExperimentSummarySchema),
    bestExperiment: researchCampaignExperimentSummarySchema.nullable(),
    activeHypotheses: z.array(researchHypothesisSchema),
    knowledge: z.array(researchKnowledgeSchema),
    updatedAt: z.iso.datetime(),
  }),
})

export const researchSessionBriefQuerySchema = z.object({
  hypothesisId: z.uuid().optional(),
})

export const researchSessionSiteSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid(),
  siteId: z.uuid(),
  supervisorRunId: z.string().min(1),
  status: z.enum(["active", "stale", "inactive"]),
  providerBackoff: metadataSchema.nullable(),
  ignoredPresence: metadataSchema,
  activeWorkerCount: z.number().int().nonnegative(),
  launchedWorkerCount: z.number().int().nonnegative().default(0),
  failedLaunchCount: z.number().int().nonnegative().default(0),
  uploadedWorkerCount: z.number().int().nonnegative().default(0),
  unchangedWorkerCount: z.number().int().nonnegative().default(0),
  droppedOrDeferredWorkerCount: z.number().int().nonnegative().default(0),
  lastUploadAt: z.iso.datetime().nullable(),
  lastSequence: z.number().int().nonnegative(),
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const researchLiveWorkerSummarySchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid().nullable(),
  hypothesisId: z.uuid().nullable(),
  workerName: z.string().min(1).nullable(),
  agentKind: z.string().min(1).nullable(),
  runtime: researchWorkerRuntimeSchema.nullable(),
  status: researchWorkerStatusSchema,
  liveness: researchWorkerLivenessSchema,
  phase: z.string().nullable(),
  progressMessage: z.string().nullable(),
  gitLabel: z.string().nullable(),
  currentExperimentId: z.uuid().nullable(),
  lastOutputAt: z.iso.datetime().nullable(),
  activitySummary: metadataSchema,
  observedAt: z.iso.datetime().nullable(),
  receivedAt: z.iso.datetime(),
  matched: z.boolean(),
})

export const researchSessionProgressSchema = z.object({
  experimentTarget: z.number().int().positive().nullable(),
  acceptedExperimentCount: z.number().int().nonnegative(),
  receivedExperimentCount: z.number().int().nonnegative().default(0),
  remainingExperimentCount: z.number().int().nonnegative().nullable(),
  deadlineAt: z.iso.datetime().nullable(),
  cutoffAt: z.iso.datetime().nullable().optional(),
  endedAt: z.iso.datetime().nullable(),
  endReason: researchSessionEndReasonSchema.nullable(),
  asOf: z.iso.datetime().optional(),
})

const researchSessionStateBriefSessionSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  runtimeState: researchSessionRuntimeStateSchema,
  status: z.enum(["running", "completed", "failed", "stopped"]),
  finalizationStatus: z.enum(["running", "complete", "incomplete", "failed"]),
  workerTarget: z.number().int().positive(),
  deadlineAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  endReason: researchSessionEndReasonSchema.nullable(),
})

const researchSessionStateBriefCampaignSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  status: researchCampaignStatusSchema,
  metricName: z.string().min(1),
  metricUnit: z.string().nullable(),
  metricDirection: researchMetricDirectionSchema,
})

const researchSessionStateBriefHypothesisSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  status: researchHypothesisStatusSchema,
  bestMetricValue: z.number().finite().nullable(),
  bestCommitSha: z.string().nullable(),
  experimentCount: z.number().int().nonnegative(),
  lastWorkedAt: z.iso.datetime().nullable(),
})

const researchSessionStateBriefExperimentSchema = z.object({
  id: z.uuid(),
  hypothesisId: z.uuid(),
  acceptedIndex: z.number().int().positive(),
  name: z.string().min(1),
  resultCommitSha: z.string().min(1),
  primaryMetricName: z.string().min(1),
  primaryMetricValue: z.number().finite().nullable(),
  createdAt: z.iso.datetime(),
})

const researchSessionStateBriefKnowledgeSchema = z.object({
  id: z.uuid(),
  hypothesisId: z.uuid().nullable(),
  experimentId: z.uuid().nullable(),
  kind: researchKnowledgeKindSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  createdAt: z.iso.datetime(),
})

export const researchSessionStateBriefResponseSchema = z.object({
  data: z.object({
    generatedAt: z.iso.datetime(),
    session: researchSessionStateBriefSessionSchema,
    campaign: researchSessionStateBriefCampaignSchema,
    progress: researchSessionProgressSchema,
    peerHypothesisCount: z.number().int().nonnegative(),
    peerHypotheses: z.array(researchSessionStateBriefHypothesisSchema).max(10),
    results: z.object({
      latest: z.array(researchSessionStateBriefExperimentSchema).max(10),
      best: researchSessionStateBriefExperimentSchema.nullable(),
    }),
    knowledge: z.object({
      items: z.array(researchSessionStateBriefKnowledgeSchema).max(3),
      hasMore: z.boolean(),
    }),
    updatedAt: z.iso.datetime(),
  }),
})

export const researchSessionLiveResponseSchema = z.object({
  data: z.object({
    session: researchSessionSchema,
    campaign: researchCampaignSchema,
    progress: z.object({
      ...researchSessionProgressSchema.shape,
      warning: z.string().nullable().optional(),
    }),
    livenessCounts: z.record(researchWorkerLivenessSchema, z.number().int()),
    phaseCounts: z.record(z.string(), z.number().int().nonnegative()),
    workers: z.array(researchLiveWorkerSummarySchema),
    sites: z.array(researchSessionSiteSchema),
    unmatchedPresenceCount: z.number().int().nonnegative(),
    ignoredPresence: metadataSchema,
    providerBackoff: metadataSchema.nullable(),
    recentExperiments: z.array(researchCampaignExperimentSummarySchema),
    recentTerminalWorkers: z.array(researchLiveWorkerSummarySchema),
    liveWatermark: z.string().min(1),
    updatedAt: z.iso.datetime(),
  }),
})

export const researchSessionControlStateResponseSchema = z.object({
  data: z.object({
    sessionId: z.uuid(),
    campaignStatus: researchCampaignStatusSchema,
    runtimeState: researchSessionRuntimeStateSchema,
    status: z.enum(["running", "completed", "failed", "stopped"]),
    finalizationStatus: z.enum(["running", "complete", "incomplete", "failed"]),
    progress: researchSessionProgressSchema,
    launch: z.object({
      activeWorkerCount: z.number().int().nonnegative(),
      workerTarget: z.number().int().positive(),
      openWorkerSlotCount: z.number().int().nonnegative(),
      activeHypothesisCount: z.number().int().nonnegative(),
      acceptingExperiments: z.boolean(),
    }),
    canceledAssignmentIds: z.array(z.uuid()),
    finalization: z.object({
      status: z.enum(["running", "complete", "incomplete", "failed"]),
      reasons: z.array(z.string()),
      terminalReason: researchSessionEndReasonSchema.nullable(),
    }),
    updatedAt: z.iso.datetime(),
  }),
})

export const createResearchSessionResponseSchema = z.object({
  data: z.object({
    session: researchSessionSchema,
    hypotheses: z.array(researchHypothesisSchema),
    evaluationRevision: researchEvaluationRevisionSchema,
    assignments: z.array(researchSessionHypothesisAssignmentSchema),
  }),
})

export const createResearchHypothesisResponseSchema = z.object({
  data: z.object({
    hypothesis: researchHypothesisSchema,
  }),
})

export const listResearchHypothesesResponseSchema = z.object({
  data: z.array(researchHypothesisSchema),
})

export const updateResearchHypothesisResponseSchema = z.object({
  data: z.object({
    hypothesis: researchHypothesisSchema,
  }),
})

export const closeResearchHypothesisResponseSchema = z.object({
  data: z.object({
    hypothesis: researchHypothesisSchema,
    canceledAssignmentIds: z.array(z.uuid()),
    endedSessionIds: z.array(z.uuid()),
    stoppedWorkerIds: z.array(z.uuid()),
  }),
})

export const closeResearchHypothesisRequestSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
})

export const stopResearchSessionResponseSchema = z.object({
  data: researchSessionSchema,
})

export const scaleResearchSessionResponseSchema = z.object({
  data: z.object({
    session: researchSessionSchema,
    event: researchSessionCapacityEventSchema,
  }),
})

export const listResearchEvaluationRevisionsResponseSchema = z.object({
  data: z.array(researchEvaluationRevisionSchema),
})

export const getResearchEvaluationRevisionResponseSchema = z.object({
  data: researchEvaluationRevisionSchema,
})

export const acquireResearchWorkerLeaseResponseSchema = z.object({
  data: z.object({
    worker: researchWorkerSchema,
    leaseToken: z.string().min(16),
    leaseExpiresAt: z.iso.datetime(),
    assignment: researchSessionHypothesisAssignmentSchema,
    hypothesis: researchHypothesisSchema,
    session: researchSessionSchema.pick({
      id: true,
      campaignId: true,
      name: true,
      evaluationRevisionId: true,
      baseCommitSha: true,
      setupHash: true,
      workerTarget: true,
      experimentTarget: true,
      acceptedExperimentCount: true,
      remainingExperimentCount: true,
      deadlineAt: true,
      endedAt: true,
      endReason: true,
    }),
    campaign: researchCampaignSchema.pick({
      id: true,
      projectId: true,
      name: true,
      description: true,
      currentEvaluationRevisionId: true,
      status: true,
      metricName: true,
      metricUnit: true,
      metricDirection: true,
    }),
    project: researchProjectSchema.pick({
      id: true,
      name: true,
      repositoryUrl: true,
      repositoryAccessMode: true,
      repositoryFullName: true,
      defaultBranch: true,
      projectPath: true,
    }),
  }),
})

const researchWorkerLeaseContextSchema = z.object({
  session: acquireResearchWorkerLeaseResponseSchema.shape.data.shape.session,
  campaign: acquireResearchWorkerLeaseResponseSchema.shape.data.shape.campaign,
  project: acquireResearchWorkerLeaseResponseSchema.shape.data.shape.project,
})

export const acquireResearchWorkerLeaseBatchResponseSchema = z.object({
  data: z.object({
    context: researchWorkerLeaseContextSchema,
    grants: z.array(
      z.object({
        workerRef: z.string().min(1),
        worker: researchWorkerSchema,
        leaseToken: z.string().min(16),
        leaseExpiresAt: z.iso.datetime(),
        assignment: researchSessionHypothesisAssignmentSchema,
        hypothesis: researchHypothesisSchema,
        existing: z.boolean().default(false),
      })
    ),
    unavailable: z.array(
      z.object({
        workerRef: z.string().min(1),
        workerName: z.string().min(1),
        code: z.enum([
          "no_worker_slots",
          "settlement_pending",
          "worker_ref_terminal",
        ]),
        message: z.string().min(1),
      })
    ),
    capacity: z.object({
      workerTarget: z.number().int().nonnegative(),
      occupied: z.number().int().nonnegative(),
      requested: z.number().int().nonnegative(),
      granted: z.number().int().nonnegative(),
      existing: z.number().int().nonnegative(),
      openSlots: z.number().int().nonnegative(),
    }),
  }),
})

export const researchWorkerHeartbeatResponseSchema = z.object({
  data: z.object({
    worker: researchWorkerSchema,
    heartbeat: researchWorkerHeartbeatSchema,
  }),
})

export const researchWorkerHeartbeatBatchResponseSchema = z.object({
  data: z.object({
    results: z.array(
      z.object({
        workerId: z.uuid(),
        ok: z.boolean(),
        worker: researchWorkerSchema.optional(),
        heartbeat: researchWorkerHeartbeatSchema.optional(),
        error: z
          .object({
            code: z.string().min(1),
            message: z.string().min(1),
          })
          .optional(),
      })
    ),
  }),
})

export const researchFileTreeNodeSchema = z.object({
  id: z.string().min(1),
  path: z.string(),
  name: z.string().min(1),
  type: z.enum(["file", "directory"]),
  isProtected: z.boolean(),
  byteSize: z.number().int().nonnegative(),
  language: z.string().nullable(),
  children: z.array(z.string()),
})

export const researchCampaignExperimentFileQuerySchema = z.object({
  path: z.string().min(1),
})

export const researchCampaignExperimentDiffQuerySchema = z.object({
  baseExperimentId: z.uuid().optional(),
})

export const researchDiffFileSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "removed", "modified", "renamed", "unchanged"]),
  oldPath: z.string().nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(
    z.object({
      oldStart: z.number().int().nonnegative(),
      newStart: z.number().int().nonnegative(),
      lines: z.array(
        z.object({
          type: z.enum(["context", "add", "delete"]),
          oldLine: z.number().int().positive().nullable(),
          newLine: z.number().int().positive().nullable(),
          content: z.string(),
        })
      ),
    })
  ),
})

export const researchCodeAccessSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  reason: z
    .enum([
      "github_connection_required",
      "commit_not_visible",
      "base_commit_not_visible",
      "code_read_failed",
    ])
    .nullable()
    .default(null),
  message: z.string().nullable().default(null),
})

export const researchCampaignFileTreeResponseSchema = z.object({
  data: z.object({
    experiment: researchCampaignExperimentSchema,
    commitSha: gitShaSchema,
    codeAccess: researchCodeAccessSchema,
    files: z.array(researchFileTreeNodeSchema),
  }),
})

export const researchCampaignFileBlobResponseSchema = z.object({
  data: z.object({
    experiment: researchCampaignExperimentSchema,
    commitSha: gitShaSchema,
    path: z.string().min(1),
    content: z.string().nullable(),
    byteSize: z.number().int().nonnegative(),
    language: z.string().nullable(),
    isProtected: z.boolean(),
    isTruncated: z.boolean(),
    codeAccess: researchCodeAccessSchema,
  }),
})

export const researchCampaignDiffResponseSchema = z.object({
  data: z.object({
    baseExperiment: researchCampaignExperimentSchema.nullable(),
    baseCommitSha: gitShaSchema,
    compareExperiment: researchCampaignExperimentSchema,
    codeAccess: researchCodeAccessSchema,
    files: z.array(researchDiffFileSchema),
  }),
})

export const researchCampaignExperimentCodeResponseSchema = z.object({
  data: z.object({
    experiment: researchCampaignExperimentSchema,
    baseExperiment: researchCampaignExperimentSchema.nullable(),
    baseCommitSha: gitShaSchema,
    commitSha: gitShaSchema,
    codeAccess: researchCodeAccessSchema,
    files: z.array(researchFileTreeNodeSchema),
    diffFiles: z.array(researchDiffFileSchema),
  }),
})

export const researchCampaignGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["campaign", "experiment", "hypothesis", "worker"]),
  label: z.string().min(1),
  status: z.string().nullable(),
  metricValue: z.number().finite().nullable(),
  gitStatus: researchExperimentGitStatusSchema.nullable(),
  ref: z.string().nullable(),
  metadata: metadataSchema,
  position: z.object({
    x: z.number(),
    y: z.number(),
  }),
})

export const researchCampaignGraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1),
  label: z.string().nullable(),
  metadata: metadataSchema,
})

export const researchCampaignGraphQuerySchema = z.object({
  // Bounded window over the campaign's most recent accepted experiments; the
  // graph is a review surface, not a full-history browser.
  maxNodes: z.coerce.number().int().min(10).max(2000).default(500),
})

export const researchCampaignGraphResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
    nodes: z.array(researchCampaignGraphNodeSchema),
    edges: z.array(researchCampaignGraphEdgeSchema),
    window: z.object({
      maxNodes: z.number().int().positive(),
      totalExperiments: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
  }),
})

export const verifyResearchCampaignGitQuerySchema = z.object({
  gitVerifyLimit: z.coerce.number().int().min(1).max(500).default(100),
})

export const verifyResearchCampaignGitResponseSchema = z.object({
  data: researchCampaignGitVerificationCountsSchema,
})

export const deleteResearchCampaignResponseSchema = z.object({
  data: z.object({
    campaignId: z.uuid(),
    projectId: z.uuid(),
    deleted: z.literal(true),
    alreadyDeleted: z.boolean(),
    deletedExperimentCount: z.number().int().nonnegative(),
  }),
})

export const deleteResearchCampaignExperimentResponseSchema = z.object({
  data: z.object({
    experimentId: z.uuid(),
    campaignId: z.uuid(),
    projectId: z.uuid(),
    deleted: z.literal(true),
    alreadyDeleted: z.boolean(),
    campaign: researchCampaignSchema.nullable(),
  }),
})

export type ResearchMetricDirection = z.infer<
  typeof researchMetricDirectionSchema
>
export type ResearchExperimentStatus = z.infer<
  typeof researchExperimentStatusSchema
>
export type ResearchExperimentDisposition = z.infer<
  typeof researchExperimentDispositionSchema
>
export type ResearchProjectProvider = z.infer<
  typeof researchProjectProviderSchema
>
export type ResearchRepositoryAccessMode = z.infer<
  typeof researchRepositoryAccessModeSchema
>
export type ResearchRepositorySyncStatus = z.infer<
  typeof researchRepositorySyncStatusSchema
>
export type ResearchProject = z.infer<typeof researchProjectSchema>
export type SyncResearchProjectResponse = z.infer<
  typeof syncResearchProjectResponseSchema
>
export type ListResearchProjectsResponse = z.infer<
  typeof listResearchProjectsResponseSchema
>
export type ResolveResearchProjectQuery = z.infer<
  typeof resolveResearchProjectQuerySchema
>
export type ResolveResearchProjectResponse = z.infer<
  typeof resolveResearchProjectResponseSchema
>
export type ResearchCampaignStatus = z.infer<
  typeof researchCampaignStatusSchema
>
export type ResearchHypothesisStatus = z.infer<
  typeof researchHypothesisStatusSchema
>
export type ResearchWorkerRuntime = z.infer<typeof researchWorkerRuntimeSchema>
export type ResearchWorkerStatus = z.infer<typeof researchWorkerStatusSchema>
export type ResearchExperimentGitStatus = z.infer<
  typeof researchExperimentGitStatusSchema
>
export type ResearchResultRefPushStatus = z.infer<
  typeof researchResultRefPushStatusSchema
>
export type ResearchExperimentLinkType = z.infer<
  typeof researchExperimentLinkTypeSchema
>
export type ResearchKnowledgeKind = z.infer<typeof researchKnowledgeKindSchema>
export type ResearchSetupId = z.infer<typeof researchSetupIdSchema>
export type ResearchSetupTool = z.infer<typeof researchSetupToolSchema>
export type ResearchSetupWorkflowStep = z.infer<
  typeof researchSetupWorkflowStepSchema
>
export type ResearchSetupFile = z.infer<typeof researchSetupFileSchema>
export type ResearchSetupValidationCheck = z.infer<
  typeof researchSetupValidationCheckSchema
>
export type ResearchSetupValidationFile = z.infer<
  typeof researchSetupValidationFileSchema
>
export type ResearchHypothesisPlan = z.infer<
  typeof researchHypothesisPlanSchema
>
export type ResearchCampaign = z.infer<typeof researchCampaignSchema>
export type CreateResearchCampaignRequest = z.infer<
  typeof createResearchCampaignRequestSchema
>
export type CreateResearchCampaignResponse = z.infer<
  typeof createResearchCampaignResponseSchema
>
export type ListResearchCampaignsResponse = z.infer<
  typeof listResearchCampaignsResponseSchema
>
export type ResearchCampaignExperiment = z.infer<
  typeof researchCampaignExperimentSchema
>
export type ResearchSetupCompliance = z.infer<
  typeof researchSetupComplianceSchema
>
export type ResearchCampaignExperimentSummary = z.infer<
  typeof researchCampaignExperimentSummarySchema
>
export type ResearchCampaignGitVerificationSummary = z.infer<
  typeof researchCampaignGitVerificationSummarySchema
>
export type ResearchExperimentLink = z.infer<
  typeof researchExperimentLinkSchema
>
export type CreateResearchCampaignExperimentRequest = z.infer<
  typeof createResearchCampaignExperimentRequestSchema
>
export type CreateResearchCampaignExperimentResponse = z.infer<
  typeof createResearchCampaignExperimentResponseSchema
>
export type BatchResearchCampaignExperimentRequest = z.infer<
  typeof batchResearchCampaignExperimentRequestSchema
>
export type BatchResearchCampaignExperimentResponse = z.infer<
  typeof batchResearchCampaignExperimentResponseSchema
>
export type ResearchCampaignOverviewResponse = z.infer<
  typeof researchCampaignOverviewResponseSchema
>
export type ArchiveResearchCampaignResponse = z.infer<
  typeof archiveResearchCampaignResponseSchema
>
export type ResearchCampaignTimelinePoint = z.infer<
  typeof researchCampaignTimelinePointSchema
>
export type ResearchCampaignTimelineBestStep = z.infer<
  typeof researchCampaignTimelineBestStepSchema
>
export type ResearchCampaignTimelineResponse = z.infer<
  typeof researchCampaignTimelineResponseSchema
>
export type ResearchCampaignTimelineQuery = z.infer<
  typeof researchCampaignTimelineQuerySchema
>
export type ListResearchCampaignExperimentsQuery = z.infer<
  typeof listResearchCampaignExperimentsQuerySchema
>
export type ListResearchCampaignExperimentsResponse = z.infer<
  typeof listResearchCampaignExperimentsResponseSchema
>
export type ResearchExperimentRow = z.infer<typeof researchExperimentRowSchema>
export type ResearchExperimentSortField = z.infer<
  typeof researchExperimentSortFieldSchema
>
export type ListResearchExperimentsQuery = z.infer<
  typeof listResearchExperimentsQuerySchema
>
export type ListResearchExperimentsResponse = z.infer<
  typeof listResearchExperimentsResponseSchema
>
export type ListResearchExperimentsFacetsQuery = z.infer<
  typeof listResearchExperimentsFacetsQuerySchema
>
export type ResearchExperimentsFacetsResponse = z.infer<
  typeof researchExperimentsFacetsResponseSchema
>
export type ResearchMetricSeriesQuery = z.infer<
  typeof researchMetricSeriesQuerySchema
>
export type ResearchMetricSeriesPoint = z.infer<
  typeof researchMetricSeriesPointSchema
>
export type ResearchMetricSeriesResponse = z.infer<
  typeof researchMetricSeriesResponseSchema
>
export type ResearchProjectOutlineCampaign = z.infer<
  typeof researchProjectOutlineCampaignSchema
>
export type ResearchProjectTreeResponse = z.infer<
  typeof researchProjectTreeResponseSchema
>
export type ResearchProjectGraphResponse = z.infer<
  typeof researchProjectGraphResponseSchema
>
export type ResearchSession = z.infer<typeof researchSessionSchema>
export type ResearchSessionRuntimeState = z.infer<
  typeof researchSessionRuntimeStateSchema
>
export type ResearchSessionEndReason = z.infer<
  typeof researchSessionEndReasonSchema
>
export type ResearchStopReasonCode = z.infer<
  typeof researchStopReasonCodeSchema
>
export type CreateResearchSessionRequest = z.infer<
  typeof createResearchSessionRequestSchema
>
export type CreateResearchSessionResponse = z.infer<
  typeof createResearchSessionResponseSchema
>
export type CreateResearchHypothesisRequest = z.infer<
  typeof createResearchHypothesisRequestSchema
>
export type CreateResearchHypothesisResponse = z.infer<
  typeof createResearchHypothesisResponseSchema
>
export type ListResearchHypothesesResponse = z.infer<
  typeof listResearchHypothesesResponseSchema
>
export type UpdateResearchHypothesisRequest = z.infer<
  typeof updateResearchHypothesisRequestSchema
>
export type UpdateResearchHypothesisResponse = z.infer<
  typeof updateResearchHypothesisResponseSchema
>
export type CloseResearchHypothesisResponse = z.infer<
  typeof closeResearchHypothesisResponseSchema
>
export type ResearchSessionStateResponse = z.infer<
  typeof researchSessionStateResponseSchema
>
export type ResearchSessionBriefResponse = z.infer<
  typeof researchSessionBriefResponseSchema
>
export type ResearchSessionBriefQuery = z.infer<
  typeof researchSessionBriefQuerySchema
>
export type ResearchSessionStateBriefResponse = z.infer<
  typeof researchSessionStateBriefResponseSchema
>
export type StopResearchSessionRequest = z.infer<
  typeof stopResearchSessionRequestSchema
>
export type StopResearchSessionResponse = z.infer<
  typeof stopResearchSessionResponseSchema
>
export type ScaleResearchSessionRequest = z.infer<
  typeof scaleResearchSessionRequestSchema
>
export type ScaleResearchSessionResponse = z.infer<
  typeof scaleResearchSessionResponseSchema
>
export type ResearchSessionCapacityEvent = z.infer<
  typeof researchSessionCapacityEventSchema
>
export type ResearchSessionHypothesisAssignment = z.infer<
  typeof researchSessionHypothesisAssignmentSchema
>
export type ResearchEvaluationManifest = z.infer<
  typeof researchEvaluationManifestSchema
>
export type ResearchEvaluationRevision = z.infer<
  typeof researchEvaluationRevisionSchema
>
export type ListResearchEvaluationRevisionsResponse = z.infer<
  typeof listResearchEvaluationRevisionsResponseSchema
>
export type GetResearchEvaluationRevisionResponse = z.infer<
  typeof getResearchEvaluationRevisionResponseSchema
>
export type ResearchHypothesis = z.infer<typeof researchHypothesisSchema>
export type ResearchKnowledge = z.infer<typeof researchKnowledgeSchema>
export type CreateResearchKnowledgeRequest = z.infer<
  typeof createResearchKnowledgeRequestSchema
>
export type CreateResearchKnowledgeResponse = z.infer<
  typeof createResearchKnowledgeResponseSchema
>
export type ListResearchKnowledgeResponse = z.infer<
  typeof listResearchKnowledgeResponseSchema
>
export type ResearchWorker = z.infer<typeof researchWorkerSchema>
export type AcquireResearchWorkerLeaseRequest = z.infer<
  typeof acquireResearchWorkerLeaseRequestSchema
>
export type AcquireResearchWorkerLeaseResponse = z.infer<
  typeof acquireResearchWorkerLeaseResponseSchema
>
export type AcquireResearchWorkerLeaseBatchRequest = z.infer<
  typeof acquireResearchWorkerLeaseBatchRequestSchema
>
export type AcquireResearchWorkerLeaseBatchResponse = z.infer<
  typeof acquireResearchWorkerLeaseBatchResponseSchema
>
export type ResearchWorkerHeartbeat = z.infer<
  typeof researchWorkerHeartbeatSchema
>
export type ResearchWorkerHeartbeatRequest = z.infer<
  typeof researchWorkerHeartbeatRequestSchema
>
export type ResearchWorkerHeartbeatResponse = z.infer<
  typeof researchWorkerHeartbeatResponseSchema
>
export type ResearchWorkerHeartbeatBatchRequest = z.infer<
  typeof researchWorkerHeartbeatBatchRequestSchema
>
export type ResearchWorkerHeartbeatBatchResponse = z.infer<
  typeof researchWorkerHeartbeatBatchResponseSchema
>
export type ResearchWorkerLiveness = z.infer<
  typeof researchWorkerLivenessSchema
>
export type ResearchPresenceWorkerSnapshot = z.infer<
  typeof researchPresenceWorkerSnapshotSchema
>
export type ResearchPresenceIgnoredWorker = z.infer<
  typeof researchPresenceIgnoredWorkerSchema
>
export type UpsertResearchPresenceRequest = z.infer<
  typeof upsertResearchPresenceRequestSchema
>
export type UpsertResearchPresenceResponse = z.infer<
  typeof upsertResearchPresenceResponseSchema
>
export type ResearchSessionSite = z.infer<typeof researchSessionSiteSchema>
export type ResearchLiveWorkerSummary = z.infer<
  typeof researchLiveWorkerSummarySchema
>
export type ResearchSessionProgress = z.infer<
  typeof researchSessionProgressSchema
>
export type ResearchSessionLiveResponse = z.infer<
  typeof researchSessionLiveResponseSchema
>
export type ResearchSessionControlStateResponse = z.infer<
  typeof researchSessionControlStateResponseSchema
>
export type ResearchCodeAccess = z.infer<typeof researchCodeAccessSchema>
export type ResearchCampaignFileTreeResponse = z.infer<
  typeof researchCampaignFileTreeResponseSchema
>
export type ResearchCampaignFileBlobResponse = z.infer<
  typeof researchCampaignFileBlobResponseSchema
>
export type ResearchCampaignDiffResponse = z.infer<
  typeof researchCampaignDiffResponseSchema
>
export type ResearchCampaignExperimentCodeResponse = z.infer<
  typeof researchCampaignExperimentCodeResponseSchema
>
export type ResearchCampaignGraphResponse = z.infer<
  typeof researchCampaignGraphResponseSchema
>
export type VerifyResearchCampaignGitQuery = z.infer<
  typeof verifyResearchCampaignGitQuerySchema
>
export type VerifyResearchCampaignGitResponse = z.infer<
  typeof verifyResearchCampaignGitResponseSchema
>
export type DeleteResearchCampaignResponse = z.infer<
  typeof deleteResearchCampaignResponseSchema
>
export type DeleteResearchCampaignExperimentResponse = z.infer<
  typeof deleteResearchCampaignExperimentResponseSchema
>

export const researchProjectUpsertedEventSchema = z.object({
  type: z.literal("research.project.upserted"),
  data: z.object({
    project: researchProjectSchema,
  }),
})

export const researchCampaignUpsertedEventSchema = z.object({
  type: z.literal("research.campaign.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaign: researchCampaignSchema,
  }),
})

export const researchCampaignDeletedEventSchema = z.object({
  type: z.literal("research.campaign.deleted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    campaignName: z.string().min(1),
  }),
})

export const researchCampaignExperimentUpsertedEventSchema = z.object({
  type: z.literal("research.experiment.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    experiment: researchCampaignExperimentSchema,
  }),
})

export const researchCampaignExperimentDeletedEventSchema = z.object({
  type: z.literal("research.experiment.deleted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    experimentId: z.uuid(),
    runRef: z.string().min(1),
    campaign: researchCampaignSchema,
  }),
})

export const researchHypothesisUpsertedEventSchema = z.object({
  type: z.literal("research.hypothesis.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    hypothesis: researchHypothesisSchema,
  }),
})

export const researchKnowledgeUpsertedEventSchema = z.object({
  type: z.literal("research.knowledge.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    knowledge: researchKnowledgeSchema,
  }),
})

export const researchWorkerUpsertedEventSchema = z.object({
  type: z.literal("research.worker.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    worker: researchWorkerSchema,
  }),
})

// Coalesced form for batch paths (supervisor heartbeat batches): one message
// per campaign per batch instead of one per worker, so a 100-worker session
// fans out ~2 events/min to each browser instead of ~400.
export const researchWorkersUpsertedEventSchema = z.object({
  type: z.literal("research.workers.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    workers: z.array(researchWorkerSchema).min(1),
  }),
})

export const researchSessionUpsertedEventSchema = z.object({
  type: z.literal("research.session.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    session: researchSessionSchema,
  }),
})

export const researchSessionProgressInvalidatedEventSchema = z.object({
  type: z.literal("research.session.progress.invalidated"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    sessionId: z.uuid(),
    asOf: z.iso.datetime(),
  }),
})

export const researchSessionLiveChangedEventSchema = z.object({
  type: z.literal("research.session.live.changed"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    sessionId: z.uuid(),
    batchId: z.string().min(1),
    liveWatermark: z.string().min(1),
    changedCount: z.number().int().nonnegative(),
    unmatchedCount: z.number().int().nonnegative(),
    receivedAt: z.iso.datetime(),
  }),
})

export const researchEventSchema = z.discriminatedUnion("type", [
  researchProjectUpsertedEventSchema,
  researchCampaignUpsertedEventSchema,
  researchCampaignDeletedEventSchema,
  researchCampaignExperimentUpsertedEventSchema,
  researchCampaignExperimentDeletedEventSchema,
  researchHypothesisUpsertedEventSchema,
  researchKnowledgeUpsertedEventSchema,
  researchWorkerUpsertedEventSchema,
  researchWorkersUpsertedEventSchema,
  researchSessionUpsertedEventSchema,
  researchSessionProgressInvalidatedEventSchema,
  researchSessionLiveChangedEventSchema,
])

export type ResearchProjectUpsertedEvent = z.infer<
  typeof researchProjectUpsertedEventSchema
>
export type ResearchCampaignUpsertedEvent = z.infer<
  typeof researchCampaignUpsertedEventSchema
>
export type ResearchCampaignDeletedEvent = z.infer<
  typeof researchCampaignDeletedEventSchema
>
export type ResearchCampaignExperimentUpsertedEvent = z.infer<
  typeof researchCampaignExperimentUpsertedEventSchema
>
export type ResearchCampaignExperimentDeletedEvent = z.infer<
  typeof researchCampaignExperimentDeletedEventSchema
>
export type ResearchHypothesisUpsertedEvent = z.infer<
  typeof researchHypothesisUpsertedEventSchema
>
export type ResearchKnowledgeUpsertedEvent = z.infer<
  typeof researchKnowledgeUpsertedEventSchema
>
export type ResearchWorkerUpsertedEvent = z.infer<
  typeof researchWorkerUpsertedEventSchema
>
export type ResearchWorkersUpsertedEvent = z.infer<
  typeof researchWorkersUpsertedEventSchema
>
export type ResearchSessionUpsertedEvent = z.infer<
  typeof researchSessionUpsertedEventSchema
>
export type ResearchSessionProgressInvalidatedEvent = z.infer<
  typeof researchSessionProgressInvalidatedEventSchema
>
export type ResearchSessionLiveChangedEvent = z.infer<
  typeof researchSessionLiveChangedEventSchema
>
export type ResearchEvent = z.infer<typeof researchEventSchema>
