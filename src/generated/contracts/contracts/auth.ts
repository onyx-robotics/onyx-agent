// Generated from packages/core/src/contracts/auth.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
import { z } from "zod"

/**
 * The device flow (RFC 8628) that `onyx login` uses: the CLI asks for a code, a person approves it
 * in the browser, and the CLI redeems it for a token. The wire shapes follow the RFC (form or JSON
 * bodies, snake_case, OAuth error codes); Onyx adds what the approval page shows about the machine.
 */

const scope = z.enum(["read", "ingest", "actions", "jobs", "admin"])
/** what a device may ask for: scopes, or `site` alone (a site-runner, approved by an admin as a site) */
const requestScope = z.enum(["read", "ingest", "actions", "jobs", "admin", "site"])

/** POST /api/v1/oauth/device */
export const deviceAuthorizationRequest = z.object({
  client_id: z.string().max(64).optional(),
  /** space-separated scopes asked for; default read, ingest, actions and jobs; or `site` alone */
  scope: z
    .string()
    .max(200)
    .optional()
    .transform((s, c) => {
      if (!s) return undefined
      const parts = s.split(/\s+/).filter(Boolean)
      const bad = parts.filter((p) => !requestScope.safeParse(p).success)
      if (bad.length) {
        c.addIssue({ code: "custom", message: `unknown scope ${bad.join(", ")}` })
        return z.NEVER
      }
      if (parts.includes("site") && parts.length > 1) {
        c.addIssue({ code: "custom", message: "scope site is asked for alone" })
        return z.NEVER
      }
      return parts as z.infer<typeof requestScope>[]
    }),
  /** Onyx: what the machine says it is, shown on the approval page (untrusted) */
  client_name: z.string().trim().max(100).optional(),
  hostname: z.string().trim().max(255).optional(),
  os: z.string().trim().max(100).optional(),
  version: z.string().trim().max(50).optional(),
  /** Onyx: the org the person probably means (a slug), preselected on the page */
  org: z.string().trim().max(100).optional(),
})
export type DeviceAuthorizationRequest = z.infer<typeof deviceAuthorizationRequest>

export interface DeviceAuthorizationResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** POST /api/v1/oauth/token */
export const deviceTokenRequest = z.object({
  grant_type: z.string(),
  device_code: z.string().min(1).max(200),
  client_id: z.string().max(64).optional(),
})

export interface DeviceTokenResponse {
  access_token: string
  token_type: "Bearer"
  /** seconds until it expires if unused (it slides with use) */
  expires_in: number
  scope: string
  /** Onyx: the org the token belongs to */
  org: { id: string; name: string; slug: string }
  /** Onyx, for a site-runner (scope site): the site it was approved as */
  site_id?: string
  site_name?: string
}

/** OAuth token exchange (RFC 8693): a member's sign-in for a run key (docs/auth.md, "Run keys"). */
export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"

/** POST /api/v1/oauth/token, the exchange */
export const tokenExchangeRequest = z.object({
  grant_type: z.literal(TOKEN_EXCHANGE_GRANT),
  /** the member's personal token (`onyx login`'s) */
  subject_token: z.string().min(1).max(500),
  subject_token_type: z.literal(ACCESS_TOKEN_TYPE),
  requested_token_type: z.literal(ACCESS_TOKEN_TYPE).optional(),
  /** the run it's for: the same name again is the same run's agent and runner */
  audience: z.string().min(1).max(100),
  /** space-separated: read ingest jobs run (the default: all four) */
  scope: z.string().max(200).optional(),
})

export interface TokenExchangeResponse {
  access_token: string
  issued_token_type: typeof ACCESS_TOKEN_TYPE
  token_type: "Bearer"
  expires_in: number
  scope: string
  /** Onyx: the run's agent, which its runner is and its writes are by */
  agent_id: string
}

/** The RFC's errors while polling, and after. */
export type DeviceTokenError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "invalid_request"
  | "unsupported_grant_type"

/** The approval page's decision (signed in). */
export const deviceApprovalInput = z.object({
  userCode: z.string().min(8).max(20),
  orgId: z.string().uuid(),
  scopes: z.array(scope).optional(),
  /** a site-runner's request (admins only): an existing site to re-approve, or a new site's name */
  site: z
    .union([
      z.object({ id: z.string().uuid() }).strict(),
      z.object({ name: z.string().trim().min(1).max(100) }).strict(),
    ])
    .optional(),
})
export const deviceDenialInput = z.object({ userCode: z.string().min(8).max(20) })

/** POST /api/v1/run-keys/revoke: stop a run's keys now (docs/auth.md, "Run keys") */
export const revokeRunKeysInput = z.object({
  /** the run's agent (its runner), as GET /run-keys and the exchange name it */
  agent: z.string().uuid(),
})
export type RevokeRunKeysInput = z.input<typeof revokeRunKeysInput>

/** GET /api/v1/run-keys: a run, and its keys */
export interface RunKeysRun {
  /** the run's name, as exchanged */
  run: string
  /** the run's agent: its runner */
  agentId: string
  owner: { id: string; email: string; name: string | null }
  /** keys that work now (one, or two while it moves to a new one) */
  live: number
  /** keys kept that no longer work (the purge deletes them after a week, but the newest) */
  ended: number
  firstAt: string
  lastUsedAt: string | null
  /** when its newest live key stops, if it isn't renewed */
  expiresAt: string | null
}
