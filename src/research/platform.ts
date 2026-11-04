/**
 * The platform, as the runtime uses it: the SDK with the run's key. A run's key is a run key
 * (docs/auth.md, "Run keys"): the supervisor trades the user's sign-in (`onyx login`'s, or
 * ONYX_TOKEN) for it, keeps it in the run's directory and renews it, and every agent's command
 * reads it from there. Everything the run does is by that key: its jobs are its own, taken only by
 * its own runner. ONYX_API_KEY instead uses that key as it is.
 *
 * Items the runtime makes carry a source key under `research` (`onyx.` systems are the platform's
 * own), so making one again (a restart, a retried tool call) is the same item.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { OnyxClient } from "../sdk"

export const SOURCE = "research"
const KEY_FILE = "run-key.json"
/** a run key works 4 hours: renewed once an hour, so a missed renewal or two costs nothing */
export const RENEW_EVERY_MS = 60 * 60_000

export interface RunKeyFile {
  url: string
  token: string
  expiresAt: number
  agentId: string
}

/** The user's sign-in: ONYX_TOKEN with ONYX_API_URL, or the CLI's current profile (`onyx login`). */
export function signIn(): { url: string; token: string } {
  const url = process.env.ONYX_API_URL
  if (process.env.ONYX_TOKEN && url) return { url, token: process.env.ONYX_TOKEN }
  const path =
    process.env.ONYX_CONFIG ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? homedir(), ".config"),
      "onyx",
      "config.json"
    )
  if (existsSync(path)) {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as {
      current?: string | null
      profiles?: Record<string, { url?: string; token?: string }>
    }
    const p = cfg.current ? cfg.profiles?.[cfg.current] : undefined
    if (p?.url && p.token) return { url: url ?? p.url, token: p.token }
  }
  throw new Error("not signed in: run `onyx login` (or set ONYX_API_URL and ONYX_TOKEN)")
}

/** A run key for `run`, for the signed-in user (RFC 8693 token exchange). */
export async function exchangeRunKey(run: string): Promise<RunKeyFile> {
  const { url, token } = signIn()
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: token,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience: run,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    agent_id?: string
    error_description?: string
  }
  if (!res.ok || !body.access_token)
    throw new Error(`couldn't get a key for the run: ${body.error_description ?? res.status}`)
  return {
    url,
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 0) * 1000,
    agentId: body.agent_id ?? "",
  }
}

/** The run's key, renewed into its directory (written whole, then renamed). */
export async function renewRunKey(dir: string, run: string): Promise<RunKeyFile> {
  const key = await exchangeRunKey(run)
  const p = join(dir, KEY_FILE)
  writeFileSync(`${p}.tmp`, JSON.stringify(key), { mode: 0o600 })
  renameSync(`${p}.tmp`, p)
  return key
}

/**
 * The SDK as the run: its current key (ONYX_RESEARCH_RUN's, or `dir`'s), else ONYX_API_KEY. Read
 * when called, so a command after a renewal has the new key.
 */
export function client(dir = process.env.ONYX_RESEARCH_RUN): OnyxClient {
  const p = dir ? join(dir, KEY_FILE) : null
  if (p && existsSync(p)) {
    const key = JSON.parse(readFileSync(p, "utf8")) as RunKeyFile
    return new OnyxClient({ baseUrl: key.url, token: key.token })
  }
  const baseUrl = process.env.ONYX_API_URL
  const token = process.env.ONYX_API_KEY
  if (!baseUrl || !token)
    throw new Error("no key for this run: start it with `onyx research run` (or set ONYX_API_KEY)")
  return new OnyxClient({ baseUrl, token })
}

/** An item by its source key: made if it isn't there, its id either way. */
export async function upsert(
  onyx: OnyxClient,
  key: string,
  item: {
    type: string
    name: string
    summary?: string
    status?: string
    props?: Record<string, unknown>
    createdBy?: string
  }
): Promise<string> {
  const source = { system: SOURCE, key }
  await onyx.ingest({ items: [{ source, ...item }] })
  const found = await onyx.resolve(source)
  return found.id
}

export type AgentRole = "orchestrator" | "base" | "var_op" | "worker"

/** An agent of the run, as an ai_agent the graph can name as an author. */
export function agentItem(run: string, name: string, role: AgentRole, model: string) {
  return {
    type: "ai_agent",
    name: `${run} · ${name}`,
    props: { agent_role: role, model, provider: "anthropic" },
  }
}
