/**
 * The rules a run's agent works by (AgentTools, Claude Code's vocabulary), for a CLI with no
 * allow-list of its own: `onyx research gate` is its hook before each tool call, and refuses
 * what no rule allows. A shell command passes only if every command in it does, as Claude Code
 * checks them: a part a rule doesn't allow, a command substitution or a redirect into a file is
 * refused, so a rule like `onyx research *` is all such an agent can run.
 */
import { appendFileSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

import type { AgentTools } from "./agents"

/** a turn's rules, and for an agent that edits, the directories its edits must stay in (the first is where it works) */
export type GateRules = AgentTools & { writable?: string[] }

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

/**
 * A simple command's words, quotes taken off, and whether the shell would expand anything in it
 * (a `$` outside single quotes, or an unquoted glob) into words no one checked.
 */
function words(part: string): { words: string[]; expands: boolean } {
  const out: string[] = []
  let cur: string | null = null
  let quote: "'" | '"' | null = null
  let expands = false
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (c === "\\") {
      cur = (cur ?? "") + (part[i + 1] ?? "")
      i++
      continue
    }
    if (c === "$") expands = true
    if (quote === '"') {
      if (c === '"') quote = null
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur ??= ""
      continue
    }
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur)
      cur = null
      continue
    }
    if (c === "*" || c === "?" || c === "[") expands = true
    cur = (cur ?? "") + c
  }
  if (cur !== null) out.push(cur)
  return { words: out, expands }
}

/** commands that only read or print, whatever their arguments */
const READS = new Set([
  "cat",
  "head",
  "tail",
  "nl",
  "wc",
  "ls",
  "grep",
  "stat",
  "pwd",
  "cd",
  "echo",
])
/** `sed -n` scripts that print lines: `1,200p`, `$p`, `10,20p;40,60p` */
const SED_PRINT = /^(\d+|\$)(,(\d+|\$))?p(;(\d+|\$)(,(\d+|\$))?p)*$/
/** what turns find from reading to running or writing */
const FIND_ACTS = /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/

/**
 * Whether a simple command only reads files: what an agent whose only way to read is its shell
 * (Codex) runs in place of Read, Glob and Grep. find, rg and sed take arguments that run programs
 * or write files (`-exec`, `--pre`, `-i`), so theirs are checked, and must expand to nothing.
 */
export function onlyReads(part: string): boolean {
  const { words: w, expands } = words(part)
  const [cmd, ...args] = w
  if (cmd === undefined) return false
  if (READS.has(cmd)) return true
  if (expands) return false
  if (cmd === "find") return !args.some((a) => FIND_ACTS.test(a))
  if (cmd === "rg") return !args.some((a) => a === "--pre" || a.startsWith("--pre="))
  if (cmd === "sed") {
    // sed -n <script> <file...>: only -n, and a script that prints lines
    const [n, script, ...files] = args
    return (
      n === "-n" &&
      script !== undefined &&
      SED_PRINT.test(script) &&
      files.every((f) => !f.startsWith("-"))
    )
  }
  return false
}

/** the files a patch (`*** Begin Patch`) adds, updates, deletes or moves to */
export function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) =>
    m[1]!.trim()
  )
}

/** the first of these files outside every one of these directories, relative ones from the first */
function outside(files: string[], dirs: string[]): string | undefined {
  return files.find((f) => {
    const abs = resolve(dirs[0]!, f)
    return !dirs.some((d) => {
      const r = relative(resolve(d), abs)
      return r === "" || (!r.startsWith("..") && !isAbsolute(r))
    })
  })
}

/** Whether these rules let this tool call run. */
export function judge(t: GateRules, toolName: string, toolInput: unknown): Verdict {
  const command = commandOf(toolInput)
  if (EDIT_TOOLS.test(toolName) || command?.startsWith("*** Begin Patch")) {
    if (!(t.allow.includes("Edit") && t.allow.includes("Write")))
      return { allow: false, reason: "this agent doesn't edit files" }
    if (!t.writable?.length) return { allow: true }
    // a patch names its files; another edit tool its file_path
    const fp = (toolInput as { file_path?: unknown } | null)?.file_path
    const files = command ? patchPaths(command) : typeof fp === "string" ? [fp] : []
    if (!files.length) return { allow: false, reason: "an edit that names no file" }
    const out = outside(files, t.writable)
    return out === undefined
      ? { allow: true }
      : { allow: false, reason: `\`${out}\` is outside the directories this agent edits in` }
  }
  // Codex's way to look at an image, which Claude Code's Read does
  if (toolName === "view_image" && t.allow.includes("Read")) return { allow: true }
  if (command === null)
    return { allow: false, reason: `${toolName} isn't one of this agent's tools` }
  const rules = shellRules(t)
  // an agent that may read files may read them with its shell
  const reads = t.allow.includes("Read")
  if (!rules.length && !reads) return { allow: false, reason: "this agent runs no commands" }
  const parts = simpleCommands(command)
  if (!parts)
    return {
      allow: false,
      reason: "no command substitution, subshell or redirect into a file: run each command plainly",
    }
  const refused = parts.find((p) => !rules.some((r) => r.test(p)) && !(reads && onlyReads(p)))
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
  let t: GateRules
  let call: { tool_name?: unknown; tool_input?: unknown }
  try {
    t = JSON.parse(readFileSync(rulesPath, "utf8")) as GateRules
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
