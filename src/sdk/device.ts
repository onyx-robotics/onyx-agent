/**
 * Signing in a device (RFC 8628), as `onyx login` does: ask the server for a code, have a person
 * approve it in the browser, poll for the token. No token is needed to start; the one it ends with
 * is a personal token acting as that person (kind "cli").
 */
import { OnyxNetworkError } from "./errors"

export interface DeviceCode {
  deviceCode: string
  /** what the person checks against the browser: BCDF-GHJK */
  userCode: string
  verificationUri: string
  /** verificationUri with the code in it */
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface DeviceToken {
  token: string
  scopes: string[]
  /** seconds until it expires if unused (it slides with use) */
  expiresIn: number
  org: { id: string; name: string; slug: string }
}

/** The person turned it down, the code expired, or the server refused it: start again. */
export class DeviceAuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "DeviceAuthorizationError"
  }
}

interface Endpoint {
  baseUrl: string
  fetch?: typeof fetch
}

async function post(ep: Endpoint, path: string, params: Record<string, string | undefined>) {
  const url = `${ep.baseUrl.replace(/\/+$/, "")}/api/v1${path}`
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v)
  try {
    return await (ep.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new OnyxNetworkError(url, e)
  }
}

async function oauthError(res: Response): Promise<DeviceAuthorizationError> {
  // an OAuth error ({error, error_description}), or the API's envelope ({error: {message}})
  const body = (await res.json().catch(() => ({}))) as {
    error?: string | { message?: string }
    error_description?: string
  }
  if (typeof body.error === "string")
    return new DeviceAuthorizationError(body.error, body.error_description ?? body.error)
  return new DeviceAuthorizationError(
    `http_${res.status}`,
    (body.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`
  )
}

/** Ask for a code. `client` is what the approval page shows about this machine. */
export async function startDeviceAuthorization(
  opts: Endpoint & {
    client?: { name?: string; hostname?: string; os?: string; version?: string }
    scopes?: string[]
    /** the org the person probably means (a slug), preselected on the page */
    org?: string
  }
): Promise<DeviceCode> {
  const res = await post(opts, "/oauth/device", {
    client_id: "onyx-cli",
    scope: opts.scopes?.join(" "),
    client_name: opts.client?.name,
    hostname: opts.client?.hostname,
    os: opts.client?.os,
    version: opts.client?.version,
    org: opts.org,
  })
  if (!res.ok) throw await oauthError(res)
  const b = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    verification_uri_complete: string
    expires_in: number
    interval: number
  }
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: b.verification_uri,
    verificationUriComplete: b.verification_uri_complete,
    expiresIn: b.expires_in,
    interval: b.interval,
  }
}

/**
 * Poll until the person decides: every `interval` seconds (longer when told to slow down), until
 * the code expires. A lost connection or a server error doesn't end it: the next poll tries again.
 */
export async function pollDeviceToken(
  opts: Endpoint & {
    code: Pick<DeviceCode, "deviceCode" | "interval" | "expiresIn">
    sleep?: (ms: number) => Promise<void>
    signal?: AbortSignal
  }
): Promise<DeviceToken> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const deadline = Date.now() + opts.code.expiresIn * 1000
  let interval = opts.code.interval
  for (;;) {
    if (opts.signal?.aborted) throw new DeviceAuthorizationError("cancelled", "cancelled")
    if (Date.now() > deadline)
      throw new DeviceAuthorizationError("expired_token", "the code expired: start again")
    await sleep(interval * 1000)
    let res: Response
    try {
      res = await post(opts, "/oauth/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: opts.code.deviceCode,
        client_id: "onyx-cli",
      })
    } catch (e) {
      if (e instanceof OnyxNetworkError) continue
      throw e
    }
    if (res.ok) {
      const b = (await res.json()) as {
        access_token: string
        scope: string
        expires_in: number
        org: { id: string; name: string; slug: string }
      }
      return {
        token: b.access_token,
        scopes: b.scope.split(" ").filter(Boolean),
        expiresIn: b.expires_in,
        org: b.org,
      }
    }
    if (res.status >= 500 || res.status === 429) continue
    const err = await oauthError(res)
    if (err.code === "authorization_pending") continue
    if (err.code === "slow_down") {
      interval += 5
      continue
    }
    throw err
  }
}

/** Revoke a token (RFC 7009): the server answers the same whether or not it was valid. */
export async function revokeToken(opts: Endpoint & { token: string }): Promise<void> {
  const res = await post(opts, "/oauth/revoke", { token: opts.token })
  if (!res.ok) throw await oauthError(res)
}
