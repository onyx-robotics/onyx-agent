import { createHash, randomBytes, randomUUID } from "node:crypto"
import { hostname, platform, release } from "node:os"
import { createInterface } from "node:readline/promises"

import { ApiError } from "../lib/api"
import { confirmApiUrlTrust } from "../lib/api-url-trust"
import { optionalFlag, type Args } from "../lib/args"
import {
  apiBaseUrl,
  migrateLegacyConfigForLogin,
  normalizeProfileName,
  readConfig,
  type CliProfile,
  type Config,
  type LegacyProfileMetadata,
  writeConfig,
} from "../lib/config"
import { deleteCredential, writeCredential } from "../lib/credential-store"
import { createLoopbackCallback, openBrowser } from "../lib/login"
import { freshnessForFlow, type LoginFreshness } from "../lib/login-freshness"
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchCliAuthConfig,
  persistableCredential,
  type CliAuthConfig,
  type OAuthTokenResponse,
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
  legacyProfiles = {},
  apiUrl,
  teamId,
  teamName,
}: {
  config: Config
  legacyProfiles?: Record<string, LegacyProfileMetadata>
  apiUrl: string
  teamId: string
  teamName: string
}) {
  const existing = Object.entries(config.profiles).find(
    ([, profile]) => profile.teamId === teamId && profile.apiUrl === apiUrl
  )
  if (existing) return existing[0]
  const legacy = Object.entries(legacyProfiles).find(
    ([name, profile]) =>
      profile.teamId === teamId &&
      profile.apiUrl === apiUrl &&
      !config.profiles[name]
  )
  if (legacy) return legacy[0]
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
  nonce,
  timeoutMs,
  forceBrowser,
}: {
  config: CliAuthConfig
  nonce: string
  timeoutMs: number
  forceBrowser: boolean
}): Promise<OAuthTokenResponse | null> {
  const state = base64Url(randomBytes(32))
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

async function deviceCredential(
  freshness: LoginFreshness,
  timeoutMs: number
) {
  const device = freshness.device
  if (!device) {
    throw new Error("Onyx server did not start device authorization")
  }
  console.log(`Open ${device.verificationUri}`)
  console.log(`Enter code: ${device.userCode}`)
  if (device.verificationUriComplete) {
    console.log(`Direct link: ${device.verificationUriComplete}`)
  }
  console.log("Waiting for device authorization...")
  return device.poll({ timeoutMs })
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
  const payload = (await response.json().catch(() => null)) as {
    data?: T
  } | null
  if (!response.ok || !payload || payload.data === undefined) {
    throw new ApiError(method, path, response.status, payload)
  }
  return payload.data
}

function loginFailureMessage(error: unknown) {
  if (!(error instanceof ApiError)) return null
  switch (error.code) {
    case "cli_login_attempt_expired":
      return "Login took too long; run `onyx login` again."
    case "cli_login_attempt_consumed":
      return "This login attempt was already used; run `onyx login` again."
    case "cli_login_attempt_invalid":
      return "Onyx could not verify this login; run `onyx login` again."
    case "cli_auth_temporarily_unavailable":
      return "Onyx could not reach its identity provider; try again shortly."
    case "cli_token_invalid":
      return "WorkOS returned a token Onyx does not accept for the CLI; run `onyx login` again."
    default:
      return null
  }
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

async function revokeRemoteSession({
  apiUrl,
  accessToken,
  cliSessionId,
}: {
  apiUrl: string
  accessToken: string
  cliSessionId?: string
}) {
  await fetch(`${apiUrl}/api/v1/cli/auth/session`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(cliSessionId ? { "x-onyx-cli-session-id": cliSessionId } : {}),
    },
  }).catch(() => undefined)
}

async function revokeOldProfile(profile: CliProfile | undefined) {
  if (!profile) return
  try {
    const { accessTokenForProfile } = await import("../lib/oauth-credentials")
    const token = await accessTokenForProfile({ name: "previous", profile })
    await revokeRemoteSession({
      apiUrl: profile.apiUrl,
      accessToken: token,
      cliSessionId: profile.cliSessionId,
    })
  } catch {
    // The prior session remains remotely revocable from Settings.
  } finally {
    await deleteCredential(profile.credentialId)
  }
}

async function removeStaleLegacyCredentials(
  migration: Awaited<ReturnType<typeof migrateLegacyConfigForLogin>>
) {
  for (const stale of migration.staleCredentials) {
    try {
      const { readCredential } = await import("../lib/credential-store")
      const credential = await readCredential(
        stale.credentialId,
        stale.credentialStore
      )
      if (credential && credential.expiresAt > Date.now()) {
        await revokeRemoteSession({
          apiUrl: stale.apiUrl,
          accessToken: credential.accessToken,
          cliSessionId: stale.cliSessionId,
        })
      }
    } catch {
      // Best effort; the old session stays revocable from Settings.
    }
    await deleteCredential(stale.credentialId).catch(() => undefined)
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
  const migration = await migrateLegacyConfigForLogin()
  if (migration.migrated) {
    console.warn(
      `Migrated your Onyx CLI config to the current login format. A sanitized backup (no keys or tokens) was written to ${migration.backupPath}.`
    )
    await removeStaleLegacyCredentials(migration)
  }

  const apiUrl = await loginBaseUrl(args)
  const timeoutMs = Number(args.options.timeout ?? 600_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds")
  }
  const authConfig = await fetchCliAuthConfig(apiUrl)
  await confirmApiUrlTrust({ apiUrl, config: authConfig, args })

  const forceBrowser = optionalFlag(args, "browser")
  let flow: "browser" | "device" = shouldUseDeviceFlow(args)
    ? "device"
    : "browser"
  let freshness: LoginFreshness = await freshnessForFlow(flow, { apiUrl })
  let credential: OAuthTokenResponse | null =
    flow === "browser"
      ? await browserCredential({
          config: authConfig,
          nonce: freshness.nonce,
          timeoutMs,
          forceBrowser,
        })
      : null
  if (!credential) {
    if (flow === "browser") {
      // The browser attempt simply expires server-side; device login needs
      // its own attempt so the flow recorded with the session is accurate.
      flow = "device"
      freshness = await freshnessForFlow(flow, { apiUrl })
    }
    credential = await deviceCredential(freshness, timeoutMs)
  }
  const proof = freshness.proof(credential)

  let teams: CliTeam[]
  let session: BoundSession
  try {
    teams = await authenticatedData<CliTeam[]>({
      apiUrl,
      path: "/api/v1/cli/auth/teams",
      accessToken: credential.accessToken,
    })
    const team = await chooseTeam(teams, args.options.team)
    session = await authenticatedData<BoundSession>({
      apiUrl,
      path: "/api/v1/cli/auth/session",
      accessToken: credential.accessToken,
      method: "POST",
      body: {
        sessionId: randomUUID(),
        attemptId: proof.attemptId,
        idToken: proof.idToken,
        teamId: team.id,
        deviceName: args.options["device-name"] ?? hostname(),
        platform: `${platform()} ${release()}`,
        authFlow: flow,
      },
    })
  } catch (error) {
    const message = loginFailureMessage(error)
    if (message) throw new Error(message)
    throw error
  }

  const config = await readConfig()
  const profileName = profileNameForLoginResult({
    config,
    legacyProfiles: migration.legacyProfiles,
    apiUrl,
    teamId: session.teamId,
    teamName: session.teamName,
  })
  const previous = config.profiles[profileName]
  const legacy = Object.values(migration.legacyProfiles).find(
    (profile) => profile.teamId === session.teamId && profile.apiUrl === apiUrl
  )
  const worker = previous?.worker ?? legacy?.worker
  const credentialId = randomUUID()
  try {
    const credentialStore = await writeCredential(
      credentialId,
      persistableCredential(credential)
    )
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
          oauth: {
            issuer: authConfig.issuer,
            clientId: authConfig.clientId,
            tokenEndpoint: authConfig.tokenEndpoint,
            scopes: [...authConfig.scopes],
          },
          teamId: session.teamId,
          teamName: session.teamName,
          userId: session.userId,
          ...(worker ? { worker } : {}),
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
    await revokeRemoteSession({
      apiUrl,
      accessToken: credential.accessToken,
      cliSessionId: session.id,
    })
    throw error
  }
  await revokeOldProfile(previous)
  console.log(
    `Logged in profile ${profileName} for ${session.teamName} (${session.teamId}) at ${apiUrl}`
  )
}
