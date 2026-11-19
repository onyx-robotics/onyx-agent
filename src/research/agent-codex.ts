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
import { gateFiles } from "./gate"
import { selfCommand, shellQuote } from "./self"

/** a TOML string, for a `-c key=value` override */
const toml = (s: string) => JSON.stringify(s)

/** the `-c` overrides for a turn: no approvals asked, its sandbox, its gate, no web search */
function overrides(a: AgentRun, rulesPath: string): string[] {
  const noTools = !a.tools.tools.length
  const writable = [
    ...(a.addDirs ?? []),
    ...(a.env.ONYX_RESEARCH_RUN ? [a.env.ONYX_RESEARCH_RUN] : []),
  ]
  const gate = [...selfCommand(), "research", "gate", rulesPath].map(shellQuote).join(" ")
  const c = [
    `approval_policy="never"`,
    `sandbox_mode="${noTools ? "read-only" : "workspace-write"}"`,
    // onyx research, in its shell, reaches the platform and pushes the experiment's commit
    ...(noTools
      ? []
      : [
          "sandbox_workspace_write.network_access=true",
          `sandbox_workspace_write.writable_roots=[${writable.map(toml).join(",")}]`,
        ]),
    `hooks.PreToolUse=[{hooks=[{type="command",command=${toml(gate)}}]}]`,
    `web_search="disabled"`,
  ]
  return c.flatMap((o) => ["-c", o])
}

export const codex: AgentCli = {
  provider: "openai",
  // every role on the model the user's Codex is set to, unless the config says
  models: {},
  turn(a) {
    // the turn's rules, beside its log, and what its gate saw: from this turn only
    const rulesPath = `${a.log}.gate.json`
    const files = gateFiles(rulesPath)
    writeFileSync(rulesPath, JSON.stringify(a.tools))
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
    argv.push("--", a.prompt)

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
