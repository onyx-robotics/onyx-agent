import { createHash, randomBytes, randomUUID } from "node:crypto"
import { hostname, platform, release } from "node:os"
import { createInterface } from "node:readline/promises"

import { optionalFlag, type Args } from "../lib/args"
import {
  apiBaseUrl,
  normalizeProfileName,
  readConfig,
  resetUnsupportedConfigForLogin,
  type CliProfile,
  type Config,
  writeConfig,
} from "../lib/config"
import {
  deleteCredential,
  writeCredential,
  type OAuthCredential,
} from "../lib/credential-store"
import { createLoopbackCallback, openBrowser } from "../lib/login"
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchCliAuthConfig,
  pollDeviceTokens,
  startDeviceAuthorization,
  type CliAuthConfig,
} from "../lib/oauth-client"

export const LOCAL_API_URL = "http://localhost:3000"

type CliTeam = {
  id: string
  name: string
  role: "admin" | "editor" | "viewer"
}
type BoundSession = {
  id: string
  userId: string
  teamId: string
  teamName: string
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
  if (existing) return existing[0]
  const baseName = profileNameForTeam(teamName)
  let candidate = baseName
  let suffix = 2
  while (config.profiles[candidate]) {
    candidate = `${baseName}-${suffix}`
    suffix += 1
  }
  return candidate
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

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}

export function shouldUseDeviceFlow(args: Args) {
  if (optionalFlag(args, "browser") && optionalFlag(args, "device")) {
    throw new Error("Pass either --browser or --device, not both.")
  }
  if (optionalFlag(args, "browser")) return false
  if (optionalFlag(args, "device")) return true
  return Boolean(
    process.env.SSH_CONNECTION ||
    process.env.SSH_TTY ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
}

async function browserCredential({
  config,
  timeoutMs,
  forceBrowser,
}: {
  config: CliAuthConfig
  timeoutMs: number
  forceBrowser: boolean
}): Promise<OAuthCredential | null> {
  const state = base64Url(randomBytes(32))
  const nonce = base64Url(randomBytes(32))
  const codeVerifier = base64Url(randomBytes(48))
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest()
  )
  let callback
  try {
    callback = await createLoopbackCallback({ state, timeoutMs })
  } catch (error) {
    if (forceBrowser) throw error
    return null
  }
  const url = buildAuthorizationUrl({
    config,
    redirectUri: callback.redirectUri,
    state,
    nonce,
    codeChallenge,
  })
  const opened = await openBrowser(url.toString())
  if (!opened && !forceBrowser) {
    await callback.close()
    return null
  }
  if (!opened) console.log(`Open this URL to log in:\n${url}`)
  else console.log("Waiting for browser login...")
  const code = await callback.waitForCode()
  return exchangeAuthorizationCode({
    config,
    code,
    redirectUri: callback.redirectUri,
    codeVerifier,
  })
}

async function deviceCredential(config: CliAuthConfig, timeoutMs: number) {
  const authorization = await startDeviceAuthorization(config)
  console.log(`Open ${authorization.verificationUri}`)
  console.log(`Enter code: ${authorization.userCode}`)
  if (authorization.verificationUriComplete) {
    console.log(`Direct link: ${authorization.verificationUriComplete}`)
  }
  console.log("Waiting for device authorization...")
  return pollDeviceTokens({ config, authorization, timeoutMs })
}

async function authenticatedData<T>({
  apiUrl,
  path,
  accessToken,
  method = "GET",
  body,
}: {
  apiUrl: string
  path: string
  accessToken: string
  method?: string
  body?: unknown
}): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T
    error?: { message?: string }
  }
  if (!response.ok || payload.data === undefined) {
    throw new Error(
      payload.error?.message ?? `Onyx API request failed (${response.status})`
    )
  }
  return payload.data
}

export function resolveRequestedTeam(teams: CliTeam[], requested: string) {
  const byId = teams.find((team) => team.id === requested)
  if (byId) return byId
  const matches = teams.filter(
    (team) => team.name.toLowerCase() === requested.toLowerCase()
  )
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(
      `Team name "${requested}" is ambiguous. Pass one of these team IDs: ${matches
        .map((team) => team.id)
        .join(", ")}`
    )
  }
  throw new Error(
    `Team "${requested}" was not found. Available teams: ${teams
      .map((team) => `${team.name} (${team.id})`)
      .join(", ")}`
  )
}

async function chooseTeam(
  teams: CliTeam[],
  requested?: string
): Promise<CliTeam> {
  if (teams.length === 0) throw new Error("This account has no Onyx teams.")
  if (requested) return resolveRequestedTeam(teams, requested)!
  if (teams.length === 1) return teams[0]!
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "This account belongs to multiple teams. Pass --team <team-id-or-name>."
    )
  }
  console.log("Choose a team:")
  teams.forEach((team, index) => console.log(`  ${index + 1}. ${team.name}`))
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const answer = await prompt.question(`Team [1-${teams.length}]: `)
    const index = Number(answer) - 1
    if (!Number.isInteger(index) || !teams[index]) {
      throw new Error("Invalid team selection")
    }
    return teams[index]
  } finally {
    prompt.close()
  }
}

async function revokeOldProfile(profile: CliProfile | undefined) {
  if (!profile) return
  try {
    const { accessTokenForProfile } = await import("../lib/oauth-credentials")
    const token = await accessTokenForProfile({ name: "previous", profile })
    await fetch(`${profile.apiUrl}/api/v1/cli/auth/session`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        ...(profile.cliSessionId
          ? { "x-onyx-cli-session-id": profile.cliSessionId }
          : {}),
      },
    })
  } catch {
    // The prior session remains remotely revocable from Settings.
  } finally {
    await deleteCredential(profile.credentialId)
  }
}

export async function commandLogin(args: Args) {
  for (const removed of ["refresh", "print-url", "port"]) {
    if (args.options[removed] !== undefined) {
      throw new Error(
        `--${removed} was removed; use onyx login --browser or --device.`
      )
    }
  }
  const reset = await resetUnsupportedConfigForLogin()
  if (reset) {
    console.warn(
      "Legacy CLI profiles were removed. Complete login to create a secure session."
    )
  }
  const apiUrl = await loginBaseUrl(args)
  const timeoutMs = Number(args.options.timeout ?? 600_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds")
  }
  const authConfig = await fetchCliAuthConfig(apiUrl)
  const forceBrowser = optionalFlag(args, "browser")
  let flow: "browser" | "device" = shouldUseDeviceFlow(args)
    ? "device"
    : "browser"
  let credential =
    flow === "browser"
      ? await browserCredential({ config: authConfig, timeoutMs, forceBrowser })
      : null
  if (!credential) {
    flow = "device"
    credential = await deviceCredential(authConfig, timeoutMs)
  }

  const teams = await authenticatedData<CliTeam[]>({
    apiUrl,
    path: "/api/v1/cli/auth/teams",
    accessToken: credential.accessToken,
  })
  const team = await chooseTeam(teams, args.options.team)
  const cliSessionId = randomUUID()
  const session = await authenticatedData<BoundSession>({
    apiUrl,
    path: "/api/v1/cli/auth/session",
    accessToken: credential.accessToken,
    method: "POST",
    body: {
      sessionId: cliSessionId,
      teamId: team.id,
      deviceName: args.options["device-name"] ?? hostname(),
      platform: `${platform()} ${release()}`,
      authFlow: flow,
    },
  })

  const config = await readConfig()
  const profileName = profileNameForLoginResult({
    config,
    apiUrl,
    teamId: session.teamId,
    teamName: session.teamName,
  })
  const previous = config.profiles[profileName]
  const credentialId = randomUUID()
  try {
    const credentialStore = await writeCredential(credentialId, credential)
    const showCredentialFallbackWarning =
      credentialStore === "file" && !config.credentialFallbackWarningShownAt
    await writeConfig({
      ...config,
      ...(showCredentialFallbackWarning
        ? { credentialFallbackWarningShownAt: new Date().toISOString() }
        : {}),
      profiles: {
        ...config.profiles,
        [profileName]: {
          apiUrl,
          cliSessionId: session.id,
          credentialId,
          credentialStore,
          teamId: session.teamId,
          teamName: session.teamName,
          userId: session.userId,
          ...(previous?.worker ? { worker: previous.worker } : {}),
          updatedAt: new Date().toISOString(),
        },
      },
      currentProfile: profileName,
    })
    if (showCredentialFallbackWarning) {
      console.warn(
        "No native credential store was available; OAuth tokens are stored in a permission-restricted local file."
      )
    }
  } catch (error) {
    await deleteCredential(credentialId)
    await fetch(`${apiUrl}/api/v1/cli/auth/session`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "x-onyx-cli-session-id": session.id,
      },
    }).catch(() => undefined)
    throw error
  }
  await revokeOldProfile(previous)
  console.log(
    `Logged in profile ${profileName} for ${session.teamName} (${session.teamId}) at ${apiUrl}`
  )
}
