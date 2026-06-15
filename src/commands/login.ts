import { randomUUID } from "node:crypto"

import { optionalFlag, type Args } from "../lib/args"
import {
  apiBaseUrl,
  normalizeProfileName,
  readConfig,
  type CliProfile,
  type Config,
  writeConfig,
} from "../lib/config"

export const LOCAL_API_URL = "http://localhost:3000"
import { openBrowser, waitForCliLogin, type CliLoginResult } from "../lib/login"

export type CliLoginProfileManifestEntry = {
  profileName: string
  teamId: string
  apiUrl: string
  apiKeyId?: string
}

export function loginProfileManifest(
  config: Config
): CliLoginProfileManifestEntry[] {
  return Object.entries(config.profiles).map(([profileName, profile]) => ({
    profileName,
    teamId: profile.teamId,
    apiUrl: profile.apiUrl,
    ...(profile.apiKeyId ? { apiKeyId: profile.apiKeyId } : {}),
  }))
}

export function encodeLoginProfileManifest(
  profiles: CliLoginProfileManifestEntry[]
) {
  return Buffer.from(JSON.stringify(profiles), "utf8").toString("base64url")
}

export function profileNameForTeam(teamName: string) {
  const [firstWord = ""] = teamName.trim().split(/\s+/)
  return normalizeProfileName(firstWord) || "team"
}

export function profileNameForLoginResult({
  config,
  apiUrl,
  teamId,
  teamName,
}: {
  config: Config
  apiUrl: string
  teamId: string
  teamName: string
}) {
  const existing = Object.entries(config.profiles).find(
    ([, profile]) => profile.teamId === teamId && profile.apiUrl === apiUrl
  )

  if (existing) {
    return existing[0]
  }

  const baseName = profileNameForTeam(teamName)
  let candidate = baseName
  let suffix = 2

  while (config.profiles[candidate]) {
    candidate = `${baseName}-${suffix}`
    suffix += 1
  }

  return candidate
}

export function buildCliLoginUrl({
  baseUrl,
  redirectUri,
  state,
  profiles,
  refresh,
}: {
  baseUrl: string
  redirectUri: string
  state: string
  profiles: CliLoginProfileManifestEntry[]
  refresh: boolean
}) {
  const loginUrl = new URL("/cli/login", baseUrl)
  loginUrl.searchParams.set("redirect_uri", redirectUri)
  loginUrl.searchParams.set("state", state)
  loginUrl.searchParams.set("profiles", encodeLoginProfileManifest(profiles))
  if (refresh) {
    loginUrl.searchParams.set("refresh", "true")
  }

  return loginUrl
}

function storedProfileFromLoginResult({
  apiUrl,
  result,
}: {
  apiUrl: string
  result: CliLoginResult
}): CliProfile {
  if (!result.apiKey) {
    throw new Error("Login callback did not include an API key.")
  }

  return {
    apiUrl,
    apiKey: result.apiKey,
    ...(result.apiKeyId ? { apiKeyId: result.apiKeyId } : {}),
    teamId: result.teamId,
    teamName: result.teamName,
    updatedAt: new Date().toISOString(),
  }
}

export async function saveLoginProfile({
  baseUrl,
  result,
}: {
  baseUrl: string
  result: CliLoginResult
}) {
  const config = await readConfig()
  const apiUrl = result.apiUrl ?? baseUrl
  const profileName = profileNameForLoginResult({
    config,
    apiUrl,
    teamId: result.teamId,
    teamName: result.teamName,
  })

  if (result.alreadyConfigured) {
    if (!config.profiles[profileName]) {
      throw new Error(
        "Login selected an already configured team, but no matching local profile was found."
      )
    }

    await writeConfig({
      ...config,
      currentProfile: profileName,
    })
    return { profileName, apiUrl, alreadyConfigured: true }
  }

  await writeConfig({
    profiles: {
      ...config.profiles,
      [profileName]: storedProfileFromLoginResult({ apiUrl, result }),
    },
    currentProfile: profileName,
  })

  return { profileName, apiUrl, alreadyConfigured: false }
}

export async function loginBaseUrl(args: Args) {
  if (optionalFlag(args, "local")) {
    if (args.options["api-url"]) {
      throw new Error("Pass either --local or --api-url, not both.")
    }
    return LOCAL_API_URL
  }
  return apiBaseUrl(args, { allowDefault: true })
}

export async function commandLogin(args: Args) {
  const baseUrl = await loginBaseUrl(args)
  const port = Number(args.options.port ?? 8765)
  const state = randomUUID()
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const config = await readConfig()
  const loginUrl = buildCliLoginUrl({
    baseUrl,
    redirectUri,
    state,
    profiles: loginProfileManifest(config),
    refresh: optionalFlag(args, "refresh"),
  })

  const loginPromise = waitForCliLogin({
    port,
    state,
    timeoutMs: Number(args.options.timeout ?? 120_000),
  })

  if (optionalFlag(args, "print-url")) {
    console.log(loginUrl.toString())
  } else {
    console.log(`Opening browser login at ${baseUrl} ...`)
    await openBrowser(loginUrl.toString())
    console.log("Waiting for browser login...")
  }

  const result = await loginPromise
  const saved = await saveLoginProfile({ baseUrl, result })
  if (saved.alreadyConfigured) {
    console.log(
      `Using existing profile ${saved.profileName} for ${result.teamName} (${result.teamId}) at ${saved.apiUrl}`
    )
  } else {
    console.log(
      `Logged in profile ${saved.profileName} for ${result.teamName} (${result.teamId}) at ${saved.apiUrl}`
    )
  }
}
