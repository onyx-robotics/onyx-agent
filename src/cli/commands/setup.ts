/**
 * `onyx setup`: a machine ready for Onyx in one command. It checks what a research run needs,
 * signs in if nobody is, and gives Claude Code the package's skills. Safe to run again.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { OnyxApiError } from "../../sdk"
import { checkAgent } from "../../research/agent-check"
import { SKILLS } from "../../skills"
import { flags, type Command, type Context } from "../command"
import { envVar } from "../io"
import { CliError, EXIT } from "../output"

import { auth } from "./auth"

/** Write the skills under dir (replacing an earlier version's): the skills' names. */
export function installSkills(dir: string): string[] {
  for (const [path, text] of Object.entries(SKILLS)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return [...new Set(Object.keys(SKILLS).map((p) => p.split("/")[0]!))]
}

/** A tool's version line, or null when it isn't on the PATH. */
function tool(name: string): string | null {
  try {
    const p = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 15_000 })
    return p.status === 0 ? (p.stdout.trim().split("\n")[0] ?? "") : null
  } catch {
    return null
  }
}

async function signedIn(c: Context): Promise<string | null> {
  try {
    const me = await c.client().me()
    return `${me.actor?.name ?? "?"} in ${me.org.name}`
  } catch (e) {
    if (e instanceof CliError && e.exit === EXIT.auth) return null
    if (e instanceof OnyxApiError && e.status === 401) return null
    throw e
  }
}

export const setup: Command = {
  summary: "get this machine ready: check it, sign in, install the skills for Claude Code",
  usage: `onyx setup [--project] [--url <url>]

One command for a new machine, safe to run again:
  1. checks git, and the coding agent a research run's agents are sessions of (Claude Code):
     installed, and signed in where its CLI can say;
  2. signs you in, as onyx login does, if you aren't;
  3. installs the package's skills for Claude Code in ~/.claude/skills (--project: in this
     folder's .claude/skills instead): onyx and onyx-research-setup.

Then, in Claude Code, in your project: "set up an Onyx research run for this repository".
--url is the server to sign in to, as for onyx login.`,
  async run(c) {
    const { values } = flags(c.argv, { project: { type: "boolean" }, url: { type: "string" } })
    const steps: { step: string; ok: boolean; detail: string }[] = []
    const say = (step: string, ok: boolean, detail: string) => {
      steps.push({ step, ok, detail })
      if (c.out.human) c.out.line(`${ok ? "ok  " : "todo"}  ${step}: ${detail}`)
    }

    const git = tool("git")
    say("git", git !== null, git ?? "not found: install git")
    // the coding agent research runs' agents are sessions of, checked as onyx research does
    const agent = checkAgent()
    say("coding agent", agent.problem === null, agent.problem ?? agent.version ?? "")

    let who = await signedIn(c)
    if (!who && c.io.isTTY) {
      await auth.login!.run({ ...c, argv: values.url ? ["--url", values.url] : [] })
      who = await signedIn(c)
    }
    say("signed in", who !== null, who ?? "not signed in: run onyx login")

    const dir = values.project
      ? join(process.cwd(), ".claude", "skills")
      : join(envVar(c.io, "HOME") ?? homedir(), ".claude", "skills")
    const names = installSkills(dir)
    say("skills", true, `${names.join(", ")} in ${dir}`)

    const ready = steps.every((s) => s.ok)
    if (c.out.human) {
      c.out.line("")
      c.out.line(
        ready
          ? 'Ready. In Claude Code, in your project: "set up an Onyx research run for this repository".'
          : "Fix what's marked todo, then run onyx setup again."
      )
    } else c.out.json({ ready, steps, skills: { dir, names } })
    return who ? EXIT.ok : EXIT.auth
  },
}
