/**
 * Claude Code as a run's agents: `claude -p`, with its tools and the rules that let them run
 * (AgentTools is Claude Code's own vocabulary), and its JSON result.
 */
import type { AgentCli } from "./agents"

export const claude: AgentCli = {
  provider: "anthropic",
  // the var-op plans the whole run (which hypotheses, how experiments should look) and is a small
  // share of its cost, so it gets the strongest model; workers, most of the cost, a cheaper one
  models: { base: "opus", varop: "opus", worker: "sonnet", ghost: "haiku" },
  turn(a) {
    const t = a.tools
    const argv = [
      "claude",
      "-p",
      a.prompt,
      "--output-format",
      "json",
      ...(a.model ? ["--model", a.model] : []),
      // each rule its own argument: a rule may have spaces in it (`Bash(onyx research *)`)
      "--tools",
      ...(t.tools.length ? t.tools : [""]),
      ...(t.allow.length ? ["--allowedTools", ...t.allow] : []),
      "--permission-mode",
      t.mode,
    ]
    if (a.resume) argv.push("--resume", a.resume)
    if (a.resume && a.fork) argv.push("--fork-session")
    for (const d of a.addDirs ?? []) argv.push("--add-dir", d)
    return {
      argv,
      result(out, err, exitCode) {
        try {
          const r = JSON.parse(out) as {
            session_id?: string
            result?: string
            is_error?: boolean
            permission_denials?: { tool_input?: { command?: unknown } }[]
          }
          return {
            session: r.session_id ?? null,
            text: r.result ?? "",
            ok: !r.is_error && exitCode === 0,
            denied: (r.permission_denials ?? [])
              .map((d) => d.tool_input?.command)
              .filter((c): c is string => typeof c === "string"),
          }
        } catch {
          return { session: null, text: err || out, ok: false, denied: [] }
        }
      },
    }
  },
}
