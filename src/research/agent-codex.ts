/**
 * Codex CLI as a run's agents: `codex exec --json`, a session resumed or forked by id. Codex has
 * no allow-list like Claude Code's, so the agent's rules (AgentTools) are enforced by a
 * PreToolUse hook, `onyx research gate`, that refuses whatever no rule allows (gate.ts). Its
 * sandbox keeps writes to the turn's directories and the run's; a ghost, with no tools, has no
 * shell at all and a read-only sandbox.
 *
 * A turn whose JSON shows a command ran, or a file changed, that the gate never let through
 * failed: Codex didn't run the hook, and the turn's work isn't trusted.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"

import type { AgentCli, AgentRun } from "./agents"
import { gateFiles, type GateRules } from "./gate"
import { selfCommand, shellQuote } from "./self"

/** a TOML string, for a `-c key=value` override */
const toml = (s: string) => JSON.stringify(s)

/** an agent that edits files: a worker, which commits its edits too */
const edits = (a: AgentRun) => a.tools.allow.includes("Edit")

/** where an agent edits files, as Claude Code's are let: where it works, and the directories it's given */
const editDirs = (a: AgentRun) => [a.cwd, ...(a.addDirs ?? [])]

/**
 * The `-c` overrides for a turn: no approvals asked, its sandbox, its gate, no web search.
 *
 * A worker has no sandbox: Codex's keeps the git metadata of the repository it works in read
 * only, whatever is writable, so a worker couldn't commit the experiments it sends. Its gate holds
 * it to the same rules regardless (only its commands run, edits only where it works and in the directories it's given), as a
 * Claude Code worker's rules do.
 */
function overrides(a: AgentRun, rulesPath: string): string[] {
  const noTools = !a.tools.tools.length
  const gate = [...selfCommand(), "research", "gate", rulesPath].map(shellQuote).join(" ")
  // its shell's onyx research writes the run's state
  const writable = [
    ...(a.addDirs ?? []),
    ...(a.env.ONYX_RESEARCH_RUN ? [a.env.ONYX_RESEARCH_RUN] : []),
  ]
  const sandbox = noTools ? "read-only" : edits(a) ? "danger-full-access" : "workspace-write"
  const c = [
    `approval_policy="never"`,
    `sandbox_mode="${sandbox}"`,
    // onyx research, in its shell, reaches the platform
    ...(sandbox === "workspace-write"
      ? [
          "sandbox_workspace_write.network_access=true",
          `sandbox_workspace_write.writable_roots=[${writable.map(toml).join(",")}]`,
        ]
      : []),
    `hooks.PreToolUse=[{hooks=[{type="command",command=${toml(gate)}}]}]`,
    `web_search="disabled"`,
  ]
  return c.flatMap((o) => ["-c", o])
}

/**
 * Codex reads files with its shell, and the run's instructions speak of file tools and name the
 * only commands an agent may run: an agent that may read is told its reads are allowed too.
 */
export const READ_NOTE =
  "You read files with your shell: commands that only read (`cat`, `head`, `tail`, `nl`, " +
  "`sed -n '<from>,<to>p' <file>`, `rg`, `grep`, `find` without `-exec` or `-delete`, `ls`, `wc`) " +
  "are allowed besides the commands named below. Anything that writes or runs a program is refused."

export const codex: AgentCli = {
  provider: "openai",
  // every role on the model the user's Codex is set to, unless the config says
  models: {},
  turn(a) {
    // the turn's rules, beside its log, and what its gate saw: from this turn only
    const rulesPath = `${a.log}.gate.json`
    const files = gateFiles(rulesPath)
    const rules: GateRules = { ...a.tools, ...(edits(a) ? { writable: editDirs(a) } : {}) }
    writeFileSync(rulesPath, JSON.stringify(rules))
    rmSync(files.denied, { force: true })
    rmSync(files.allowed, { force: true })

    const argv = [
      "codex",
      "exec",
      "--json",
      // onyx wrote the hook: Codex needn't ask anyone to trust it
      "--dangerously-bypass-hook-trust",
      "--skip-git-repo-check",
      ...overrides(a, rulesPath),
      ...(a.model ? ["-m", a.model] : []),
      ...(a.tools.tools.length ? [] : ["--disable", "shell_tool", "--disable", "unified_exec"]),
    ]
    if (a.resume) argv.push(a.fork ? "fork" : "resume", a.resume)
    // after `--`: a prompt that starts with a dash is still the prompt
    argv.push("--", a.tools.allow.includes("Read") ? `${READ_NOTE}\n\n${a.prompt}` : a.prompt)

    return {
      argv,
      result(out, err, exitCode) {
        const events = out
          .split("\n")
          .filter((l) => l.startsWith("{"))
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as CodexEvent]
            } catch {
              return []
            }
          })
        const session = events.find((e) => e.type === "thread.started")?.thread_id ?? null
        const said = events.filter(
          (e) => e.type === "item.completed" && e.item?.type === "agent_message"
        )
        const failed = events.find((e) => e.type === "turn.failed")
        const denied = existsSync(files.denied)
          ? readFileSync(files.denied, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => (JSON.parse(l) as { command?: string | null }).command)
              .filter((c): c is string => typeof c === "string")
          : []
        const allowed = existsSync(files.allowed)
          ? readFileSync(files.allowed, "utf8").split("\n").filter(Boolean).length
          : 0
        // what ran: commands that finished, files that changed
        const ran = events.filter(
          (e) =>
            e.type === "item.completed" &&
            ((e.item?.type === "command_execution" && e.item.status === "completed") ||
              (e.item?.type === "file_change" && e.item.status === "completed"))
        ).length
        if (ran > allowed)
          return {
            session,
            text: `the run's gate let ${allowed} tool calls through but ${ran} ran: Codex didn't run its hook (a Codex too old for hooks, or hooks turned off), so this turn isn't trusted`,
            ok: false,
            denied,
          }
        const text = said.at(-1)?.item?.text ?? ""
        const ok = exitCode === 0 && !failed && events.some((e) => e.type === "turn.completed")
        return {
          session,
          text: ok ? text : failed?.error?.message || lastError(events) || err || text,
          ok,
          denied,
        }
      },
    }
  },
}

interface CodexEvent {
  type: string
  thread_id?: string
  message?: string
  error?: { message?: string }
  item?: { type?: string; text?: string; status?: string }
}

const lastError = (events: CodexEvent[]) =>
  events.filter((e) => e.type === "error").at(-1)?.message ?? ""
