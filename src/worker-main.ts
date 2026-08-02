import { commandExpList, commandExpLog, commandExpRun } from "./commands/exp"
import {
  commandKnowledgeAdd,
  commandKnowledgeList,
  commandResearchBrief,
  commandResearchSessionStateBrief,
} from "./commands/research"
import { commandToolsRun } from "./commands/tools"
import { commandWorkflowStatus } from "./commands/workflow"
import { parseArgs } from "./lib/args"
import { assertWorkerContextArgs } from "./lib/worker-context"
import { cliVersionInfo, renderCliVersion } from "./lib/version"
import { commandResearchFinish } from "./lib/worker-finish"

export const WORKER_USAGE = `onyx-worker - worker-safe Onyx research CLI

Usage:
  onyx-worker --version
  onyx-worker research brief [--campaign <name>] [--session <id>] [--hypothesis <id>] [--json]
  onyx-worker research session-state-brief [--json]
  onyx-worker research finish --reason hypothesis_exhausted|goal_satisfied|no_viable_change --summary <text>
  onyx-worker tools run <name> [args...] [--project-path <path>] [--timeout <seconds>]
  onyx-worker exp run (--campaign <name> [--base <sha>] | --resume [workflowRunId]) [--auto|--next] [--timeout <seconds>] [--checks-timeout <seconds>] [--project-path <path>]
  onyx-worker workflow status [--run <workflowRunId>] [--campaign <name>] [--active] [--blocked] [--project-path <path>] [--json]
  onyx-worker exp log [--campaign <name>] [--run-ref <ref>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>] [--commit <sha>] [--base <sha>] [--result-ref <ref>] [--metric <value>] [--metric-name <name>] [--status succeeded|failed|checks_failed|setup_violation|running|queued] [--allow-unmeasured] [--project-path <path>]
  onyx-worker exp list [--campaign <name>] [--status <status>] [--grep <regex>] [--limit <n>] [--json]
  onyx-worker knowledge add [--campaign <name>] --kind insight|dead_end|promising_direction|risk|transfer_note --title <text> --body <text> [--require-online]
  onyx-worker knowledge list [--campaign <name>] [--limit <n>] [--json]

This CLI exposes the worker-safe primitive command surface. Users and
orchestrators may run it directly for debugging. Supervised workers are launched
with ONYX_WORKER_CONTEXT and isolated ONYX_HOME so their local state is pinned to
one worker runtime. Inside a supervised worker runtime the campaign, session,
hypothesis, and worker identity default from ONYX_WORKER_CONTEXT; the identity
flags above are overrides for humans and orchestrators outside that runtime.
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
      console.log(
        args.options.json === "true"
          ? JSON.stringify(cliVersionInfo("onyx-worker"), null, 2)
          : renderCliVersion("onyx-worker")
      )
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

    if (command === "diagnostics" && sub === "handshake") {
      console.log(
        JSON.stringify(
          {
            ...cliVersionInfo("onyx-worker"),
            capabilities: [
              "session-state-brief",
              "experiment-report",
              "experiment-history",
              "knowledge",
              "heartbeat",
              "finish-marker",
            ],
          },
          null,
          2
        )
      )
      return
    }

    await assertWorkerContextArgs(args)

    if (command === "research" && sub === "brief")
      return commandResearchBrief(args)
    if (command === "research" && sub === "session-state-brief")
      return commandResearchSessionStateBrief(args)
    if (command === "research" && sub === "finish")
      return commandResearchFinish(args)
    if (command === "tools" && sub === "run") return commandToolsRun(args)
    if (command === "exp" && sub === "run") return commandExpRun(args)
    if (command === "workflow" && sub === "status")
      return commandWorkflowStatus(args)
    if (command === "exp" && sub === "log") return commandExpLog(args)
    if (command === "exp" && sub === "list") return commandExpList(args)
    if (command === "knowledge" && sub === "add")
      return commandKnowledgeAdd(args)
    if (command === "knowledge" && sub === "list")
      return commandKnowledgeList(args)
    console.error(`Unknown worker command: ${args.positional.join(" ")}`)
    console.error(WORKER_USAGE)
    process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
