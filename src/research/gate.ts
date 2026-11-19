/**
 * The rules a run's agent works by (AgentTools, Claude Code's vocabulary), for a CLI with no
 * allow-list of its own: `onyx research gate` is its hook before each tool call, and refuses
 * what no rule allows. A shell command passes only if every command in it does, as Claude Code
 * checks them: a part a rule doesn't allow, a command substitution or a redirect into a file is
 * refused, so a rule like `onyx research *` is all such an agent can run.
 */
import { appendFileSync, readFileSync } from "node:fs"

import type { AgentTools } from "./agents"

export type Verdict = { allow: true } | { allow: false; reason: string }

const EDIT_TOOLS = /^(apply_patch|edit|write|multiedit|notebookedit)$/i

/** `Bash(git status*)` as a whole-command pattern: `*` is anything, the rest is itself */
function shellRules(t: AgentTools): RegExp[] {
  return t.allow
    .map((r) => /^Bash\((.*)\)$/s.exec(r)?.[1])
    .filter((c): c is string => c !== undefined)
    .map((c) => new RegExp(`^${c.split("*").map(escape).join(".*")}$`, "s"))
}
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

/**
 * A shell command's simple commands, split at `&&`, `||`, `;`, `|`, `&` and newlines outside
 * quotes; null when it has something no rule can vouch for (a substitution, a subshell, a
 * redirect into a file).
 */
export function simpleCommands(cmd: string): string[] | null {
  const parts: string[] = []
  let cur = ""
  let quote: "'" | '"' | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote === "'") {
      cur += c
      if (c === "'") quote = null
      continue
    }
    if (c === "\\") {
      cur += c + (cmd[i + 1] ?? "")
      i++
      continue
    }
    // a substitution runs a command even in double quotes
    if (c === "`" || (c === "$" && cmd[i + 1] === "(")) return null
    if (quote === '"') {
      cur += c
      if (c === '"') quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") return null
    if (c === "<") return null
    if (c === ">") {
      // only `>&2`, `2>&1` and `> /dev/null`: output joined or thrown away, never into a file
      if (/(^|\s)\d$/.test(cur)) cur = cur.slice(0, -1)
      const m = /^>>?(&\d|\s*\/dev\/null(?=$|[\s;&|]))/.exec(cmd.slice(i))
      if (!m) return null
      i += m[0].length - 1
      continue
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      if ((c === "&" || c === "|") && cmd[i + 1] === c) i++
      parts.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  if (quote) return null
  parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** A tool call's shell command: its text, or a `bash -lc <script>` argv's script. */
function commandOf(input: unknown): string | null {
  const c = (input as { command?: unknown } | null)?.command
  if (typeof c === "string") return c
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    const argv = c as string[]
    if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!))
      return argv[2]!
    return argv
      .map((a) => (/^[\w./=:@%+-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`))
      .join(" ")
  }
  return null
}

/** Whether these rules let this tool call run. */
export function judge(t: AgentTools, toolName: string, toolInput: unknown): Verdict {
  const command = commandOf(toolInput)
  if (EDIT_TOOLS.test(toolName) || command?.startsWith("*** Begin Patch"))
    return t.allow.includes("Edit") && t.allow.includes("Write")
      ? { allow: true }
      : { allow: false, reason: "this agent doesn't edit files" }
  if (command === null)
    return { allow: false, reason: `${toolName} isn't one of this agent's tools` }
  const rules = shellRules(t)
  if (!rules.length) return { allow: false, reason: "this agent runs no commands" }
  const parts = simpleCommands(command)
  if (!parts)
    return {
      allow: false,
      reason: "no command substitution, subshell or redirect into a file: run each command plainly",
    }
  const refused = parts.find((p) => !rules.some((r) => r.test(p)))
  return refused === undefined
    ? { allow: true }
    : { allow: false, reason: `\`${refused}\` isn't a command this agent may run` }
}

/** where a turn's gate keeps what it refused (one JSON line each) and how many it let run */
export const gateFiles = (rulesPath: string) => ({
  denied: `${rulesPath}.denied`,
  allowed: `${rulesPath}.allowed`,
})

/**
 * `onyx research gate <rules>`: a PreToolUse hook. The tool call is the JSON on stdin; exit 0
 * lets it run, exit 2 refuses it with the reason on stderr, for the agent to read.
 */
export function runGate(rulesPath: string, stdin: string): { exit: number; stderr: string } {
  const files = gateFiles(rulesPath)
  let t: AgentTools
  let call: { tool_name?: unknown; tool_input?: unknown }
  try {
    t = JSON.parse(readFileSync(rulesPath, "utf8")) as AgentTools
    call = JSON.parse(stdin) as typeof call
  } catch (e) {
    // a gate that can't read its rules or the call lets nothing through
    return { exit: 2, stderr: `the run's gate couldn't check this: ${(e as Error).message}` }
  }
  const v = judge(t, String(call.tool_name ?? ""), call.tool_input)
  if (v.allow) {
    appendFileSync(files.allowed, "1\n")
    return { exit: 0, stderr: "" }
  }
  appendFileSync(
    files.denied,
    `${JSON.stringify({ tool: call.tool_name, command: commandOf(call.tool_input) })}\n`
  )
  return { exit: 2, stderr: `refused by the run: ${v.reason}` }
}
