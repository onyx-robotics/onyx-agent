/** Signing in and out, and which org's profile is used. */
import { arch, hostname, platform } from "node:os"

import {
  OnyxClient,
  pollDeviceToken,
  revokeToken,
  startDeviceAuthorization,
  type DeviceCode,
} from "../../sdk"

import { version } from "../../../package.json"
import { flags, type Command, type Context } from "../command"
import { DEFAULT_URL, readConfig, writeConfig, type Config, type Profile } from "../config"
import { canOpenBrowser, envVar } from "../io"
import { UsageError } from "../output"

/** Save a signed-in profile (named after its org) and make it the current one. */
async function save(c: Context, url: string, token: string, kind: Profile["kind"]) {
  const me = await new OnyxClient({
    baseUrl: url,
    token,
    fetch: c.io.fetch,
    sleep: c.io.sleep,
  }).me()
  const config = readConfig(c.configPath)
  const name = c.profile ?? me.org.slug
  config.profiles[name] = {
    url,
    token,
    org: me.org,
    kind,
    ...(me.token ? { expiresAt: me.token.expiresAt } : {}),
  }
  config.current = name
  writeConfig(c.configPath, config)
  if (c.out.human) {
    c.out.line(
      `Signed in to ${me.org.name} as ${me.actor?.name ?? "?"} (${me.role}), profile ${name}.`
    )
    if (me.via === "api_key") c.out.line("This is an API key: you act as its AI agent.")
  } else c.out.json({ profile: name, url, ...me })
}

/** The device flow: a code, approved in the browser, then the token. */
async function signInWithBrowser(
  c: Context,
  url: string,
  opts: { org?: string; admin: boolean; browser: boolean }
): Promise<string> {
  const code: DeviceCode = await startDeviceAuthorization({
    baseUrl: url,
    fetch: c.io.fetch,
    client: { name: "onyx", version, hostname: hostname(), os: `${platform()} ${arch()}` },
    scopes: ["read", "ingest", "actions", "jobs", ...(opts.admin ? ["admin"] : [])],
    org: opts.org,
  })
  // to stderr: stdout is for the result (JSON when not at a terminal)
  const say = (s: string) => c.io.stderr(`${s}\n`)
  say(`To sign in, open this page and check it shows the code ${code.userCode}:`)
  say(`  ${code.verificationUriComplete}`)
  if (opts.browser && canOpenBrowser(c.io.env, platform()) && c.io.openUrl) {
    if (await c.io.openUrl(code.verificationUriComplete)) say("(opened in your browser)")
  }
  say("Waiting for you to approve it… (Ctrl-C cancels)")
  const issued = await pollDeviceToken({
    baseUrl: url,
    fetch: c.io.fetch,
    code,
    sleep: c.io.sleep,
  })
  return issued.token
}

const login: Command = {
  summary: "sign in: approve this machine in your browser",
  usage: `onyx login [--url <url>] [--org <slug>] [--admin] [--no-browser]
onyx login --with-token < token.txt
onyx login --token <token>

Signs in as you: it shows a code and opens a page of the Onyx app where you sign in, check the
code and approve (over SSH, open the page on any machine). The sign-in is a token acting as you
in the org you choose, kept in your config file; it expires after 30 days unused (90 at most),
and onyx logout revokes it. --org preselects an org, --admin asks for the admin scope (registry,
members, spaces; only an admin gets it).

--with-token reads a personal token or API key from standard input instead (CI, scripts);
--token takes it as an argument. An API key (onyx_sk_) acts as its AI agent.
The URL defaults to ONYX_URL, else the current profile's, else ${DEFAULT_URL}.`,
  async run(c) {
    const { values } = flags(c.argv, {
      url: { type: "string" },
      token: { type: "string" },
      "with-token": { type: "boolean" },
      org: { type: "string" },
      admin: { type: "boolean" },
      "no-browser": { type: "boolean" },
    })
    const config = readConfig(c.configPath)
    const current = config.current ? config.profiles[config.current] : undefined
    const url = (values.url ?? envVar(c.io, "ONYX_URL") ?? current?.url ?? DEFAULT_URL).replace(
      /\/+$/,
      ""
    )
    if (values.token || values["with-token"]) {
      let token = values.token
      if (values["with-token"]) {
        const lines: string[] = []
        for await (const line of c.io.stdin()) lines.push(line)
        token = lines.join("").trim()
      }
      if (!token) throw new UsageError("no token on standard input")
      return void (await save(c, url, token, "token"))
    }
    const token = await signInWithBrowser(c, url, {
      org: values.org,
      admin: values.admin ?? false,
      browser: !values["no-browser"],
    })
    await save(c, url, token, "cli")
  },
}

const logout: Command = {
  summary: "sign out: revoke this machine's sign-in and forget it",
  usage: `onyx logout [--profile <slug>]

Revokes a sign-in made with onyx login and removes the profile from this machine. A token you
pasted in (--token, --with-token) is only forgotten here, since scripts may share it: revoke it
on Account -> Personal tokens.`,
  async run(c) {
    flags(c.argv, {})
    const config: Config = readConfig(c.configPath)
    const name = c.profile ?? config.current
    const profile = name ? config.profiles[name] : undefined
    if (!name || !profile) throw new UsageError("not signed in")
    let revoked = false
    if (profile.kind === "cli") {
      try {
        await revokeToken({ baseUrl: profile.url, fetch: c.io.fetch, token: profile.token })
        revoked = true
      } catch (e) {
        // forgotten here anyway: unused, it expires within 30 days
        c.io.stderr(
          `warning: couldn't revoke the sign-in on ${profile.url} (${(e as Error).message}); revoke it on Account -> Personal tokens\n`
        )
      }
    }
    delete config.profiles[name]
    if (config.current === name) config.current = Object.keys(config.profiles)[0] ?? null
    writeConfig(c.configPath, config)
    if (c.out.human) c.out.line(`Signed out of ${name}${revoked ? " (sign-in revoked)" : ""}.`)
    else c.out.json({ profile: name, revoked, current: config.current })
  },
}

const whoami: Command = {
  summary: "who requests act as, in which org",
  usage: "onyx whoami",
  async run(c) {
    flags(c.argv, {})
    const me = await c.client().me()
    if (!c.out.human) return void c.out.json(me)
    const how = { personal_token: "a personal token", api_key: "an API key", session: "a session" }
    c.out.line(`${me.actor?.name ?? "?"} (${me.actor?.type ?? "?"}), ${me.role} of ${me.org.name}`)
    const via =
      me.token?.kind === "cli"
        ? `a CLI sign-in (expires ${me.token.expiresAt.slice(0, 10)} if unused)`
        : how[me.via]
    c.out.line(`org: ${me.org.slug}, via ${via}, scopes: ${me.scopes.join(", ")}`)
    if (me.assignment) c.out.line(`assigned to: ${me.assignment.name} (${me.assignment.type})`)
  },
}

const org: Command = {
  summary: "list your profiles, or switch: org use <slug>",
  usage: `onyx org [use <slug>]

A personal token belongs to one org, so each org you use has its own profile (onyx login).`,
  async run(c) {
    const { positionals } = flags(c.argv, {})
    const config: Config = readConfig(c.configPath)
    if (positionals[0] === "use") {
      const slug = positionals[1]
      if (!slug || !config.profiles[slug])
        throw new UsageError(
          `no profile ${slug ?? ""}: onyx login --profile <slug> signs in to another org`
        )
      config.current = slug
      writeConfig(c.configPath, config)
      if (c.out.human) c.out.line(`Using ${config.profiles[slug]!.org.name} (${slug}).`)
      else c.out.json({ current: slug })
      return
    }
    if (positionals.length) throw new UsageError(`unknown: org ${positionals.join(" ")}`)
    const rows = Object.entries(config.profiles).map(([k, p]) => ({
      profile: k,
      current: k === config.current,
      org: p.org.name,
      url: p.url,
    }))
    if (!c.out.human) return void c.out.json(rows)
    c.out.table(
      ["", "profile", "org", "url"],
      rows.map((r) => [r.current ? "*" : "", r.profile, r.org, r.url])
    )
  },
}

export const auth: Record<string, Command> = { login, logout, whoami, org }
