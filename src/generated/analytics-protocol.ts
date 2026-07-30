// Generated from packages/analytics/src/cli-protocol.ts. Do not edit by hand.

import { z } from "zod"

export const CLI_ANALYTICS_COMMAND_NAMES = [
  "login",
  "agent.skill-path",
  "agent.install-skill",
  "profile.list",
  "profile.use",
  "profile.delete",
  "profile.set-api-key-env",
  "profile.worker",
  "campaign.setup",
  "campaign.use",
  "campaign.status",
  "campaign.delete",
  "tools.run",
  "setup.init",
  "setup.validate",
  "research.run",
  "research.hypotheses",
  "research.hypothesis.list",
  "research.hypothesis.add",
  "research.hypothesis.close",
  "research.hypothesis.reopen",
  "research.stop",
  "research.scale",
  "research.clean",
  "research.brief",
  "research.status",
  "knowledge.add",
  "knowledge.list",
  "exp.run",
  "exp.log",
  "exp.list",
  "workflow.status",
  "listen",
  "status",
  "telemetry.status",
  "telemetry.enable",
  "telemetry.disable",
] as const

export const CLI_ANALYTICS_OUTCOMES = [
  "success",
  "expected_error",
  "unexpected_error",
  "interrupted",
  "timeout",
] as const

export const CLI_ANALYTICS_FAILURE_STAGES = [
  "auth",
  "configuration",
  "setup",
  "git",
  "provider",
  "model",
  "protocol",
  "network",
  "api",
  "execution",
  "interruption",
  "unknown",
] as const

export const CLI_ANALYTICS_REASON_CODES = [
  "auth_required",
  "invalid_configuration",
  "setup_invalid",
  "git_invalid",
  "provider_unavailable",
  "model_invalid",
  "protocol_invalid",
  "network_error",
  "api_error",
  "usage_error",
  "timeout",
  "interrupted",
  "unexpected_throw",
  "command_error",
] as const

export const CLI_ANALYTICS_PREFLIGHT_STAGES = [
  "provider",
  "model",
  "protocol",
  "setup",
  "git",
  "network",
] as const

export const cliAnalyticsCommandNameSchema = z.enum(CLI_ANALYTICS_COMMAND_NAMES)
export const cliAnalyticsOutcomeSchema = z.enum(CLI_ANALYTICS_OUTCOMES)
export const cliAnalyticsFailureStageSchema = z.enum(
  CLI_ANALYTICS_FAILURE_STAGES
)
export const cliAnalyticsReasonCodeSchema = z.enum(CLI_ANALYTICS_REASON_CODES)
export const cliAnalyticsPreflightStageSchema = z.enum(
  CLI_ANALYTICS_PREFLIGHT_STAGES
)

const cliAuthTypeSchema = z.enum(["anonymous", "session", "api_key"])

export const cliAnalyticsEventSchemas = {
  "cli:command_complete": z
    .object({
      command_name: cliAnalyticsCommandNameSchema,
      outcome: cliAnalyticsOutcomeSchema,
      duration_ms: z.number().int().min(0).max(86_400_000),
      failure_stage: cliAnalyticsFailureStageSchema.optional(),
      reason_code: cliAnalyticsReasonCodeSchema.optional(),
      auth_type: cliAuthTypeSchema,
      official_distribution: z.boolean(),
    })
    .strict(),
  "cli:tui_start": z.object({}).strict(),
  "cli:tui_end": z
    .object({
      duration_ms: z.number().int().min(0).max(86_400_000),
    })
    .strict(),
  "setup:setup_initialize": z.object({}).strict(),
  "setup:validation_complete": z
    .object({
      outcome: z.enum(["passed", "failed"]),
      failed_check_count: z.number().int().min(0).max(100),
      warning_check_count: z.number().int().min(0).max(100),
    })
    .strict(),
  "research:preflight_fail": z
    .object({
      stage: cliAnalyticsPreflightStageSchema,
      reason_code: cliAnalyticsReasonCodeSchema,
    })
    .strict(),
} as const

export type CliAnalyticsCommandName = z.infer<
  typeof cliAnalyticsCommandNameSchema
>
export type CliAnalyticsOutcome = z.infer<typeof cliAnalyticsOutcomeSchema>
export type CliAnalyticsFailureStage = z.infer<
  typeof cliAnalyticsFailureStageSchema
>
export type CliAnalyticsReasonCode = z.infer<
  typeof cliAnalyticsReasonCodeSchema
>
export type CliAnalyticsPreflightStage = z.infer<
  typeof cliAnalyticsPreflightStageSchema
>
export type CliAnalyticsEventName = keyof typeof cliAnalyticsEventSchemas
export type CliAnalyticsEventProperties<TName extends CliAnalyticsEventName> =
  z.input<(typeof cliAnalyticsEventSchemas)[TName]>

const CLI_FORBIDDEN_PROPERTY_KEY =
  /(^|_)(email|personal_name|user_name|team_name|repository_name|repo_name|description|repository|repo|url|path|file_path|file_name|code|diff|prompt|output|note|metric_name|metric_value|api_key|credential|secret|token|cookie|header|request|response|body|sha|commit|ref|environment_variable|env_var)($|_)/i

const CLI_FORBIDDEN_PROPERTY_VALUE = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /https?:\/\//i,
  /(^|\s)(\/Users\/|\/home\/|[A-Za-z]:\\)/,
  /\b(gh[oprsu]_|sk-|onyx_)[A-Za-z0-9_-]{8,}\b/i,
]
const CLI_BOUNDED_KEY_ALLOWLIST = new Set(["reason_code"])

export function parseCliAnalyticsEvent<TName extends CliAnalyticsEventName>(
  event: TName,
  properties: unknown
): CliAnalyticsEventProperties<TName> {
  const parsed = cliAnalyticsEventSchemas[event].parse(properties)
  for (const [key, value] of Object.entries(parsed)) {
    if (
      !CLI_BOUNDED_KEY_ALLOWLIST.has(key) &&
      CLI_FORBIDDEN_PROPERTY_KEY.test(key)
    ) {
      throw new Error(`CLI analytics property is forbidden: ${key}`)
    }
    if (
      typeof value === "string" &&
      CLI_FORBIDDEN_PROPERTY_VALUE.some((pattern) => pattern.test(value))
    ) {
      throw new Error(`CLI analytics property contains forbidden data: ${key}`)
    }
  }
  return parsed as CliAnalyticsEventProperties<TName>
}
