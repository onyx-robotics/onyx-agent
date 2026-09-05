import type { OAuthCredential } from "./credential-store"
import { authFetch } from "./auth-fetch"

export type CliAuthConfig = {
  clientId: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint: string
  jwksUri: string
  scopes: string[]
  loopbackRedirectUri: string
}

/** Token response; `idToken` is only needed at login to prove freshness. */
export type OAuthTokenResponse = OAuthCredential & { idToken?: string }

export type OAuthEndpointConfig = Pick<
  CliAuthConfig,
  "clientId" | "tokenEndpoint" | "scopes"
>

export type DeviceAuthorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

export class OAuthRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly transient = false
  ) {
    super(message)
    this.name = "OAuthRequestError"
  }
}

async function responseJson(
  response: Response
): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value) {
    throw new Error(`OAuth response did not include ${field}`)
  }
  return value
}

function requiredNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`OAuth response did not include ${field}`)
  }
  return value
}

function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  )
}

/**
 * The API server advertises where to log in; never follow that blindly. Every
 * OAuth endpoint must be HTTPS on the issuer's own origin, and the API itself
 * must be HTTPS unless it is a local development server.
 */
export function validateCliAuthConfig(
  value: unknown,
  { apiUrl }: { apiUrl: string }
): CliAuthConfig {
  const data = value as Partial<CliAuthConfig> | undefined
  if (
    !data ||
    typeof data.clientId !== "string" ||
    !data.clientId ||
    typeof data.issuer !== "string" ||
    typeof data.authorizationEndpoint !== "string" ||
    typeof data.tokenEndpoint !== "string" ||
    typeof data.deviceAuthorizationEndpoint !== "string" ||
    typeof data.jwksUri !== "string" ||
    !Array.isArray(data.scopes) ||
    !data.scopes.every((scope) => typeof scope === "string") ||
    data.loopbackRedirectUri !== "http://127.0.0.1:*/callback"
  ) {
    throw new Error(
      "Onyx server returned invalid CLI authentication configuration"
    )
  }

  let api: URL
  try {
    api = new URL(apiUrl)
  } catch {
    throw new Error(`Invalid Onyx API URL: ${apiUrl}`)
  }
  if (api.protocol !== "https:" && !isLoopbackHost(api.hostname)) {
    throw new Error(
      `Refusing to log in over ${api.protocol.replace(":", "")}; the Onyx API URL must use https (localhost is exempt).`
    )
  }

  let issuer: URL
  try {
    issuer = new URL(data.issuer)
  } catch {
    throw new Error("CLI authentication issuer is not a valid URL")
  }
  if (issuer.protocol !== "https:") {
    throw new Error("CLI authentication issuer must use https")
  }
  for (const [name, endpoint] of [
    ["authorizationEndpoint", data.authorizationEndpoint],
    ["tokenEndpoint", data.tokenEndpoint],
    ["deviceAuthorizationEndpoint", data.deviceAuthorizationEndpoint],
    ["jwksUri", data.jwksUri],
  ] as const) {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new Error(`CLI authentication ${name} is not a valid URL`)
    }
    if (url.protocol !== "https:" || url.origin !== issuer.origin) {
      throw new Error(
        `CLI authentication ${name} must be an https URL on the issuer origin ${issuer.origin}`
      )
    }
  }
  if (
    !data.scopes.includes("openid") ||
    !data.scopes.includes("offline_access")
  ) {
    throw new Error(
      "CLI authentication scopes must include openid and offline_access"
    )
  }
  return {
    clientId: data.clientId,
    issuer: data.issuer,
    authorizationEndpoint: data.authorizationEndpoint,
    tokenEndpoint: data.tokenEndpoint,
    deviceAuthorizationEndpoint: data.deviceAuthorizationEndpoint,
    jwksUri: data.jwksUri,
    scopes: [...data.scopes],
    loopbackRedirectUri: data.loopbackRedirectUri,
  }
}

export async function fetchCliAuthConfig(
  apiUrl: string
): Promise<CliAuthConfig> {
  const response = await authFetch(`${apiUrl}/api/v1/cli/auth/config`, {
    headers: { accept: "application/json" },
  })
  const payload = await responseJson(response)
  if (!response.ok) {
    throw new Error(
      `Unable to load CLI authentication configuration (${response.status})`
    )
  }
  return validateCliAuthConfig(payload.data, { apiUrl })
}

async function tokenRequest(
  endpoint: string,
  body: URLSearchParams,
  previousRefreshToken?: string
): Promise<OAuthTokenResponse> {
  let response: Response
  try {
    response = await authFetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    })
  } catch {
    throw new OAuthRequestError(
      "Unable to reach the authentication server",
      "network_error",
      true
    )
  }
  const payload = await responseJson(response)
  if (!response.ok) {
    const code =
      typeof payload.error === "string" ? payload.error : "oauth_error"
    const description =
      typeof payload.error_description === "string"
        ? payload.error_description
        : `Authentication failed (${response.status})`
    throw new OAuthRequestError(
      description,
      code,
      response.status === 429 || response.status >= 500
    )
  }

  const refreshToken =
    typeof payload.refresh_token === "string"
      ? payload.refresh_token
      : previousRefreshToken
  if (!refreshToken) {
    throw new Error("Authentication response did not include a refresh token")
  }
  const expiresIn = requiredNumber(payload.expires_in, "expires_in")
  return {
    accessToken: requiredString(payload.access_token, "access_token"),
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1_000,
    ...(typeof payload.id_token === "string" && payload.id_token
      ? { idToken: payload.id_token }
      : {}),
  }
}

/** Strips the ID token before a credential is persisted. */
export function persistableCredential(
  response: OAuthTokenResponse
): OAuthCredential {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt: response.expiresAt,
  }
}

export function buildAuthorizationUrl({
  config,
  redirectUri,
  state,
  nonce,
  codeChallenge,
}: {
  config: CliAuthConfig
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
}) {
  const url = new URL(config.authorizationEndpoint)
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", config.scopes.join(" "))
  url.searchParams.set("state", state)
  url.searchParams.set("nonce", nonce)
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url
}

export function exchangeAuthorizationCode({
  config,
  code,
  redirectUri,
  codeVerifier,
}: {
  config: CliAuthConfig
  code: string
  redirectUri: string
  codeVerifier: string
}) {
  return tokenRequest(
    config.tokenEndpoint,
    new URLSearchParams({
      client_id: config.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    })
  )
}

export async function startDeviceAuthorization(
  config: CliAuthConfig,
  { nonce }: { nonce?: string } = {}
): Promise<DeviceAuthorization> {
  let response: Response
  try {
    response = await authFetch(config.deviceAuthorizationEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        scope: config.scopes.join(" "),
        // RFC 8628 defines no nonce; OIDC providers that honor it echo it in
        // the device-flow ID token, which is how headless logins prove
        // freshness to Onyx.
        ...(nonce ? { nonce } : {}),
      }),
    })
  } catch {
    throw new OAuthRequestError(
      "Unable to reach the authentication server",
      "network_error",
      true
    )
  }
  const payload = await responseJson(response)
  if (!response.ok) {
    throw new OAuthRequestError(
      typeof payload.error_description === "string"
        ? payload.error_description
        : `Device authorization failed (${response.status})`,
      typeof payload.error === "string" ? payload.error : "oauth_error",
      response.status === 429 || response.status >= 500
    )
  }
  return {
    deviceCode: requiredString(payload.device_code, "device_code"),
    userCode: requiredString(payload.user_code, "user_code"),
    verificationUri: requiredString(
      payload.verification_uri,
      "verification_uri"
    ),
    ...(typeof payload.verification_uri_complete === "string"
      ? { verificationUriComplete: payload.verification_uri_complete }
      : {}),
    expiresIn: requiredNumber(payload.expires_in, "expires_in"),
    interval: requiredNumber(payload.interval, "interval"),
  }
}

export async function pollDeviceTokens({
  config,
  authorization,
  timeoutMs,
}: {
  config: CliAuthConfig
  authorization: DeviceAuthorization
  timeoutMs: number
}) {
  const deadline =
    Date.now() + Math.min(timeoutMs, authorization.expiresIn * 1_000)
  let intervalMs = Math.max(authorization.interval, 1) * 1_000
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, deadline - Date.now()))
    )
    if (Date.now() >= deadline) break
    try {
      return await tokenRequest(
        config.tokenEndpoint,
        new URLSearchParams({
          client_id: config.clientId,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: authorization.deviceCode,
        })
      )
    } catch (error) {
      if (!(error instanceof OAuthRequestError)) throw error
      if (error.code === "authorization_pending") continue
      if (error.code === "slow_down") {
        intervalMs = Math.min(30_000, intervalMs + 5_000)
        continue
      }
      if (error.transient) {
        intervalMs = Math.min(30_000, Math.max(1_000, intervalMs * 2))
        continue
      }
      throw error
    }
  }
  throw new OAuthRequestError(
    "Device authorization expired before login completed",
    "expired_token"
  )
}

export async function refreshOAuthCredential({
  config,
  credential,
}: {
  config: OAuthEndpointConfig
  credential: OAuthCredential
}) {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await tokenRequest(
        config.tokenEndpoint,
        new URLSearchParams({
          client_id: config.clientId,
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          scope: config.scopes.join(" "),
        }),
        credential.refreshToken
      )
    } catch (error) {
      lastError = error
      if (!(error instanceof OAuthRequestError) || !error.transient) throw error
      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            250 * 2 ** attempt + Math.floor(Math.random() * 100)
          )
        )
      }
    }
  }
  throw lastError
}
