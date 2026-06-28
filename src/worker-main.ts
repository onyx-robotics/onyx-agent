import packageJson from "../package.json"

import { commandExpList, commandExpLog, commandExpRun } from "./commands/exp"
import {
  commandKnowledgeAdd,
  commandResearchBrief,
  commandResearchShouldStop,
  commandSummaryUpsert,
} from "./commands/research"
import { commandToolsRun } from "./commands/tools"
import { commandWorkflowStatus } from "./commands/workflow"
import { parseArgs } from "./lib/args"
import { assertWorkerContextArgs } from "./lib/worker-context"

export const WORKER_USAGE = `onyx-worker - worker-safe Onyx research CLI

Usage:
  onyx-worker --version
  onyx-worker research brief [--campaign <name>] [--session <id>] [--hypothesis <id>] [--json]
  onyx-worker research should-stop [--session <id>] [--json]
  onyx-worker tools run <name> [args...] [--project-path <path>] [--timeout <seconds>]
  onyx-worker exp run (--campaign <name> [--base <sha>] | --resume [workflowRunId]) [--auto|--next] [--timeout <seconds>] [--checks-timeout <seconds>] [--project-path <path>]
  onyx-worker workflow status [--run <workflowRunId>] [--campaign <name>] [--active] [--blocked] [--project-path <path>] [--json]
  onyx-worker exp log [--campaign <name>] [--run-ref <ref>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>] [--commit <sha>] [--base <sha>] [--result-ref <ref>] [--metric <value>] [--metric-name <name>] [--status succeeded|failed|checks_failed|setup_violation|accepted|rejected|running|queued] [--allow-unmeasured] [--project-path <path>]
  onyx-worker exp list [--campaign <name>] [--status <status>] [--grep <regex>] [--limit <n>] [--json]
  onyx-worker knowledge add [--campaign <name>] --kind insight|dead_end|promising_direction|risk|transfer_note --title <text> --body <text> [--require-online]
  onyx-worker summary upsert [--campaign <name>] [--kind <kind>] [--session <uuid>] [--hypothesis <uuid>] [--worker <uuid>] [--title <text>] --body <text> [--require-online]

This CLI exposes the worker-safe primitive command surface. Users and
orchestrators may run it directly for debugging. Supervised workers are launched
with ONYX_WORKER_CONTEXT and isolated ONYX_HOME so their local state is pinned to
one worker runtime.
`

export async function workerMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const command = args.positional[0]
  const sub = args.positional[1]

  try {
    if (
      args.options.version === "true" ||
      command === "--version" ||
      command === "-v" ||
      command === "version"
    ) {
      console.log(packageJson.version)
      return
    }

    if (
      args.options.help === "true" ||
      command === "help" ||
      command === "--help" ||
      !command
    ) {
      console.log(WORKER_USAGE)
      return
    }

    await assertWorkerContextArgs(args)

    if (command === "research" && sub === "brief")
      return commandResearchBrief(args)
    if (command === "research" && sub === "should-stop")
      return commandResearchShouldStop(args)
    if (command === "tools" && sub === "run") return commandToolsRun(args)
    if (command === "exp" && sub === "run") return commandExpRun(args)
    if (command === "workflow" && sub === "status")
      return commandWorkflowStatus(args)
    if (command === "exp" && sub === "log") return commandExpLog(args)
    if (command === "exp" && sub === "list") return commandExpList(args)
    if (command === "knowledge" && sub === "add")
      return commandKnowledgeAdd(args)
    if (command === "summary" && sub === "upsert")
      return commandSummaryUpsert(args)

    console.error(`Unknown worker command: ${args.positional.join(" ")}`)
    console.error(WORKER_USAGE)
    process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
