/**
 * `onyx setup`: a machine ready for Onyx in one command. It checks what a research run needs,
 * signs in if nobody is, and gives the coding agent the package's skills. Safe to run again.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { OnyxApiError } from "../../sdk"
import { AGENTS, checkAgent } from "../../research/agent-check"
import { AGENT_CLIS } from "../../research/agents"
import { SKILLS } from "../../skills"
import { flags, type Command, type Context } from "../command"
import { envVar, type Io } from "../io"
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

/**
 * Where each coding agent a run's agents can be reads skills: the user's own folder, or (project)
 * this repository's.
 */
export function skillDirs(io: Io, project: boolean): Record<string, string> {
  const home = envVar(io, "HOME") ?? homedir()
  const root = process.cwd()
  return project
    ? { claude: join(root, ".claude", "skills"), codex: join(root, ".agents", "skills") }
    : {
        claude: join(home, ".claude", "skills"),
        codex: join(envVar(io, "CODEX_HOME") ?? join(home, ".codex"), "skills"),
      }
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
  summary: "get this machine ready: check it, sign in, install the skills for your coding agents",
  usage: `onyx setup [--project] [--url <url>]

One command for a new machine, safe to run again:
  1. checks git, and the coding agents a research run's agents can be sessions of (Claude Code,
     Codex CLI): installed, and signed in where its CLI can say. One ready is enough: a run uses
     the one its config names (agent);
  2. signs you in, as onyx login does, if you aren't;
  3. installs the package's skills, onyx and onyx-research-setup, where each agent that's
     installed reads them: ~/.claude/skills, ~/.codex/skills (or $CODEX_HOME/skills); --project:
     this folder's .claude/skills and .agents/skills instead. Another coding agent takes the same
     files.

Then ask your coding agent, in your project: "set up an Onyx research run for this repository".
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
    // the coding agents a run's agents can be sessions of, each checked as onyx research does
    const agents = Object.keys(AGENT_CLIS).map((a) => ({ a, ...checkAgent(a) }))
    const installed = agents.filter((x) => x.version !== null)
    say(
      "coding agent",
      agents.some((x) => x.problem === null),
      installed.length
        ? installed.map((x) => x.problem ?? `${x.name} ${x.version}`).join("; ")
        : `none installed: install ${agents.map((x) => `${x.name} (${AGENTS[x.a]?.install})`).join(" or ")}, and sign in`
    )

    let who = await signedIn(c)
    if (!who && c.io.isTTY) {
      await auth.login!.run({ ...c, argv: values.url ? ["--url", values.url] : [] })
      who = await signedIn(c)
    }
    say("signed in", who !== null, who ?? "not signed in: run onyx login")

    // for each agent that's here, Claude Code's folder when none is
    const where = skillDirs(c.io, values.project ?? false)
    const dirs = (installed.length ? installed.map((x) => x.a) : ["claude"]).map((a) => where[a]!)
    let names: string[] = []
    for (const d of dirs) names = installSkills(d)
    say("skills", true, `${names.join(", ")} in ${dirs.join(", ")}`)

    const ready = steps.every((s) => s.ok)
    if (c.out.human) {
      c.out.line("")
      c.out.line(
        ready
          ? 'Ready. Ask your coding agent, in your project: "set up an Onyx research run for this repository".'
          : "Fix what's marked todo, then run onyx setup again."
      )
    } else c.out.json({ ready, steps, skills: { dir: dirs[0], dirs, names } })
    return who ? EXIT.ok : EXIT.auth
  },
}
