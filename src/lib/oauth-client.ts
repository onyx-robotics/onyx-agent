import type { OAuthCredential } from "./credential-store"

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

export async function fetchCliAuthConfig(
  apiUrl: string
): Promise<CliAuthConfig> {
  const response = await fetch(`${apiUrl}/api/v1/cli/auth/config`, {
    headers: { accept: "application/json" },
  })
  const payload = await responseJson(response)
  if (!response.ok) {
    throw new Error(
      `Unable to load CLI authentication configuration (${response.status})`
    )
  }
  const data = payload.data as Partial<CliAuthConfig> | undefined
  if (
    !data ||
    typeof data.clientId !== "string" ||
    typeof data.authorizationEndpoint !== "string" ||
    typeof data.tokenEndpoint !== "string" ||
    typeof data.deviceAuthorizationEndpoint !== "string" ||
    !Array.isArray(data.scopes)
  ) {
    throw new Error(
      "Onyx server returned invalid CLI authentication configuration"
    )
  }
  return data as CliAuthConfig
}

async function tokenRequest(
  endpoint: string,
  body: URLSearchParams,
  previousRefreshToken?: string
): Promise<OAuthCredential> {
  let response: Response
  try {
    response = await fetch(endpoint, {
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
  config: CliAuthConfig
): Promise<DeviceAuthorization> {
  const response = await fetch(config.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopes.join(" "),
    }),
  })
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
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
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
        intervalMs += 5_000
        continue
      }
      if (error.transient) continue
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
  config: CliAuthConfig
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
