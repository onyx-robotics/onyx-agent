/**
 * The onyx CLI: a client of the API (`/api/v1`) for people, scripts and agents.
 *
 *   onyx login                                     # approve this machine in the browser
 *   onyx ingest runs.ndjson
 *   onyx ls --type experiment --status running --json
 *   onyx research run <repo>/onyx/research.json    # autoresearch on this machine
 *
 * `run` is the whole program over an Io (main.ts wires the process), so tests drive it in
 * process. It returns the exit code (output.ts EXIT).
 */
import { OnyxClient } from "../sdk"

import { auth } from "./commands/auth"
import { ingestCommand } from "./commands/ingest"
import { reads } from "./commands/read"
import { registry } from "./commands/registry"
import { research } from "./commands/research"
import { writes } from "./commands/write"
import { jobs } from "./commands/jobs"
import type { Command, Context } from "./command"
import { configPath, readConfig, target } from "./config"
import type { Io } from "./io"
import { EXIT, Out, reportError, UsageError, type Mode } from "./output"

export type { Io } from "./io"
export { EXIT } from "./output"

const COMMANDS: Record<string, Command> = {
  ...auth,
  ...reads,
  registry,
  ...writes,
  ...jobs,
  ingest: ingestCommand,
  research,
}

/** Commands whose arguments are all their own: the flags below aren't read after their name. */
const OWN_ARGS = new Set(["research"])

function help(out: Out, name?: string): number {
  const cmd = name ? COMMANDS[name] : undefined
  if (name && !cmd) throw new UsageError(`unknown command ${name}`)
  if (cmd) {
    out.line(cmd.usage)
    return EXIT.ok
  }
  out.line("onyx: Onyx from a shell. Items are named by id or source key (system:key).\n")
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length))
  for (const [k, c] of Object.entries(COMMANDS)) out.line(`  ${k.padEnd(width)}  ${c.summary}`)
  out.line(
    "\nFlags for every command but research: --json (JSON output; the default when not at a terminal), " +
      "--human, --profile <slug>.\nonyx help <command> shows its flags."
  )
  return EXIT.ok
}

export async function run(argv: string[], io: Io): Promise<number> {
  // flags every command takes, wherever they are
  let mode: Mode = io.isTTY ? "human" : "json"
  let jsonAsked = false
  let profile: string | undefined
  let wantsHelp = false
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (rest.length === 0 && OWN_ARGS.has(a)) {
      rest.push(...argv.slice(i))
      break
    }
    if (a === "--json") {
      mode = "json"
      jsonAsked = true
    } else if (a === "--human") mode = "human"
    else if (a === "--help" || a === "-h") wantsHelp = true
    else if (a === "--profile") profile = argv[++i]
    else if (a.startsWith("--profile=")) profile = a.slice("--profile=".length)
    else rest.push(a)
  }
  const out = new Out(io, mode)
  try {
    const [name, ...args] = rest
    if (!name || name === "help") return help(out, args[0])
    const cmd = COMMANDS[name]
    if (!cmd) throw new UsageError(`unknown command ${name}`)
    if (wantsHelp) return help(out, name)
    const path = configPath(io)
    const c: Context = {
      io,
      out,
      argv: args,
      profile,
      jsonAsked,
      configPath: path,
      client: () => {
        const t = target(io, readConfig(path), profile)
        return new OnyxClient({ baseUrl: t.url, token: t.token, fetch: io.fetch, sleep: io.sleep })
      },
      app: (page = "") => {
        const t = target(io, readConfig(path), profile)
        return {
          url: `${t.url.replace(/\/+$/, "")}/${page}`,
          person: !t.token.startsWith("onyx_sk_"),
        }
      },
    }
    return (await cmd.run(c)) ?? EXIT.ok
  } catch (e) {
    return reportError(io, mode, e)
  }
}
