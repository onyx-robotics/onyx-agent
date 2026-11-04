/**
 * Saved sign-ins: one profile per org (a personal token is bound to one org), named by the org's
 * slug, and which one is current. The file holds secrets: it's made readable by its owner only.
 *
 *   $ONYX_CONFIG, else $XDG_CONFIG_HOME/onyx/config.json, else ~/.config/onyx/config.json
 *
 * ONYX_URL and ONYX_TOKEN override the profile (CI and agents need no file); ONYX_PROFILE or
 * --profile picks another.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { envVar, type Io } from "./io"
import { CliError, EXIT, UsageError } from "./output"

/** Where `onyx login` signs in when nothing names a server (--url, ONYX_URL, the current profile). */
export const DEFAULT_URL = "https://app.onyxresearch.ai"

export interface Profile {
  url: string
  token: string
  org: { id: string; name: string; slug: string }
  /** "cli": a CLI sign-in (onyx login; logout revokes it); "token": one pasted in */
  kind?: "cli" | "token"
  /** when it expires if unused (a CLI sign-in's slides with use) */
  expiresAt?: string
}

export interface Config {
  current: string | null
  profiles: Record<string, Profile>
  /** Profiles this CLI didn't write (another tool's, sharing the file): kept as they are, never used. */
  others?: Record<string, unknown>
}

function isProfile(p: unknown): p is Profile {
  const x = p as Partial<Profile> | null
  return (
    typeof x?.url === "string" &&
    typeof x.token === "string" &&
    typeof x.org === "object" &&
    x.org !== null &&
    typeof x.org.slug === "string"
  )
}

export function configPath(io: Io): string {
  const explicit = envVar(io, "ONYX_CONFIG")
  if (explicit) return explicit
  const base = envVar(io, "XDG_CONFIG_HOME") ?? join(envVar(io, "HOME") ?? homedir(), ".config")
  return join(base, "onyx", "config.json")
}

export function readConfig(path: string): Config {
  if (!existsSync(path)) return { current: null, profiles: {} }
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    current?: string | null
    profiles?: Record<string, unknown>
  }
  const profiles: Record<string, Profile> = {}
  const others: Record<string, unknown> = {}
  for (const [name, p] of Object.entries(raw.profiles ?? {}))
    if (isProfile(p)) profiles[name] = p
    else others[name] = p
  return { current: raw.current ?? null, profiles, others }
}

export function writeConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const { current, profiles, others } = config
  const doc = { current, profiles: { ...others, ...profiles } }
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  // the mode above applies only when the file is created
  chmodSync(path, 0o600)
}

/** Whether two server URLs are the same server (origin and path); null if one can't be read. */
function sameServer(a: string, b: string): boolean | null {
  try {
    const [x, y] = [new URL(a), new URL(b)]
    const path = (u: URL) => u.pathname.replace(/\/+$/, "")
    return x.origin === y.origin && path(x) === path(y)
  } catch {
    return null
  }
}

/** Where requests go and with what token: the environment over the chosen profile. */
export function target(
  io: Io,
  config: Config,
  profileFlag?: string
): { url: string; token: string; profile: string | null } {
  const name = profileFlag ?? envVar(io, "ONYX_PROFILE") ?? config.current
  const profile = name ? config.profiles[name] : undefined
  if (name && !profile && (profileFlag || envVar(io, "ONYX_PROFILE")))
    throw new UsageError(`no profile ${name} (onyx login, or onyx org use <slug>)`)
  const envUrl = envVar(io, "ONYX_URL")
  const envToken = envVar(io, "ONYX_TOKEN")
  // a profile's token goes only to its own server: ONYX_URL alone (from an env file in some
  // repository, say) must not send it elsewhere
  if (envUrl && !envToken && profile && sameServer(envUrl, profile.url) === false)
    throw new UsageError(
      `ONYX_URL (${envUrl}) isn't the profile's server (${profile.url}): set ONYX_TOKEN too, or unset ONYX_URL`
    )
  const url = envUrl ?? profile?.url
  const token = envToken ?? profile?.token
  if (!token)
    throw new CliError(
      "not signed in: run onyx login, or set ONYX_TOKEN",
      EXIT.auth,
      [],
      "unauthorized"
    )
  if (!url) throw new UsageError("no server: set ONYX_URL, or run onyx login --url <url>")
  return { url, token, profile: profile ? name! : null }
}
