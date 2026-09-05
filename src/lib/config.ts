import { randomUUID } from "node:crypto"
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Args } from "./args"

const CONFIG_FILE = "config.json"
// v1: API-key profiles. v2 (unreleased): OAuth profiles without pinned issuer
// metadata or a required session id. v3: nonce-bound OAuth profiles.
export const CONFIG_VERSION = 3 as const
export const DEFAULT_API_URL = "https://app.onyxresearch.ai"

export const BUILT_IN_WORKER_AGENTS = ["codex", "claude", "opencode"] as const
export type BuiltInWorkerAgent = (typeof BUILT_IN_WORKER_AGENTS)[number]

export type WorkerProfileConfig = {
  agent?: BuiltInWorkerAgent
  models?: Partial<Record<BuiltInWorkerAgent, string>>
}

/**
 * OAuth metadata pinned at login. Refresh uses these values directly so a
 * later change to the API server's advertised configuration can never
 * redirect a stored refresh token to another token endpoint.
 */
export type ProfileOAuthConfig = {
  issuer: string
  clientId: string
  tokenEndpoint: string
  scopes: string[]
}

export type CliProfile = {
  apiUrl: string
  cliSessionId: string
  credentialId: string
  credentialStore: "keyring" | "file"
  oauth: ProfileOAuthConfig
  teamId: string
  teamName: string
  userId?: string
  updatedAt: string
  worker?: WorkerProfileConfig
}

/** Non-secret profile fields carried across a config-format migration. */
export type LegacyProfileMetadata = {
  apiUrl: string
  teamId: string
  teamName: string
  userId?: string
  worker?: WorkerProfileConfig
  updatedAt?: string
}

export type DeveloperMode = "release" | "dev"

export type DeveloperCheckout = {
  root: string
  binPath: string
  workerBinPath: string
  skillPath: string
}

export type DeveloperConfig = {
  mode: DeveloperMode
  checkout?: DeveloperCheckout
}

export type TelemetryConfig = {
  enabled?: boolean
  anonymousId?: string
  noticeShownAt?: string
}

export type Config = {
  version: typeof CONFIG_VERSION
  profiles: Record<string, CliProfile>
  currentProfile: string
  credentialFallbackWarningShownAt?: string
  developer: DeveloperConfig
  telemetry: TelemetryConfig
  /**
   * Set when the on-disk config uses an older format. Profiles are then
   * reported as empty and commands that need one explain how to migrate.
   */
  legacyVersion?: number | "unknown"
}

export type ConfigInput = Omit<
  Config,
  "developer" | "telemetry" | "version" | "legacyVersion"
> & {
  version?: typeof CONFIG_VERSION
  developer?: DeveloperConfig
  telemetry?: TelemetryConfig
}

export function emptyConfig(): Config {
  return {
    version: CONFIG_VERSION,
    profiles: {},
    currentProfile: "",
    developer: { mode: "release" },
    telemetry: {},
  }
}

export function configDir() {
  if (process.env.ONYX_HOME) return join(process.env.ONYX_HOME, "config")
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "onyx")
    : join(homedir(), ".config", "onyx")
}

function inferWorkerBinPath(
  checkout: Pick<DeveloperCheckout, "root" | "binPath">
) {
  if (checkout.binPath.endsWith("/bin/onyx.js")) {
    return checkout.binPath.replace(/\/bin\/onyx\.js$/, "/bin/onyx-worker.js")
  }
  if (checkout.binPath.endsWith("/packages/agent/bin/onyx.js")) {
    return checkout.binPath.replace(
      /\/packages\/agent\/bin\/onyx\.js$/,
      "/packages/agent/bin/onyx-worker.js"
    )
  }
  return join(checkout.root, "bin", "onyx-worker.js")
}

export function configPath() {
  return join(configDir(), CONFIG_FILE)
}

function normalizeDeveloperConfig(value: unknown): DeveloperConfig {
  if (!value || typeof value !== "object") return { mode: "release" }
  const candidate = value as Partial<DeveloperConfig>
  const mode = candidate.mode === "dev" ? "dev" : "release"
  const checkout = candidate.checkout
  if (
    checkout &&
    typeof checkout.root === "string" &&
    typeof checkout.binPath === "string" &&
    typeof checkout.skillPath === "string"
  ) {
    return {
      mode,
      checkout: {
        ...checkout,
        workerBinPath:
          typeof checkout.workerBinPath === "string"
            ? checkout.workerBinPath
            : inferWorkerBinPath(checkout),
      },
    }
  }
  return { mode }
}

export function isBuiltInWorkerAgent(
  value: unknown
): value is BuiltInWorkerAgent {
  return (
    typeof value === "string" &&
    (BUILT_IN_WORKER_AGENTS as readonly string[]).includes(value)
  )
}

export function validateBuiltInWorkerAgent(value: string): BuiltInWorkerAgent {
  if (isBuiltInWorkerAgent(value)) return value
  throw new Error("--agent must be codex, claude, or opencode")
}

export function normalizeWorkerModel(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export function normalizeWorkerProfileConfig(
  value: unknown
): WorkerProfileConfig | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<WorkerProfileConfig>
  const worker: WorkerProfileConfig = {}
  if (isBuiltInWorkerAgent(candidate.agent)) worker.agent = candidate.agent
  if (candidate.models && typeof candidate.models === "object") {
    const models: Partial<Record<BuiltInWorkerAgent, string>> = {}
    for (const agent of BUILT_IN_WORKER_AGENTS) {
      const model = normalizeWorkerModel(
        (candidate.models as Record<string, unknown>)[agent]
      )
      if (model) models[agent] = model
    }
    if (Object.keys(models).length > 0) worker.models = models
  }
  return worker.agent || worker.models ? worker : undefined
}

function normalizeProfileOAuthConfig(value: unknown): ProfileOAuthConfig | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<ProfileOAuthConfig>
  if (
    typeof candidate.issuer !== "string" ||
    typeof candidate.clientId !== "string" ||
    typeof candidate.tokenEndpoint !== "string" ||
    !Array.isArray(candidate.scopes) ||
    !candidate.scopes.every((scope) => typeof scope === "string")
  ) {
    return null
  }
  return {
    issuer: candidate.issuer,
    clientId: candidate.clientId,
    tokenEndpoint: candidate.tokenEndpoint,
    scopes: [...candidate.scopes],
  }
}

function normalizeCliProfile(value: unknown): CliProfile | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<CliProfile>
  const oauth = normalizeProfileOAuthConfig(candidate.oauth)
  if (
    typeof candidate.apiUrl !== "string" ||
    typeof candidate.cliSessionId !== "string" ||
    typeof candidate.credentialId !== "string" ||
    (candidate.credentialStore !== "keyring" &&
      candidate.credentialStore !== "file") ||
    !oauth ||
    typeof candidate.teamId !== "string" ||
    typeof candidate.teamName !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null
  }
  const worker = normalizeWorkerProfileConfig(candidate.worker)
  return {
    apiUrl: candidate.apiUrl,
    cliSessionId: candidate.cliSessionId,
    credentialId: candidate.credentialId,
    credentialStore: candidate.credentialStore,
    oauth,
    teamId: candidate.teamId,
    teamName: candidate.teamName,
    ...(typeof candidate.userId === "string"
      ? { userId: candidate.userId }
      : {}),
    updatedAt: candidate.updatedAt,
    ...(worker ? { worker } : {}),
  }
}

function normalizeProfiles(value: unknown): Record<string, CliProfile> {
  if (!value || typeof value !== "object") return {}
  const profiles: Record<string, CliProfile> = {}
  for (const [name, profile] of Object.entries(value)) {
    const normalized = normalizeCliProfile(profile)
    if (normalized) profiles[name] = normalized
  }
  return profiles
}

async function readExistingDeveloperConfig() {
  try {
    const parsed = JSON.parse(
      await readFile(configPath(), "utf8")
    ) as Partial<Config>
    return normalizeDeveloperConfig(parsed.developer)
  } catch {
    return { mode: "release" as const }
  }
}

function normalizeTelemetryConfig(value: unknown): TelemetryConfig {
  if (!value || typeof value !== "object") return {}
  const candidate = value as Partial<TelemetryConfig>
  return {
    ...(typeof candidate.enabled === "boolean"
      ? { enabled: candidate.enabled }
      : {}),
    ...(typeof candidate.anonymousId === "string"
      ? { anonymousId: candidate.anonymousId }
      : {}),
    ...(typeof candidate.noticeShownAt === "string"
      ? { noticeShownAt: candidate.noticeShownAt }
      : {}),
  }
}

async function readExistingTelemetryConfig() {
  try {
    const parsed = JSON.parse(
      await readFile(configPath(), "utf8")
    ) as Partial<Config>
    return normalizeTelemetryConfig(parsed.telemetry)
  } catch {
    return {}
  }
}

// The supervisor calls the API continuously and every call resolves the
// active profile; cache the parsed config keyed by file mtime so steady-state
// reads cost one stat instead of a read+parse. External edits (profile
// switches from another shell) still land via the mtime check.
let configCache: { mtimeMs: number; config: Config } | null = null

/** Test hook: module-level cache shared across calls. */
export function clearConfigCache() {
  configCache = null
}

export async function readConfig(): Promise<Config> {
  let mtimeMs: number | null = null
  try {
    mtimeMs = (await stat(configPath())).mtimeMs
  } catch {
    return emptyConfig()
  }
  if (configCache && configCache.mtimeMs === mtimeMs) {
    return configCache.config
  }
  try {
    const parsed = JSON.parse(
      await readFile(configPath(), "utf8")
    ) as Partial<Config>

    if (parsed.version !== CONFIG_VERSION) {
      // Never cached: `onyx login` migrates the file in place and the next
      // read must observe the new format.
      return {
        ...emptyConfig(),
        developer: normalizeDeveloperConfig(parsed.developer),
        telemetry: normalizeTelemetryConfig(parsed.telemetry),
        legacyVersion:
          typeof parsed.version === "number" ? parsed.version : "unknown",
      }
    }

    const config = {
      version: CONFIG_VERSION,
      profiles: normalizeProfiles(parsed.profiles),
      currentProfile: parsed.currentProfile ?? "",
      ...(typeof parsed.credentialFallbackWarningShownAt === "string"
        ? {
            credentialFallbackWarningShownAt:
              parsed.credentialFallbackWarningShownAt,
          }
        : {}),
      developer: normalizeDeveloperConfig(parsed.developer),
      telemetry: normalizeTelemetryConfig(parsed.telemetry),
    }
    configCache = { mtimeMs, config }
    return config
  } catch {
    return emptyConfig()
  }
}

export async function writeConfig(config: ConfigInput) {
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  await chmod(configDir(), 0o700)
  const developer =
    config.developer === undefined
      ? await readExistingDeveloperConfig()
      : normalizeDeveloperConfig(config.developer)
  const telemetry =
    config.telemetry === undefined
      ? await readExistingTelemetryConfig()
      : normalizeTelemetryConfig(config.telemetry)
  const { legacyVersion: _legacyVersion, ...persisted } = config as Config
  void _legacyVersion
  await writePrivateJsonFile(configPath(), {
    ...persisted,
    version: CONFIG_VERSION,
    developer,
    telemetry,
  })
  configCache = null
}

async function writePrivateJsonFile(path: string, value: unknown) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

export function normalizeProfileName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function profileNameFromArgs(args: Args | undefined, config: Config) {
  return args?.options.profile ?? config.currentProfile
}

export function legacyConfigMessage(config: Config) {
  if (config.legacyVersion === undefined) return null
  const version =
    config.legacyVersion === "unknown"
      ? "an unversioned"
      : `the v${config.legacyVersion}`
  return `Your Onyx CLI login format is out of date (found ${version} config). Run \`onyx login\` to migrate. Team names and worker settings are kept; old API keys and tokens are removed.`
}

function requireCurrentConfigFormat(config: Config) {
  const message = legacyConfigMessage(config)
  if (message) throw new Error(message)
}

async function selectedProfileEntry(args?: Args): Promise<{
  name: string
  profile: CliProfile
}> {
  const config = await readConfig()
  requireCurrentConfigFormat(config)
  const profileName = profileNameFromArgs(args, config)

  if (!profileName) {
    throw new Error(
      "No Onyx CLI profile selected. Run `onyx login` or set ONYX_API_KEY."
    )
  }

  const profile = config.profiles[profileName]
  if (!profile) {
    throw new Error(
      `Unknown Onyx CLI profile "${profileName}". Run \`onyx profile list\`.`
    )
  }

  return { name: profileName, profile }
}

export async function selectedProfile(args?: Args): Promise<CliProfile> {
  return (await selectedProfileEntry(args)).profile
}

export type ApiTarget = {
  url: string
  source: "flag" | "env" | "profile" | "default"
  profileName?: string
}

export async function apiTarget(
  args?: Args,
  options?: { allowDefault?: boolean }
): Promise<ApiTarget | null> {
  if (args?.options["api-url"]) {
    return { url: args.options["api-url"], source: "flag" }
  }
  if (process.env.ONYX_API_URL) {
    return { url: process.env.ONYX_API_URL, source: "env" }
  }

  const config = await readConfig()
  const profileName = profileNameFromArgs(args, config)
  const profile = profileName ? config.profiles[profileName] : undefined

  if (profile && profileName) {
    return { url: profile.apiUrl, source: "profile", profileName }
  }
  if (process.env.ONYX_API_KEY || options?.allowDefault) {
    return { url: DEFAULT_API_URL, source: "default" }
  }

  return null
}

export function describeApiTarget(target: ApiTarget) {
  if (target.source === "flag") return `${target.url} (--api-url)`
  if (target.source === "env") return `${target.url} (ONYX_API_URL)`
  if (target.source === "profile")
    return `${target.url} (profile ${target.profileName})`
  return `${target.url} (default)`
}

export async function apiBaseUrl(
  args?: Args,
  options?: { allowDefault?: boolean }
) {
  const target = await apiTarget(args, options)
  if (target) return target.url

  const config = await readConfig()
  requireCurrentConfigFormat(config)
  const profileName = profileNameFromArgs(args, config)
  if (profileName) {
    throw new Error(
      `Unknown Onyx CLI profile "${profileName}". Run \`onyx profile list\`.`
    )
  }

  throw new Error(
    "No Onyx CLI profile selected. Run `onyx login` or set ONYX_API_URL."
  )
}

export async function apiCredential(args?: Args) {
  if (process.env.ONYX_API_KEY) return process.env.ONYX_API_KEY
  const { name, profile } = await selectedProfileEntry(args)
  const { accessTokenForProfile } = await import("./oauth-credentials")
  return accessTokenForProfile({ name, profile })
}

export async function selectedProfileWithName(args?: Args) {
  return selectedProfileEntry(args)
}

function legacyProfileMetadata(value: unknown): LegacyProfileMetadata | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.apiUrl !== "string" ||
    typeof candidate.teamId !== "string" ||
    typeof candidate.teamName !== "string"
  ) {
    return null
  }
  const worker = normalizeWorkerProfileConfig(candidate.worker)
  return {
    apiUrl: candidate.apiUrl,
    teamId: candidate.teamId,
    teamName: candidate.teamName,
    ...(typeof candidate.userId === "string"
      ? { userId: candidate.userId }
      : {}),
    ...(worker ? { worker } : {}),
    ...(typeof candidate.updatedAt === "string"
      ? { updatedAt: candidate.updatedAt }
      : {}),
  }
}

export type StagedLegacyConfigMigration = {
  legacyVersion: number | null
  legacyProfiles: Record<string, LegacyProfileMetadata>
  /** v2 credential references to remove once the new login is stored. */
  staleCredentials: Array<{
    credentialId: string
    credentialStore: "keyring" | "file"
    apiUrl: string
    cliSessionId?: string
  }>
  currentProfile: string
  credentialFallbackWarningShownAt?: string
  developer: DeveloperConfig
  telemetry: TelemetryConfig
}

/**
 * Reads an older config file without modifying anything. `onyx login` stages
 * the migration up front, completes the new login, stores the new profile, and
 * only then writes the sanitized backup and removes stale credentials, so a
 * cancelled or failed login never destroys the existing configuration.
 */
export async function stageLegacyConfigMigration(): Promise<StagedLegacyConfigMigration | null> {
  let raw: string
  try {
    raw = await readFile(configPath(), "utf8")
  } catch {
    return null
  }
  let parsed: Partial<Config> & Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Partial<Config> & Record<string, unknown>
  } catch {
    parsed = {}
  }
  if (parsed.version === CONFIG_VERSION) return null

  const legacyProfiles: Record<string, LegacyProfileMetadata> = {}
  const staleCredentials: StagedLegacyConfigMigration["staleCredentials"] = []
  const rawProfiles =
    parsed.profiles && typeof parsed.profiles === "object"
      ? (parsed.profiles as Record<string, unknown>)
      : {}
  for (const [name, value] of Object.entries(rawProfiles)) {
    const metadata = legacyProfileMetadata(value)
    if (metadata) legacyProfiles[name] = metadata
    const candidate = value as Record<string, unknown> | null
    if (
      candidate &&
      typeof candidate.credentialId === "string" &&
      (candidate.credentialStore === "keyring" ||
        candidate.credentialStore === "file") &&
      typeof candidate.apiUrl === "string"
    ) {
      staleCredentials.push({
        credentialId: candidate.credentialId,
        credentialStore: candidate.credentialStore,
        apiUrl: candidate.apiUrl,
        ...(typeof candidate.cliSessionId === "string"
          ? { cliSessionId: candidate.cliSessionId }
          : {}),
      })
    }
  }
  return {
    legacyVersion: typeof parsed.version === "number" ? parsed.version : null,
    legacyProfiles,
    staleCredentials,
    currentProfile:
      typeof parsed.currentProfile === "string" ? parsed.currentProfile : "",
    ...(typeof parsed.credentialFallbackWarningShownAt === "string"
      ? {
          credentialFallbackWarningShownAt:
            parsed.credentialFallbackWarningShownAt,
        }
      : {}),
    developer: normalizeDeveloperConfig(parsed.developer),
    telemetry: normalizeTelemetryConfig(parsed.telemetry),
  }
}

/**
 * Writes the sanitized backup for a staged migration (profile names, team
 * metadata, worker defaults, developer mode, telemetry preferences; no API
 * keys, tokens, or credential references). Returns the backup path.
 */
export async function writeLegacyConfigBackup(
  staged: StagedLegacyConfigMigration
): Promise<string> {
  const label =
    staged.legacyVersion === null ? "unversioned" : `v${staged.legacyVersion}`
  const backupPath = join(
    configDir(),
    `config.${label}.backup.${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  )
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  await chmod(configDir(), 0o700)
  await writePrivateJsonFile(backupPath, {
    version: staged.legacyVersion,
    sanitized: true,
    profiles: staged.legacyProfiles,
    currentProfile: staged.currentProfile,
    ...(staged.credentialFallbackWarningShownAt
      ? {
          credentialFallbackWarningShownAt:
            staged.credentialFallbackWarningShownAt,
        }
      : {}),
    developer: staged.developer,
    telemetry: staged.telemetry,
  })
  return backupPath
}

export type LegacyConfigMigration = {
  migrated: boolean
  backupPath?: string
  legacyProfiles: Record<string, LegacyProfileMetadata>
  staleCredentials: StagedLegacyConfigMigration["staleCredentials"]
  currentProfile: string
}

/**
 * Stages, backs up, and rewrites an older config as an empty current-format
 * file in one step. `onyx login` uses the staged variant so the rewrite
 * happens only after the new profile is stored.
 */
export async function migrateLegacyConfigForLogin(): Promise<LegacyConfigMigration> {
  const staged = await stageLegacyConfigMigration()
  if (!staged) {
    return {
      migrated: false,
      legacyProfiles: {},
      staleCredentials: [],
      currentProfile: "",
    }
  }
  const backupPath = await writeLegacyConfigBackup(staged)
  await writeConfig({
    ...emptyConfig(),
    ...(staged.credentialFallbackWarningShownAt
      ? {
          credentialFallbackWarningShownAt:
            staged.credentialFallbackWarningShownAt,
        }
      : {}),
    developer: staged.developer,
    telemetry: staged.telemetry,
  })
  return {
    migrated: true,
    backupPath,
    legacyProfiles: staged.legacyProfiles,
    staleCredentials: staged.staleCredentials,
    currentProfile: staged.currentProfile,
  }
}

/**
 * Records where a profile's credential actually lives after a refresh had to
 * fall back from the keyring to the private file store.
 */
export async function updateProfileCredentialStore(
  name: string,
  credentialStore: "keyring" | "file"
): Promise<void> {
  const config = await readConfig()
  const profile = config.profiles[name]
  if (!profile || profile.credentialStore === credentialStore) return
  await writeConfig({
    ...config,
    profiles: {
      ...config.profiles,
      [name]: {
        ...profile,
        credentialStore,
        updatedAt: new Date().toISOString(),
      },
    },
  })
}
