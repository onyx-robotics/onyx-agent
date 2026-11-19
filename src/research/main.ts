/**
 * onyx research: autoresearch on the user's machine.
 *
 *   onyx research vocabulary <config>               # its endpoint types and metrics, in the org
 *   onyx research setup <repo>/onyx/research.json   # the base agent studies the repository
 *   onyx research run <repo>/onyx/research.json     # the var-op, workers and endpoints, until done
 *   onyx research steer <config> "<message>"        # tell the var-op something
 *   onyx research plot <config>                     # the run's plot in the app
 *   onyx research limit <config> [<endpoint> <s>]   # the run's time limit per experiment
 *   onyx research greedy <config> [--minutes n]    # the greedy baseline, to compare a run with
 *
 * Agents call the rest from their shells (`onyx research help`). Needs the user signed in (`onyx
 * login`, or ONYX_API_URL and ONYX_TOKEN): the run trades that for its own run key, whose jobs
 * only its own runner takes. And the coding agent in its config (`agent`), signed in.
 */
import { runGate } from "./gate"
import { runGreedy } from "./greedy"
import { declare, limit, plot, runResearch, setup, steer } from "./supervisor"
import { runTool } from "./tools"

export const RESEARCH_USAGE = `onyx research vocabulary <repo>/onyx/research.json
onyx research setup <repo>/onyx/research.json
onyx research run <repo>/onyx/research.json
onyx research steer <config> "<message>"
onyx research plot <config>
onyx research limit <config> [<endpoint> <seconds>]
onyx research greedy <config> [--minutes <n>] [--margin <fraction>]
onyx research help

Autoresearch on this machine: a base agent studies the repository (setup), then a var-op proposes
hypotheses and workers test them on the project's endpoints (run) until the config's minutes are
up. Both add the config's endpoint types and metrics the org doesn't have; vocabulary does only
that. steer tells the var-op something; plot prints the run's plot in the app (a lane per track,
its score over time); limit shows or changes the run's time limit per experiment on an endpoint
(a hard cutoff, sent with each experiment); greedy runs the one-agent baseline to compare a run with.
Agents call the rest from their shells: onyx research help lists them. Needs a sign-in (onyx
login) and the config's coding agent (agent, claude by default), signed in.`

/** The research commands, over these arguments (after `research`): the exit code. */
export async function research(args: string[]): Promise<number> {
  const [cmd, ...rest] = args
  switch (cmd) {
    case "vocabulary":
      if (!rest[0]) break
      await declare(rest[0])
      return 0
    case "setup":
      if (!rest[0]) break
      await setup(rest[0])
      return 0
    case "run":
      if (!rest[0]) break
      await runResearch(rest[0])
      return 0
    case "plot":
      if (!rest[0]) break
      console.log(await plot(rest[0]))
      return 0
    case "greedy":
      if (!rest[0]) break
      await runGreedy(rest[0], rest.slice(1))
      return 0
    case "gate": {
      // a CLI's hook before an agent's tool call (agent-codex.ts): not for people or agents
      if (!rest[0]) break
      const v = runGate(rest[0], await Bun.stdin.text())
      if (v.stderr) console.error(v.stderr)
      return v.exit
    }
    case "limit":
      if (!rest[0]) break
      // the user's or the orchestrator's: a run's own agents don't change their limits
      if (process.env.ONYX_AGENT) {
        console.error("a run's time limits are set by the user or the orchestrator, not its agents")
        return 2
      }
      return limit(rest[0], rest[1], rest[2])
    case "steer":
      if (!rest[0] || !rest[1]) break
      steer(rest[0], rest.slice(1).join(" "))
      console.log("the var-op will read it when it's next woken")
      return 0
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(`${RESEARCH_USAGE}\n\nIn a run:`)
      return runTool("help", [])
    default:
      return runTool(cmd, rest)
  }
  console.error(`usage:\n${RESEARCH_USAGE}`)
  return 2
}
