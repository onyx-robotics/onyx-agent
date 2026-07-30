import { randomUUID } from "node:crypto"

import { PostHog } from "posthog-node"

import {
  CLI_ANALYTICS_COMMAND_NAMES,
  parseCliAnalyticsEvent,
  type CliAnalyticsCommandName,
  type CliAnalyticsEventName,
  type CliAnalyticsEventProperties,
  type CliAnalyticsFailureStage,
  type CliAnalyticsOutcome,
  type CliAnalyticsPreflightStage,
  type CliAnalyticsReasonCode,
} from "../generated/analytics-protocol"
import type { Args } from "./args"
import {
  DEFAULT_API_URL,
  readConfig,
  writeConfig,
  type CliProfile,
  type Config,
} from "./config"
import { cliVersionInfo } from "./version"

declare const __ONYX_OFFICIAL_TELEMETRY_BUILD__: boolean

const DEFAULT_POSTHOG_HOST = "https://e.onyxresearch.ai"
const DELIVERY_BUDGET_MS = 250
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type TelemetryClient = Pick<PostHog, "capture" | "shutdown">
let createTelemetryClient: (
  apiKey: string,
  options: ConstructorParameters<typeof PostHog>[1]
) => TelemetryClient = (apiKey, options) => new PostHog(apiKey, options)

export function setTelemetryClientFactoryForTests(
  factory:
    | ((
        apiKey: string,
        options: ConstructorParameters<typeof PostHog>[1]
      ) => TelemetryClient)
    | null
) {
  createTelemetryClient =
    factory ?? ((apiKey, options) => new PostHog(apiKey, options))
}

const COMMAND_NAMES = new Set<string>(CLI_ANALYTICS_COMMAND_NAMES)

function isTruthy(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true"
}

function internalId(value: string | undefined) {
  return value && UUID_PATTERN.test(value) ? value : undefined
}

export function cliCommandName(argv: string[]): CliAnalyticsCommandName | null {
  const [command, subcommand, action] = argv
  if (!command) return null
  const candidates =
    command === "research" && subcommand === "hypothesis" && action
      ? [`${command}.${subcommand}.${action}`]
      : [[command, subcommand].filter(Boolean).join("."), command]
  return (
    (candidates.find((candidate) => COMMAND_NAMES.has(candidate)) as
      | CliAnalyticsCommandName
      | undefined) ?? null
  )
}

function selectedProfile(config: Config, args?: Args): CliProfile | null {
  const name = args?.options.profile ?? config.currentProfile
  return name ? (config.profiles[name] ?? null) : null
}

function executionIsSuppressed() {
  return Boolean(
    isTruthy(process.env.ONYX_TELEMETRY_DISABLED) ||
    isTruthy(process.env.DO_NOT_TRACK) ||
    process.env.CI ||
    (process.env.NODE_ENV === "test" &&
      !isTruthy(process.env.ONYX_TELEMETRY_TEST)) ||
    process.env.ONYX_WORKER_CONTEXT ||
    process.env.ONYX_WORKER_ID ||
    process.env.ONYX_WORKER_CREDENTIAL ||
    process.env.ONYX_SUPERVISOR_RUN_ID ||
    process.env.ONYX_AUTOMATION ||
    process.env.ONYX_SYNTHETIC_WORKER ||
    process.env.ONYX_TESTBED ||
    process.env.ONYX_TEST_DATABASE_URL ||
    process.env.ONYX_TEST_SUPABASE_URL
  )
}

function distributionAllowsCapture(config: Config) {
  if (isTruthy(process.env.ONYX_TELEMETRY_TEST)) return true
  const officialTelemetryBuild =
    typeof __ONYX_OFFICIAL_TELEMETRY_BUILD__ !== "undefined" &&
    __ONYX_OFFICIAL_TELEMETRY_BUILD__ === true
  const version = cliVersionInfo("onyx")
  return (
    officialTelemetryBuild &&
    version.distribution === "release" &&
    config.developer.mode === "release"
  )
}

function targetAllowsCapture(profile: CliProfile | null) {
  if (isTruthy(process.env.ONYX_TELEMETRY_TEST)) return true
  return !profile || profile.apiUrl === DEFAULT_API_URL
}

export function telemetryEffectiveState({
  config,
  args,
}: {
  config: Config
  args?: Args
}) {
  const profile = selectedProfile(config, args)
  const apiKey = process.env.ONYX_POSTHOG_KEY?.trim()
  const enabled =
    !executionIsSuppressed() &&
    distributionAllowsCapture(config) &&
    targetAllowsCapture(profile) &&
    config.telemetry.enabled !== false &&
    Boolean(internalId(config.telemetry.anonymousId)) &&
    Boolean(apiKey)
  return {
    enabled,
    profile,
    apiKey,
    host: process.env.ONYX_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
  }
}

const FIRST_RUN_NOTICE = `Onyx collects anonymous usage telemetry: command name, outcome, and duration — never code, arguments, or research content.
Opt out anytime with \`onyx telemetry disable\`, ONYX_TELEMETRY_DISABLED=1, or DO_NOT_TRACK=1. Details: https://onyxresearch.ai/privacy`

export async function maybeShowFirstRunNotice(args: Args) {
  try {
    const config = await readConfig()
    if (config.telemetry.noticeShownAt) return false
    if (!process.stderr.isTTY) return false
    if (args.options.json === "true" || args.options.quiet === "true") {
      return false
    }
    // Only show the notice when telemetry would actually capture once noticed.
    if (
      executionIsSuppressed() ||
      !distributionAllowsCapture(config) ||
      !targetAllowsCapture(selectedProfile(config, args)) ||
      config.telemetry.enabled === false ||
      !process.env.ONYX_POSTHOG_KEY?.trim()
    ) {
      return false
    }
    process.stderr.write(`${FIRST_RUN_NOTICE}\n`)
    await writeConfig({
      ...config,
      telemetry: {
        ...config.telemetry,
        noticeShownAt: new Date().toISOString(),
        anonymousId: config.telemetry.anonymousId ?? randomUUID(),
      },
    })
    return true
  } catch {
    return false
  }
}

export async function updateTelemetryPreference(enabled: boolean) {
  const config = await readConfig()
  await writeConfig({
    ...config,
    telemetry: {
      ...config.telemetry,
      enabled,
      anonymousId: config.telemetry.anonymousId ?? randomUUID(),
      // Explicit consent supersedes the first-run notice.
      ...(enabled
        ? {
            noticeShownAt:
              config.telemetry.noticeShownAt ?? new Date().toISOString(),
          }
        : {}),
    },
  })
  return readConfig()
}

function failureDetails(error: unknown): {
  outcome: Exclude<CliAnalyticsOutcome, "success">
  failureStage: CliAnalyticsFailureStage
  reasonCode: CliAnalyticsReasonCode
} {
  if (!(error instanceof Error)) {
    return {
      outcome: "unexpected_error" as const,
      failureStage: "unknown",
      reasonCode: "unexpected_throw",
    }
  }
  const message = error.message.toLowerCase()
  if (message.includes("timed out") || message.includes("timeout")) {
    return {
      outcome: "timeout",
      failureStage: "interruption",
      reasonCode: "timeout",
    }
  }
  if (message.includes("sigint") || message.includes("interrupted")) {
    return {
      outcome: "interrupted",
      failureStage: "interruption",
      reasonCode: "interrupted",
    }
  }
  if (
    message.includes("api key") ||
    message.includes("unauthorized") ||
    message.includes("log in") ||
    message.includes("login")
  ) {
    return {
      outcome: "expected_error",
      failureStage: "auth",
      reasonCode: "auth_required",
    }
  }
  if (message.includes("configuration") || message.includes("config")) {
    return {
      outcome: "expected_error",
      failureStage: "configuration",
      reasonCode: "invalid_configuration",
    }
  }
  if (message.includes("setup") || message.includes("validation")) {
    return {
      outcome: "expected_error",
      failureStage: "setup",
      reasonCode: "setup_invalid",
    }
  }
  if (message.includes("git") || message.includes("commit")) {
    return {
      outcome: "expected_error",
      failureStage: "git",
      reasonCode: "git_invalid",
    }
  }
  if (message.includes("provider")) {
    return {
      outcome: "expected_error",
      failureStage: "provider",
      reasonCode: "provider_unavailable",
    }
  }
  if (message.includes("model")) {
    return {
      outcome: "expected_error",
      failureStage: "model",
      reasonCode: "model_invalid",
    }
  }
  if (message.includes("protocol")) {
    return {
      outcome: "expected_error",
      failureStage: "protocol",
      reasonCode: "protocol_invalid",
    }
  }
  if (message.includes("network") || message.includes("fetch")) {
    return {
      outcome: "expected_error",
      failureStage: "network",
      reasonCode: "network_error",
    }
  }
  if (message.includes("api") || message.includes("server")) {
    return {
      outcome: "expected_error",
      failureStage: "api",
      reasonCode: "api_error",
    }
  }
  if (message.includes("unknown command") || message.includes("removed")) {
    return {
      outcome: "expected_error",
      failureStage: "configuration",
      reasonCode: "usage_error",
    }
  }
  return {
    outcome: "expected_error",
    failureStage: "execution",
    reasonCode: "command_error",
  }
}

async function deliver<TName extends CliAnalyticsEventName>({
  event,
  properties,
  args,
}: {
  event: TName
  properties: CliAnalyticsEventProperties<TName>
  args?: Args
}) {
  return deliverMany({ captures: [{ event, properties }], args })
}

async function deliverMany({
  captures,
  args,
}: {
  captures: Array<{
    event: CliAnalyticsEventName
    properties: unknown
  }>
  args?: Args
}) {
  let config = await readConfig()
  if (
    !internalId(config.telemetry.anonymousId) &&
    !executionIsSuppressed() &&
    distributionAllowsCapture(config) &&
    targetAllowsCapture(selectedProfile(config, args)) &&
    config.telemetry.enabled !== false &&
    Boolean(process.env.ONYX_POSTHOG_KEY?.trim())
  ) {
    await writeConfig({
      ...config,
      telemetry: {
        ...config.telemetry,
        anonymousId: randomUUID(),
      },
    })
    config = await readConfig()
  }
  const state = telemetryEffectiveState({ config, args })
  if (!state.enabled || !state.apiKey) return false
  const profile = state.profile
  const distinctId =
    internalId(profile?.userId) ?? internalId(config.telemetry.anonymousId)
  if (!distinctId) return false
  const version = cliVersionInfo("onyx")
  const client = createTelemetryClient(state.apiKey, {
    host: state.host,
    flushAt: 1,
    flushInterval: 0,
  })
  try {
    for (const capture of captures) {
      const properties = parseCliAnalyticsEvent(
        capture.event,
        capture.properties
      )
      client.capture({
        distinctId,
        event: capture.event,
        groups: internalId(profile?.teamId)
          ? { team: internalId(profile?.teamId)! }
          : undefined,
        properties: {
          ...properties,
          surface: "cli",
          environment: isTruthy(process.env.ONYX_TELEMETRY_TEST)
            ? "development"
            : "production",
          app_version: version.packageVersion,
          release: version.buildSha ?? version.packageVersion,
          ...(internalId(profile?.userId)
            ? {}
            : { $process_person_profile: false }),
        },
      })
    }
    await Promise.race([
      client.shutdown(DELIVERY_BUDGET_MS),
      new Promise<void>((resolve) => setTimeout(resolve, DELIVERY_BUDGET_MS)),
    ])
    return true
  } catch {
    return false
  }
}

const RESEARCH_PREFLIGHT_FAILURE = Symbol.for(
  "onyx.telemetry.research_preflight_failure"
)

export function markResearchPreflightFailure(error: unknown) {
  if (
    !(
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
    )
  )
    return
  try {
    Object.defineProperty(error, RESEARCH_PREFLIGHT_FAILURE, {
      value: true,
      configurable: true,
      enumerable: false,
    })
  } catch {
    // Frozen/non-object throws cannot carry the optional marker.
  }
}

function consumeResearchPreflightFailure(error: unknown) {
  if (
    !(
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
    )
  ) {
    return false
  }
  const marked = RESEARCH_PREFLIGHT_FAILURE in error
  if (marked)
    delete (error as Record<PropertyKey, unknown>)[RESEARCH_PREFLIGHT_FAILURE]
  return marked
}

export async function recordCliCommand({
  argv,
  args,
  startedAt,
  error,
  tuiStartedAt,
}: {
  argv: string[]
  args: Args
  startedAt: number
  error?: unknown
  tuiStartedAt?: number
}) {
  const commandName = cliCommandName(argv)
  if (!commandName) return false
  const config = await readConfig()
  const profile = selectedProfile(config, args)
  const failure = error ? failureDetails(error) : null
  const captures: Array<{
    event: CliAnalyticsEventName
    properties: unknown
  }> = [
    {
      event: "cli:command_complete",
      properties: {
        command_name: commandName,
        outcome: failure?.outcome ?? "success",
        duration_ms: Math.min(
          86_400_000,
          Math.max(0, Math.round((Date.now() - startedAt) / 100) * 100)
        ),
        ...(failure
          ? {
              failure_stage: failure.failureStage,
              reason_code: failure.reasonCode,
            }
          : {}),
        auth_type: profile ? "api_key" : "anonymous",
        official_distribution:
          cliVersionInfo("onyx").distribution === "release",
      },
    },
  ]
  if (error && consumeResearchPreflightFailure(error)) {
    const message = error instanceof Error ? error.message.toLowerCase() : ""
    const stage: CliAnalyticsPreflightStage = message.includes("protocol")
      ? "protocol"
      : message.includes("provider")
        ? "provider"
        : message.includes("model")
          ? "model"
          : message.includes("git") || message.includes("commit")
            ? "git"
            : message.includes("network") || message.includes("fetch")
              ? "network"
              : "setup"
    captures.push({
      event: "research:preflight_fail",
      properties: {
        stage,
        reason_code: failure?.reasonCode ?? "command_error",
      },
    })
  }
  if (tuiStartedAt !== undefined) {
    captures.push({
      event: "cli:tui_end",
      properties: {
        duration_ms: Math.min(
          86_400_000,
          Math.max(0, Math.round((Date.now() - tuiStartedAt) / 100) * 100)
        ),
      },
    })
  }
  return deliverMany({ captures, args })
}

export async function recordCliTui(
  phase: "started" | "ended",
  args: Args,
  startedAt = Date.now()
) {
  if (phase === "started") {
    return deliver({ event: "cli:tui_start", args, properties: {} })
  }
  return deliver({
    event: "cli:tui_end",
    args,
    properties: {
      duration_ms: Math.min(
        86_400_000,
        Math.max(0, Math.round((Date.now() - startedAt) / 100) * 100)
      ),
    },
  })
}

export async function recordSetupValidation({
  args,
  passed,
  failedCheckCount,
  warningCheckCount,
}: {
  args: Args
  passed: boolean
  failedCheckCount: number
  warningCheckCount: number
}) {
  return deliver({
    event: "setup:validation_complete",
    args,
    properties: {
      outcome: passed ? "passed" : "failed",
      failed_check_count: Math.min(100, Math.max(0, failedCheckCount)),
      warning_check_count: Math.min(100, Math.max(0, warningCheckCount)),
    },
  })
}

export async function recordSetupInitialized(args: Args) {
  return deliver({
    event: "setup:setup_initialize",
    args,
    properties: {},
  })
}
