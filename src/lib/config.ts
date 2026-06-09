import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Args } from "./args"

const CONFIG_FILE = "config.json"
export const DEFAULT_API_URL = "https://app.onyxresearch.ai"

export type CliProfile = {
  apiUrl: string
  apiKey?: string
  apiKeyId?: string
  apiKeyEnv?: string
  teamId: string
  teamName: string
  updatedAt: string
}

export type DeveloperMode = "release" | "dev"

export type DeveloperCheckout = {
  root: string
  binPath: string
  skillPath: string
}

export type DeveloperConfig = {
  mode: DeveloperMode
  checkout?: DeveloperCheckout
}

export type Config = {
  profiles: Record<string, CliProfile>
  currentProfile: string
  developer: DeveloperConfig
}

export type ConfigInput = Omit<Config, "developer"> & {
  developer?: DeveloperConfig
}

export function emptyConfig(): Config {
  return {
    profiles: {},
    currentProfile: "",
    developer: { mode: "release" },
  }
}

export function configDir() {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "onyx")
    : join(homedir(), ".config", "onyx")
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
    return { mode, checkout }
  }
  return { mode }
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

export async function readConfig(): Promise<Config> {
  try {
    const parsed = JSON.parse(
      await readFile(configPath(), "utf8")
    ) as Partial<Config>

    return {
      profiles: parsed.profiles ?? {},
      currentProfile: parsed.currentProfile ?? "",
      developer: normalizeDeveloperConfig(parsed.developer),
    }
  } catch {
    return emptyConfig()
  }
}

export async function writeConfig(config: ConfigInput) {
  await mkdir(configDir(), { recursive: true })
  const developer =
    config.developer === undefined
      ? await readExistingDeveloperConfig()
      : normalizeDeveloperConfig(config.developer)
  await writeFile(
    configPath(),
    `${JSON.stringify(
      {
        ...config,
        developer,
      },
      null,
      2
    )}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    }
  )
}

export function normalizeProfileName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function profileNameFromArgs(args: Args | undefined, config: Config) {
  return args?.options.profile ?? config.currentProfile
}

async function selectedProfileEntry(args?: Args): Promise<{
  name: string
  profile: CliProfile
}> {
  const config = await readConfig()
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

export async function apiBaseUrl(
  args?: Args,
  options?: { allowDefault?: boolean }
) {
  if (args?.options["api-url"]) return args.options["api-url"]
  if (process.env.ONYX_API_URL) return process.env.ONYX_API_URL

  const config = await readConfig()
  const profileName = profileNameFromArgs(args, config)
  const profile = profileName ? config.profiles[profileName] : undefined

  if (profile) return profile.apiUrl
  if (process.env.ONYX_API_KEY) return DEFAULT_API_URL
  if (options?.allowDefault) return DEFAULT_API_URL

  if (profileName) {
    throw new Error(
      `Unknown Onyx CLI profile "${profileName}". Run \`onyx profile list\`.`
    )
  }

  throw new Error(
    "No Onyx CLI profile selected. Run `onyx login` or set ONYX_API_URL."
  )
}

export async function apiKey(args?: Args) {
  if (process.env.ONYX_API_KEY) return process.env.ONYX_API_KEY

  const { name, profile } = await selectedProfileEntry(args)
  if (profile.apiKeyEnv) {
    const value = process.env[profile.apiKeyEnv]
    if (value?.trim()) return value

    throw new Error(
      `Profile "${name}" expects API key in ${profile.apiKeyEnv}, but that environment variable is not set or empty.`
    )
  }

  if (profile.apiKey) return profile.apiKey

  throw new Error(
    `Profile "${name}" has no API key. Run \`onyx login --refresh\` or \`onyx profile set-api-key-env ${name} <ENV_VAR>\`.`
  )
}
