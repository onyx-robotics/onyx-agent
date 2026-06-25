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
  "accepted",
  "rejected",
])
export const researchProjectProviderSchema = z.literal("github")
export const researchRepositorySyncStatusSchema = z.enum([
  "not_synced",
  "syncing",
  "synced",
  "failed",
])
export const researchCampaignStatusSchema = z.enum([
  "active",
  "completed",
  "archived",
])
export const researchHypothesisStatusSchema = z.enum([
  "active",
  "paused",
  "retired",
])
export const researchSessionStatusSchema = z.enum([
  "running",
  "stop_requested",
  "completed",
  "failed",
  "stopped",
])
export const researchSummaryKindSchema = z.enum([
  "campaign_brief",
  "session_brief",
  "hypothesis_summary",
  "transfer_brief",
  "setup_notes",
])
export const researchWorkerRuntimeSchema = z.enum(["local", "hosted"])
export const researchWorkerStatusSchema = z.enum([
  "idle",
  "running",
  "stale",
  "lost",
  "completed",
  "failed",
  "stopped",
])
export const researchExperimentGitStatusSchema = z.enum([
  "pending",
  "verified",
  "missing",
  "mismatch",
  "unreachable",
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
    schemaVersion: z.literal(1).default(1),
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

export const researchProjectSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  name: z.string().min(1),
  repositoryUrl: z.url(),
  repositoryOwner: z.string().min(1),
  repositoryName: z.string().min(1),
  repositoryProvider: researchProjectProviderSchema,
  githubInstallationId: z.string().min(1),
  githubRepositoryId: z.string().min(1),
  repositoryFullName: z.string().min(1),
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
    repositoryUrl: z.url().optional(),
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
  baseCommitSha: z.string().min(1),
  status: researchCampaignStatusSchema,
  metricName: z.string().min(1),
  metricUnit: z.string().nullable(),
  metricDirection: researchMetricDirectionSchema,
  bestExperimentId: z.uuid().nullable(),
  bestMetricValue: z.number().finite().nullable(),
  bestCommitSha: z.string().nullable(),
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
    baseCommitSha: gitShaSchema.optional(),
    setup: researchSetupFileSchema,
    humanFeedback: z.string().trim().max(4000).optional(),
    promotionRefName: gitRefSchema.optional(),
  })

export const researchCampaignExperimentSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid().nullable(),
  hypothesisId: z.uuid().nullable(),
  workerId: z.uuid().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  runRef: z.string().min(1),
  baseCommitSha: z.string().min(1),
  resultCommitSha: z.string().min(1),
  resultRef: z.string().min(1),
  gitStatus: researchExperimentGitStatusSchema,
  gitVerifiedAt: z.iso.datetime().nullable(),
  gitStatusReason: z.string().nullable(),
  status: researchExperimentStatusSchema,
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
    sessionId: z.uuid().optional(),
    hypothesisId: z.uuid().optional(),
    workerId: z.uuid().optional(),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).optional(),
    runRef: z.string().trim().min(1).max(240),
    baseCommitSha: gitShaSchema,
    resultCommitSha: gitShaSchema,
    resultRef: gitRefSchema,
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
  .refine(
    (value) =>
      !(value.sessionId || value.workerId) || Boolean(value.hypothesisId),
    {
      path: ["hypothesisId"],
      error: "hypothesisId is required for worker or session experiments",
    }
  )

export const batchResearchCampaignExperimentRequestSchema = z.object({
  experiments: z
    .array(createResearchCampaignExperimentRequestSchema)
    .min(1)
    .max(100),
})

export const batchResearchCampaignExperimentResultStatusSchema = z.enum([
  "created",
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

export const researchSessionSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  name: z.string().min(1),
  status: researchSessionStatusSchema,
  workerTarget: z.number().int().positive().nullable(),
  metadata: metadataSchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const createResearchSessionRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  workerTarget: z.number().int().positive().max(500).optional(),
  hypotheses: z.array(researchHypothesisPlanSchema).max(500).optional(),
  metadata: metadataSchema.default({}),
})

export const createResearchHypothesisRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  plan: researchHypothesisPlanSchema,
  baseCommitSha: gitShaSchema.optional(),
  metadata: metadataSchema.default({}),
})

export const updateResearchHypothesisRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: researchHypothesisStatusSchema.optional(),
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
  baseCommitSha: z.string().min(1),
  bestExperimentId: z.uuid().nullable(),
  bestMetricValue: z.number().finite().nullable(),
  lastWorkedAt: z.iso.datetime().nullable(),
  plan: researchHypothesisPlanSchema,
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const researchSummarySchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid().nullable(),
  hypothesisId: z.uuid().nullable(),
  authoredByWorkerId: z.uuid().nullable(),
  summaryKind: researchSummaryKindSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  isCurrent: z.boolean(),
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

export const upsertResearchSummaryRequestSchema = z.object({
  sessionId: z.uuid().optional(),
  hypothesisId: z.uuid().optional(),
  authoredByWorkerId: z.uuid().optional(),
  summaryKind: researchSummaryKindSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  isCurrent: z.boolean().default(true),
  metadata: metadataSchema.default({}),
})

export const researchWorkerSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid().nullable(),
  hypothesisId: z.uuid(),
  workerName: z.string().min(1),
  agentKind: z.string().min(1),
  runtime: researchWorkerRuntimeSchema,
  status: researchWorkerStatusSchema,
  startedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  currentExperimentId: z.uuid().nullable(),
  phase: z.string().nullable(),
  progressMessage: z.string().nullable(),
  gitLabel: z.string().nullable(),
  metadata: metadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const registerResearchWorkerRequestSchema = z.object({
  sessionId: z.uuid().optional(),
  hypothesisId: z.uuid(),
  workerName: z.string().trim().min(1).max(160),
  agentKind: z.string().trim().min(1).max(80).default("codex"),
  runtime: researchWorkerRuntimeSchema.default("local"),
  metadata: metadataSchema.default({}),
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

export const researchWorkerHeartbeatRequestSchema = z.object({
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

export const researchPresenceWorkerSnapshotSchema = z.object({
  id: z.uuid(),
  status: researchWorkerStatusSchema.default("running"),
  phase: z.string().trim().max(120).nullable().optional(),
  progressMessage: z.string().trim().max(1000).nullable().optional(),
  gitLabel: z.string().trim().max(240).nullable().optional(),
  lastOutputAt: z.iso.datetime().nullable().optional(),
  metadata: metadataSchema.default({}),
  observedAt: z.iso.datetime(),
})

export const syncResearchPresenceRequestSchema = z.object({
  siteId: z.uuid(),
  repositoryUrl: z.string().trim().min(1).max(2000),
  projectPath: projectPathSchema.default(""),
  sessionId: z.uuid(),
  workers: z.array(researchPresenceWorkerSnapshotSchema).min(1).max(500),
})

export const researchPresenceIgnoredWorkerSchema = z.object({
  id: z.uuid(),
  reason: z.enum([
    "not_found",
    "project_mismatch",
    "session_mismatch",
    "update_failed",
  ]),
  message: z.string().trim().min(1),
})

export const syncResearchPresenceResponseSchema = z.object({
  data: z.object({
    workers: z.array(researchWorkerSchema),
    ignoredWorkers: z.array(researchPresenceIgnoredWorkerSchema).default([]),
    ignoredByReason: z.object({
      notFound: z.number().int().nonnegative(),
      projectMismatch: z.number().int().nonnegative(),
      sessionMismatch: z.number().int().nonnegative(),
      updateFailed: z.number().int().nonnegative(),
    }),
    updatedCount: z.number().int().nonnegative(),
    ignoredCount: z.number().int().nonnegative(),
  }),
})

export const researchSyncEventTypeSchema = z.enum([
  "campaign.upserted",
  "session.started",
  "session.stopped",
  "hypothesis.upserted",
  "worker.registered",
  "worker.heartbeat",
  "experiment.logged",
  "summary.upserted",
  "knowledge.created",
  "entity.deleted",
])

const syncOriginSchema = z
  .object({
    siteId: z.uuid(),
    sequence: z.number().int().positive(),
    eventId: z.string().trim().min(1).max(240),
  })
  .strict()

const syncPayloadBaseSchema = z.object({
  origin: syncOriginSchema.optional(),
})

const researchSyncCampaignPayloadSchema = syncPayloadBaseSchema
  .extend({
    campaign: researchCampaignSchema
      .pick({
        id: true,
        projectId: true,
        name: true,
        description: true,
        baseCommitSha: true,
        status: true,
        metricName: true,
        metricUnit: true,
        metricDirection: true,
        promotionRefName: true,
        createdAt: true,
        updatedAt: true,
      })
      .extend({
        projectId: z
          .uuid()
          .optional()
          .default("00000000-0000-0000-0000-000000000000"),
      })
      .strict(),
  })
  .strict()

const researchSyncSessionPayloadSchema = syncPayloadBaseSchema
  .extend({
    session: researchSessionSchema
      .pick({
        id: true,
        campaignId: true,
        name: true,
        status: true,
        workerTarget: true,
        metadata: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
      })
      .partial({
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
      })
      .strict(),
    reason: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()

const researchSyncHypothesisPayloadSchema = syncPayloadBaseSchema
  .extend({
    hypothesis: researchHypothesisSchema
      .pick({
        id: true,
        campaignId: true,
        createdBySessionId: true,
        name: true,
        description: true,
        status: true,
        baseCommitSha: true,
        bestExperimentId: true,
        bestMetricValue: true,
        lastWorkedAt: true,
        plan: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      })
      .strict(),
  })
  .strict()

const researchSyncWorkerPayloadSchema = syncPayloadBaseSchema
  .extend({
    worker: researchWorkerSchema
      .pick({
        id: true,
        campaignId: true,
        sessionId: true,
        hypothesisId: true,
        workerName: true,
        agentKind: true,
        runtime: true,
        status: true,
        startedAt: true,
        lastSeenAt: true,
        currentExperimentId: true,
        phase: true,
        progressMessage: true,
        gitLabel: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      })
      .partial({
        startedAt: true,
        createdAt: true,
        updatedAt: true,
      })
      .strict(),
  })
  .strict()

const researchSyncWorkerHeartbeatPayloadSchema = syncPayloadBaseSchema
  .extend({
    workerId: z.uuid(),
    heartbeatId: z.uuid(),
    campaignId: z.uuid(),
    sessionId: z.uuid().nullable(),
    hypothesisId: z.uuid(),
    experimentId: z.uuid().nullable(),
    status: researchWorkerStatusSchema,
    phase: z.string().trim().max(120).nullable(),
    event: z.string().trim().max(160).nullable(),
    progressMessage: z.string().trim().max(1000).nullable(),
    gitLabel: z.string().trim().max(240).nullable(),
    resourceStats: metadataSchema,
    metadata: metadataSchema,
    createdAt: z.iso.datetime(),
  })
  .strict()

const researchSyncExperimentPayloadSchema = syncPayloadBaseSchema
  .extend({
    experiment: researchCampaignExperimentSchema
      .pick({
        id: true,
        campaignId: true,
        sessionId: true,
        hypothesisId: true,
        workerId: true,
        runRef: true,
        name: true,
        description: true,
        baseCommitSha: true,
        resultCommitSha: true,
        resultRef: true,
        status: true,
        setupCompliance: true,
        gitStatus: true,
        gitVerifiedAt: true,
        gitStatusReason: true,
        primaryMetricName: true,
        primaryMetricValue: true,
        secondaryMetrics: true,
        artifactRefs: true,
        agentNotes: true,
        checks: true,
        durationMs: true,
        outputSummary: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
      })
      .partial({
        updatedAt: true,
      })
      .strict(),
    campaignName: z.string().trim().min(1).max(120),
    projectPath: projectPathSchema.default(""),
    fingerprint: z.string().trim().min(32).max(128),
  })
  .strict()

const researchSyncSummaryPayloadSchema = syncPayloadBaseSchema
  .extend({
    summary: researchSummarySchema.strict(),
    metadata: metadataSchema.optional(),
  })
  .strict()

const researchSyncKnowledgePayloadSchema = syncPayloadBaseSchema
  .extend({
    knowledge: researchKnowledgeSchema.strict(),
  })
  .strict()

const researchSyncDeletedPayloadSchema = syncPayloadBaseSchema
  .extend({
    entityType: z.enum([
      "campaign",
      "experiment",
      "hypothesis",
      "summary",
      "knowledge",
    ]),
    entityId: z.uuid(),
    campaignId: z.uuid().nullable().default(null),
    name: z.string().trim().min(1).max(240).nullable().default(null),
    runRef: z.string().trim().min(1).max(240).nullable().default(null),
    deletedAt: z.iso.datetime(),
    reason: z.string().trim().max(1000).nullable().default(null),
  })
  .strict()

export const researchSyncEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("campaign.upserted"),
      entityType: z.literal("campaign"),
      entityId: z.uuid(),
      payload: researchSyncCampaignPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("session.started"),
      entityType: z.literal("session"),
      entityId: z.uuid(),
      payload: researchSyncSessionPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("session.stopped"),
      entityType: z.literal("session"),
      entityId: z.uuid(),
      payload: researchSyncSessionPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("hypothesis.upserted"),
      entityType: z.literal("hypothesis"),
      entityId: z.uuid(),
      payload: researchSyncHypothesisPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("worker.registered"),
      entityType: z.literal("worker"),
      entityId: z.uuid(),
      payload: researchSyncWorkerPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("worker.heartbeat"),
      entityType: z.literal("worker"),
      entityId: z.uuid(),
      payload: researchSyncWorkerHeartbeatPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("experiment.logged"),
      entityType: z.literal("experiment"),
      entityId: z.uuid(),
      payload: researchSyncExperimentPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("summary.upserted"),
      entityType: z.literal("summary"),
      entityId: z.uuid(),
      payload: researchSyncSummaryPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("knowledge.created"),
      entityType: z.literal("knowledge"),
      entityId: z.uuid(),
      payload: researchSyncKnowledgePayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      eventId: z.string().trim().min(1).max(240),
      sequence: z.number().int().positive(),
      type: z.literal("entity.deleted"),
      entityType: z.enum([
        "campaign",
        "experiment",
        "hypothesis",
        "summary",
        "knowledge",
      ]),
      entityId: z.uuid(),
      payload: researchSyncDeletedPayloadSchema,
      createdAt: z.iso.datetime(),
    })
    .strict(),
])

export const syncResearchRequestSchema = z.object({
  siteId: z.uuid(),
  repositoryUrl: z.string().trim().min(1).max(2000),
  projectPath: projectPathSchema.default(""),
  pushedExperimentRefs: z
    .array(
      z
        .object({
          campaignId: z.uuid(),
          runRef: z.string().trim().min(1).max(500),
          resultRef: z.string().trim().min(1).max(500),
          resultCommitSha: gitShaSchema,
        })
        .strict()
    )
    .max(500)
    .default([]),
  events: z.array(researchSyncEventSchema).min(1).max(500),
})

export const researchSyncEventAckSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  status: z.enum(["acked", "duplicate", "conflict", "invalid"]),
  code: z.string().trim().min(1),
  entityType: z.string().min(1),
  entityId: z.uuid().nullable(),
  message: z.string().nullable(),
  details: metadataSchema.default({}),
})

export const syncResearchResponseSchema = z.object({
  data: z.object({
    accepted: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    acknowledgements: z.array(researchSyncEventAckSchema),
    tombstones: z
      .array(
        z
          .object({
            entityType: z.string().min(1),
            entityId: z.uuid(),
            campaignId: z.uuid().nullable(),
            name: z.string().nullable(),
            runRef: z.string().nullable(),
            deletedAt: z.iso.datetime(),
            reason: z.string().nullable(),
          })
          .strict()
      )
      .default([]),
    projectionDeltas: z
      .object({
        campaigns: z.array(researchCampaignSchema).default([]),
        sessions: z.array(researchSessionSchema).default([]),
        hypotheses: z.array(researchHypothesisSchema).default([]),
        workers: z.array(researchWorkerSchema).default([]),
        experiments: z.array(researchCampaignExperimentSchema).default([]),
        summaries: z.array(researchSummarySchema).default([]),
        knowledge: z.array(researchKnowledgeSchema).default([]),
      })
      .default({
        campaigns: [],
        sessions: [],
        hypotheses: [],
        workers: [],
        experiments: [],
        summaries: [],
        knowledge: [],
      }),
  }),
})

export const stopResearchSessionRequestSchema = z.object({
  campaignId: z.uuid(),
  status: z
    .enum(["stop_requested", "completed", "failed", "stopped"])
    .default("stop_requested"),
  reason: z.string().trim().max(1000).optional(),
  metadata: metadataSchema.default({}),
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
  data: researchCampaignExperimentSchema,
})

export const researchCampaignExperimentSummarySchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid(),
  sessionId: z.uuid().nullable(),
  hypothesisId: z.uuid().nullable(),
  workerId: z.uuid().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  runRef: z.string().min(1),
  resultCommitSha: z.string().min(1),
  resultRef: z.string().min(1),
  gitStatus: researchExperimentGitStatusSchema,
  gitVerifiedAt: z.iso.datetime().nullable(),
  gitStatusReason: z.string().nullable(),
  status: researchExperimentStatusSchema,
  primaryMetricName: z.string().min(1),
  primaryMetricValue: z.number().finite().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const researchCampaignOverviewResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
    bestExperiment: researchCampaignExperimentSummarySchema.nullable(),
    latestExperiments: z.array(researchCampaignExperimentSummarySchema),
    workers: z.array(researchWorkerSchema),
    hypotheses: z.array(researchHypothesisSchema),
    summaries: z.array(researchSummarySchema),
    knowledge: z.array(researchKnowledgeSchema),
    counts: z.object({
      experiments: z.number().int().nonnegative(),
      hypothesisCount: z.number().int().nonnegative(),
      activeWorkers: z.number().int().nonnegative(),
    }),
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

export const researchCampaignTimelineResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
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
  hypothesisId: z.uuid().optional(),
  status: researchExperimentStatusSchema.optional(),
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

export const createResearchKnowledgeResponseSchema = z.object({
  data: researchKnowledgeSchema,
})

export const listResearchKnowledgeResponseSchema = z.object({
  data: z.array(researchKnowledgeSchema),
})

export const researchMetricSeriesQuerySchema = z.object({
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
  hypothesisId: z.uuid().nullable(),
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
    summaries: z.array(researchSummarySchema),
    knowledge: z.array(researchKnowledgeSchema),
    updatedAt: z.iso.datetime(),
  }),
})

export const createResearchSessionResponseSchema = z.object({
  data: z.object({
    session: researchSessionSchema,
    hypotheses: z.array(researchHypothesisSchema),
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

export const stopResearchSessionResponseSchema = z.object({
  data: researchSessionSchema,
})

export const registerResearchWorkerResponseSchema = z.object({
  data: researchWorkerSchema,
})

export const researchWorkerHeartbeatResponseSchema = z.object({
  data: z.object({
    worker: researchWorkerSchema,
    heartbeat: researchWorkerHeartbeatSchema,
  }),
})

export const upsertResearchSummaryResponseSchema = z.object({
  data: researchSummarySchema,
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

export const researchCampaignFileTreeResponseSchema = z.object({
  data: z.object({
    experiment: researchCampaignExperimentSchema,
    commitSha: gitShaSchema,
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
  }),
})

export const researchCampaignDiffResponseSchema = z.object({
  data: z.object({
    baseExperiment: researchCampaignExperimentSchema.nullable(),
    baseCommitSha: gitShaSchema,
    compareExperiment: researchCampaignExperimentSchema,
    files: z.array(researchDiffFileSchema),
  }),
})

export const researchCampaignExperimentCodeResponseSchema = z.object({
  data: z.object({
    experiment: researchCampaignExperimentSchema,
    baseExperiment: researchCampaignExperimentSchema.nullable(),
    baseCommitSha: gitShaSchema,
    commitSha: gitShaSchema,
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

export const researchCampaignGraphResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
    nodes: z.array(researchCampaignGraphNodeSchema),
    edges: z.array(researchCampaignGraphEdgeSchema),
  }),
})

export const reconcileResearchCampaignQuerySchema = z.object({
  gitVerifyLimit: z.coerce.number().int().min(1).max(500).default(100),
})

export const reconcileResearchCampaignResponseSchema = z.object({
  data: z.object({
    campaign: researchCampaignSchema,
    hypotheses: z.array(researchHypothesisSchema),
    workers: z.array(researchWorkerSchema),
    experiments: z.array(researchCampaignExperimentSchema),
    gitVerification: z.object({
      checkedCount: z.number().int().nonnegative(),
      updatedCount: z.number().int().nonnegative(),
      remainingCount: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      hasMore: z.boolean(),
    }),
  }),
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

export const researchProjectDeletionsResponseSchema = z.object({
  data: z.object({
    campaigns: z.array(
      z.object({
        campaignId: z.uuid(),
        name: z.string().min(1),
        deletedAt: z.iso.datetime(),
      })
    ),
    experiments: z.array(
      z.object({
        experimentId: z.uuid(),
        runRef: z.string().min(1),
        campaignId: z.uuid(),
        campaignName: z.string().min(1),
        deletedAt: z.iso.datetime(),
      })
    ),
  }),
})

export type ResearchMetricDirection = z.infer<
  typeof researchMetricDirectionSchema
>
export type ResearchExperimentStatus = z.infer<
  typeof researchExperimentStatusSchema
>
export type ResearchProjectProvider = z.infer<
  typeof researchProjectProviderSchema
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
export type ResearchSummaryKind = z.infer<typeof researchSummaryKindSchema>
export type ResearchWorkerRuntime = z.infer<typeof researchWorkerRuntimeSchema>
export type ResearchWorkerStatus = z.infer<typeof researchWorkerStatusSchema>
export type ResearchExperimentGitStatus = z.infer<
  typeof researchExperimentGitStatusSchema
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
export type ResearchCampaignTimelinePoint = z.infer<
  typeof researchCampaignTimelinePointSchema
>
export type ResearchCampaignTimelineBestStep = z.infer<
  typeof researchCampaignTimelineBestStepSchema
>
export type ResearchCampaignTimelineResponse = z.infer<
  typeof researchCampaignTimelineResponseSchema
>
export type ListResearchCampaignExperimentsQuery = z.infer<
  typeof listResearchCampaignExperimentsQuerySchema
>
export type ListResearchCampaignExperimentsResponse = z.infer<
  typeof listResearchCampaignExperimentsResponseSchema
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
export type ResearchSessionStatus = z.infer<typeof researchSessionStatusSchema>
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
export type ResearchSessionStateResponse = z.infer<
  typeof researchSessionStateResponseSchema
>
export type StopResearchSessionRequest = z.infer<
  typeof stopResearchSessionRequestSchema
>
export type StopResearchSessionResponse = z.infer<
  typeof stopResearchSessionResponseSchema
>
export type ResearchHypothesis = z.infer<typeof researchHypothesisSchema>
export type ResearchSummary = z.infer<typeof researchSummarySchema>
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
export type UpsertResearchSummaryRequest = z.infer<
  typeof upsertResearchSummaryRequestSchema
>
export type UpsertResearchSummaryResponse = z.infer<
  typeof upsertResearchSummaryResponseSchema
>
export type ResearchWorker = z.infer<typeof researchWorkerSchema>
export type RegisterResearchWorkerRequest = z.infer<
  typeof registerResearchWorkerRequestSchema
>
export type RegisterResearchWorkerResponse = z.infer<
  typeof registerResearchWorkerResponseSchema
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
export type ResearchPresenceWorkerSnapshot = z.infer<
  typeof researchPresenceWorkerSnapshotSchema
>
export type ResearchPresenceIgnoredWorker = z.infer<
  typeof researchPresenceIgnoredWorkerSchema
>
export type SyncResearchPresenceRequest = z.infer<
  typeof syncResearchPresenceRequestSchema
>
export type SyncResearchPresenceResponse = z.infer<
  typeof syncResearchPresenceResponseSchema
>
export type ResearchSyncEventType = z.infer<typeof researchSyncEventTypeSchema>
export type ResearchSyncEvent = z.infer<typeof researchSyncEventSchema>
export type SyncResearchRequest = z.infer<typeof syncResearchRequestSchema>
export type ResearchSyncEventAck = z.infer<typeof researchSyncEventAckSchema>
export type SyncResearchResponse = z.infer<typeof syncResearchResponseSchema>
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
export type ReconcileResearchCampaignQuery = z.infer<
  typeof reconcileResearchCampaignQuerySchema
>
export type ReconcileResearchCampaignResponse = z.infer<
  typeof reconcileResearchCampaignResponseSchema
>
export type DeleteResearchCampaignResponse = z.infer<
  typeof deleteResearchCampaignResponseSchema
>
export type DeleteResearchCampaignExperimentResponse = z.infer<
  typeof deleteResearchCampaignExperimentResponseSchema
>
export type ResearchProjectDeletionsResponse = z.infer<
  typeof researchProjectDeletionsResponseSchema
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

export const researchSummaryUpsertedEventSchema = z.object({
  type: z.literal("research.summary.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    summary: researchSummarySchema,
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

export const researchSessionUpsertedEventSchema = z.object({
  type: z.literal("research.session.upserted"),
  data: z.object({
    projectId: z.uuid(),
    campaignId: z.uuid(),
    session: researchSessionSchema,
  }),
})

export const researchEventSchema = z.discriminatedUnion("type", [
  researchProjectUpsertedEventSchema,
  researchCampaignUpsertedEventSchema,
  researchCampaignDeletedEventSchema,
  researchCampaignExperimentUpsertedEventSchema,
  researchCampaignExperimentDeletedEventSchema,
  researchHypothesisUpsertedEventSchema,
  researchSummaryUpsertedEventSchema,
  researchKnowledgeUpsertedEventSchema,
  researchWorkerUpsertedEventSchema,
  researchSessionUpsertedEventSchema,
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
export type ResearchSummaryUpsertedEvent = z.infer<
  typeof researchSummaryUpsertedEventSchema
>
export type ResearchKnowledgeUpsertedEvent = z.infer<
  typeof researchKnowledgeUpsertedEventSchema
>
export type ResearchWorkerUpsertedEvent = z.infer<
  typeof researchWorkerUpsertedEventSchema
>
export type ResearchSessionUpsertedEvent = z.infer<
  typeof researchSessionUpsertedEventSchema
>
export type ResearchEvent = z.infer<typeof researchEventSchema>
