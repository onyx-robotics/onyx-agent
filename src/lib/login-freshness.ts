import type { OAuthTokenResponse } from "./oauth-client"

/**
 * Freshness proof for creating a CLI session binding.
 *
 * WorkOS Connect reports the shared application consent as `sid`, so the
 * Onyx server cannot tell a brand-new login from a refreshed token by the
 * access token alone. Instead the server issues a one-time OIDC nonce; the
 * CLI carries it through the authorization request and hands back the
 * resulting ID token. A nonce can only enter an ID token through that
 * request, never through the refresh grant, so a stolen refresh token cannot
 * mint a new binding once its session is revoked.
 *
 * This module is the single seam for how each flow obtains that proof.
 */
export type LoginFreshnessProof = { attemptId: string; idToken: string }

/**
 * Brokered device authorization. WorkOS does not echo a nonce through the
 * device flow, so Onyx starts device authorization, keeps only a hash of the
 * device code, and performs the token exchange itself when the CLI polls;
 * the server therefore witnesses the ceremony and records who it was for.
 */
export type BrokeredDeviceAuthorization = {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  poll: (options: { timeoutMs: number }) => Promise<OAuthTokenResponse>
}

export type LoginFreshness = {
  attemptId: string
  nonce: string
  expiresAt: string
  device?: BrokeredDeviceAuthorization
  proof: (credential: OAuthTokenResponse) => LoginFreshnessProof
}

export type LoginFlow = "browser" | "device"

type AttemptPayload = {
  data?: {
    attemptId?: unknown
    nonce?: unknown
    expiresAt?: unknown
    device?: {
      deviceCode?: unknown
      userCode?: unknown
      verificationUri?: unknown
      verificationUriComplete?: unknown
      expiresIn?: unknown
      interval?: unknown
    }
  }
  error?: { code?: string; message?: string }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return null
  try {
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function createServerLoginAttempt({
  apiUrl,
  flow,
}: {
  apiUrl: string
  flow: LoginFlow
}): Promise<LoginFreshness> {
  const response = await fetch(`${apiUrl}/api/v1/cli/auth/attempts`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ flow }),
  })
  const payload = await readJson<AttemptPayload>(response)
  if (response.status === 429) {
    throw new Error(
      "Too many login attempts from this network; wait a few minutes and try again."
    )
  }
  if (response.status === 503) {
    throw new Error(
      "Onyx could not start a login attempt right now; try again shortly."
    )
  }
  if (!response.ok) {
    throw new Error(
      payload.error?.message ??
        `Unable to start an Onyx login attempt (${response.status})`
    )
  }
  const data = payload.data
  if (
    !data ||
    typeof data.attemptId !== "string" ||
    typeof data.nonce !== "string" ||
    data.nonce.length < 32 ||
    typeof data.expiresAt !== "string"
  ) {
    throw new Error("Onyx server returned an invalid login attempt")
  }
  const attemptId = data.attemptId
  const nonce = data.nonce
  const device =
    flow === "device"
      ? brokeredDevice({ apiUrl, attemptId, raw: data.device })
      : undefined
  return {
    attemptId,
    nonce,
    expiresAt: data.expiresAt,
    ...(device ? { device } : {}),
    proof(credential) {
      if (!credential.idToken) {
        throw new Error(
          "WorkOS did not return an ID token; cannot prove login freshness. Run `onyx login` again or contact support."
        )
      }
      if (flow === "browser") {
        // Standard OIDC client hygiene: reject a mismatched nonce locally
        // before the server does. Device logins are proven server-side.
        const claims = decodeJwtPayload(credential.idToken)
        if (claims?.nonce !== nonce) {
          throw new Error(
            "WorkOS returned an ID token for a different login attempt; run `onyx login` again."
          )
        }
      }
      return { attemptId, idToken: credential.idToken }
    },
  }
}

function brokeredDevice({
  apiUrl,
  attemptId,
  raw,
}: {
  apiUrl: string
  attemptId: string
  raw: NonNullable<AttemptPayload["data"]>["device"]
}): BrokeredDeviceAuthorization {
  if (
    !raw ||
    typeof raw.deviceCode !== "string" ||
    typeof raw.userCode !== "string" ||
    typeof raw.verificationUri !== "string" ||
    typeof raw.expiresIn !== "number" ||
    typeof raw.interval !== "number"
  ) {
    throw new Error("Onyx server returned an invalid device login attempt")
  }
  const deviceCode = raw.deviceCode
  const initialInterval = Math.max(1, raw.interval)
  const expiresIn = raw.expiresIn
  return {
    userCode: raw.userCode,
    verificationUri: raw.verificationUri,
    ...(typeof raw.verificationUriComplete === "string"
      ? { verificationUriComplete: raw.verificationUriComplete }
      : {}),
    expiresIn,
    async poll({ timeoutMs }) {
      const deadline = Date.now() + Math.min(timeoutMs, expiresIn * 1_000)
      let intervalMs = initialInterval * 1_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
        let response: Response
        try {
          response = await fetch(
            `${apiUrl}/api/v1/cli/auth/attempts/${attemptId}/device`,
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
              },
              body: JSON.stringify({ deviceCode }),
            }
          )
        } catch {
          // Connection-level failures are transient within the deadline; the
          // user keeps their place in the ceremony.
          continue
        }
        const payload = await readJson<{
          data?: {
            status?: unknown
            retryAfterSeconds?: unknown
            tokens?: {
              accessToken?: unknown
              refreshToken?: unknown
              idToken?: unknown
              expiresIn?: unknown
            }
          }
          error?: { code?: string; message?: string }
        }>(response)
        if (response.status === 503 || response.status === 429) {
          // Onyx or WorkOS is briefly unavailable; keep the user's place.
          continue
        }
        if (!response.ok) {
          throw new Error(
            deviceFailureMessage(payload.error?.code) ??
              payload.error?.message ??
              `Device login failed (${response.status})`
          )
        }
        const data = payload.data
        if (data?.status === "pending") {
          if (typeof data.retryAfterSeconds === "number") {
            intervalMs = Math.max(1, data.retryAfterSeconds) * 1_000
          }
          continue
        }
        const tokens = data?.tokens
        if (
          data?.status !== "authorized" ||
          !tokens ||
          typeof tokens.accessToken !== "string" ||
          typeof tokens.refreshToken !== "string" ||
          typeof tokens.idToken !== "string" ||
          typeof tokens.expiresIn !== "number"
        ) {
          throw new Error("Onyx server returned an invalid device login result")
        }
        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          expiresAt: Date.now() + tokens.expiresIn * 1_000,
        }
      }
      throw new Error("Device authorization expired before login completed")
    },
  }
}

function deviceFailureMessage(code: string | undefined) {
  switch (code) {
    case "cli_authorization_denied":
      return "Device authorization was denied in the browser."
    case "cli_login_attempt_expired":
      return "Device authorization expired; run `onyx login` again."
    case "cli_login_attempt_consumed":
      return "This device login was already completed; run `onyx login` again."
    case "cli_login_attempt_invalid":
      return "Onyx could not verify this device login; run `onyx login` again."
    default:
      return null
  }
}

/**
 * Browser PKCE proves freshness with the server-issued nonce echoed in the ID
 * token. Device login is brokered by Onyx because WorkOS does not echo the
 * nonce through device authorization (verified against the dev environment on
 * 2026-09-04). This is the single seam for either strategy.
 */
export async function freshnessForFlow(
  flow: LoginFlow,
  deps: { apiUrl: string }
): Promise<LoginFreshness> {
  return createServerLoginAttempt({ apiUrl: deps.apiUrl, flow })
}
