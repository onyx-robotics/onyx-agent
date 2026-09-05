/**
 * Development probe (not shipped): does WorkOS Connect echo an OIDC `nonce`
 * through the device authorization flow, and what does the refresh grant
 * return? Answers decide whether headless logins can use the standard
 * nonce-bound freshness proof.
 *
 *   bun scripts/probe-workos-device-nonce.ts --api-url http://localhost:3000 [--browser [--print-url]]
 */
import { createHash, randomBytes } from "node:crypto"

import { createLoopbackCallback, openBrowser } from "../src/lib/login"
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchCliAuthConfig,
  pollDeviceTokens,
  refreshOAuthCredential,
  startDeviceAuthorization,
  type OAuthTokenResponse,
} from "../src/lib/oauth-client"

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function decode(token: string | undefined) {
  if (!token) return null
  const [, payload] = token.split(".")
  return payload
    ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >)
    : null
}

function report(label: string, response: OAuthTokenResponse, nonce: string) {
  const claims = decode(response.idToken)
  console.log(`\n== ${label} ==`)
  console.log(`id_token returned: ${response.idToken ? "yes" : "no"}`)
  if (claims) {
    console.log(`id_token.nonce === sent nonce: ${claims.nonce === nonce}`)
    console.log(`id_token.aud: ${JSON.stringify(claims.aud)}`)
    console.log(`id_token.sid: ${String(claims.sid)}`)
    console.log(`id_token.iat: ${String(claims.iat)}  auth_time: ${String(claims.auth_time)}`)
  }
  const access = decode(response.accessToken)
  console.log(`access_token.sid: ${String(access?.sid)} client_id: ${String(access?.client_id)}`)
}

const apiUrl = option("api-url") ?? "http://localhost:3000"
const config = await fetchCliAuthConfig(apiUrl)
const nonce = randomBytes(32).toString("base64url")
let response: OAuthTokenResponse

if (process.argv.includes("--browser")) {
  const state = randomBytes(16).toString("base64url")
  const codeVerifier = randomBytes(48).toString("base64url")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const callback = await createLoopbackCallback({ state, timeoutMs: 600_000 })
  const url = buildAuthorizationUrl({
    config,
    redirectUri: callback.redirectUri,
    state,
    nonce,
    codeChallenge,
  })
  if (process.argv.includes("--print-url") || !(await openBrowser(url.toString()))) {
    console.log(`Open: ${url}`)
  }
  const code = await callback.waitForCode()
  response = await exchangeAuthorizationCode({
    config,
    code,
    redirectUri: callback.redirectUri,
    codeVerifier,
  })
  report("browser PKCE", response, nonce)
} else {
  const authorization = await startDeviceAuthorization(config, { nonce })
  console.log(`Open ${authorization.verificationUri} and enter ${authorization.userCode}`)
  response = await pollDeviceTokens({ config, authorization, timeoutMs: 600_000 })
  report("device authorization", response, nonce)
}

const refreshed = await refreshOAuthCredential({ config, credential: response })
report("refresh_token grant", refreshed, nonce)

// A provider that accepted a fresh nonce on refresh would defeat the proof.
const probeNonce = randomBytes(32).toString("base64url")
const withNonce = await fetch(config.tokenEndpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: config.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshed.refreshToken,
    nonce: probeNonce,
  }),
})
const payload = (await withNonce.json().catch(() => ({}))) as { id_token?: string }
const claims = decode(payload.id_token)
console.log(`\n== refresh with a new nonce parameter ==`)
console.log(`status: ${withNonce.status}; id_token nonce equals NEW nonce: ${claims?.nonce === probeNonce} (must be false)`)
