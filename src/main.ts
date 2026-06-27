import packageJson from "../package.json"

import { commandAgent } from "./commands/agent"
import { parseArgs } from "./lib/args"
import {
  commandCampaignCreate,
  commandCampaignDelete,
  commandCampaignStatus,
  commandCampaignUse,
} from "./commands/campaign"
import { commandExpList, commandExpLog, commandExpRun } from "./commands/exp"
import { commandListen } from "./commands/listen"
import { commandLogin } from "./commands/login"
import { commandProfile } from "./commands/profile"
import {
  commandResearchFinish,
  commandResearchBrief,
  commandResearchHypothesisAdd,
  commandResearchHypotheses,
  commandResearchRun,
  commandResearchShouldStop,
  commandResearchStart,
  commandResearchStatus,
  commandResearchStop,
  commandKnowledgeAdd,
  commandKnowledgeList,
  commandSummaryList,
  commandSummaryUpsert,
  commandWorkerRun,
} from "./commands/research"
import { commandSetupInit, commandSetupValidate } from "./commands/setup"
import { commandPush, commandStatus, commandSync } from "./commands/sync"
import { commandToolsRun } from "./commands/tools"
import { commandWorkflowStatus } from "./commands/workflow"

export const USAGE = `onyx - research workflow CLI

Usage:
  onyx --version
  onyx developer status [--json]
  onyx developer link [path]
  onyx developer use dev [--skill-dir <path>] [--quiet]
  onyx developer use release [--skill-dir <path>] [--quiet]
  onyx developer sync-skill [--skill-dir <path>] [--quiet]
  onyx developer unlink [--skill-dir <path>] [--quiet]
  onyx login [--api-url <url>] [--local] [--print-url] [--refresh] [--port <port>] [--timeout <ms>]
  onyx agent skill-path
  onyx agent install-skill [--dir <path>] [--quiet]
  onyx profile list
  onyx profile use <name>
  onyx profile delete <name>
  onyx profile set-api-key-env <name> <ENV_VAR>
  onyx profile worker get [profile]
  onyx profile worker set [profile] --agent codex|claude|opencode [--model <model>]
  onyx profile worker clear [profile] (--all | --agent | --model codex|claude|opencode)
  onyx campaign setup --name <name> [--description <text>] [--project-path <path>] [--offline] [--require-online]
      (creates a campaign and draft setup; each measured experiment is pushed
      as an immutable refs/onyx/experiments/* ref; setup comes from onyx/setup.json)
  onyx tools run <name> [args...] [--project-path <path>] [--timeout <seconds>]
  onyx setup init [--project-path <path>] [--goal <text>] [--metric-name <name>] [--metric-unit <unit>] [--metric-direction maximize|minimize] [--editable-scope <paths>] [--eval-command <cmd>]
  onyx setup validate [--project-path <path>]
      (executes the required metric tool once and records setup readiness)
  onyx campaign use --name <name> [--project-path <path>]
  onyx campaign status [--name <name>] [--project-path <path>]
  onyx campaign delete --name <name> [--project-path <path>]
  onyx research start --campaign <name> [--workers <n>] [--agent codex|claude|opencode] [--model <model>] [--hypotheses <json-array>] (--experiments <n> | --max-minutes <n>)
      (creates an async research session and prints low-level worker launch commands)
  onyx research run --campaign <name> [--session <id>] [--workers <n>] [--max-concurrency <n>] [--launch-batch-size <n>] [--launch-interval-seconds <n>] [--provider-backoff-seconds <n>] [--heartbeat-sample-interval <seconds>] [--agent codex|claude|opencode] [--model <model>] [--worker-command "<cmd>"] [--hypotheses <json-array>] [--experiments <n>] [--max-minutes <n>] [--sync-interval <seconds>] [--sync-batch-size <1..100>] [--sync-drain-batches <n>] [--presence-interval <seconds>] [--final-sync-timeout <seconds>] [--foreground] [--json]
      (starts the local supervisor detached by default; use --foreground to attach)
  onyx research hypotheses --example
  onyx research hypothesis add (--campaign <name> | --session <id>) (--plan <json-file> | --focus <text> --hypothesis <text>) [--name <name>] [--base <sha>] [--agent codex|claude|opencode]
  onyx worker run --session <id> [--hypothesis <id>] [--agent codex|claude|opencode] [--model <model>] [--worker-command "<cmd>"] [--max-minutes <n>] [--worker-timeout <seconds>] [--startup-timeout <seconds>] [--stop-grace-seconds <n>] [--sync-interval <seconds>] [--final-sync-timeout <seconds>] [--quiet]
  onyx research should-stop [--session <id>] [--json]
  onyx research stop [--session <id>] [--reason <text>]
  onyx research finish [--campaign <name>] [--session <id>] [--final-sync-timeout <seconds>] [--require-online]
  onyx research brief [--campaign <name>] [--session <id>] [--hypothesis <id>] [--json]
  onyx research status [--campaign <name>] [--all-sessions] [--json] [--reconcile]
  onyx summary upsert [--campaign <name>] [--kind <kind>] [--session <uuid>] [--hypothesis <uuid>] [--worker <uuid>] [--title <text>] --body <text> [--sync] [--require-online]
  onyx summary list [--campaign <name>] [--kind <kind>] [--limit <n>] [--json]
  onyx knowledge add [--campaign <name>] --kind insight|dead_end|promising_direction|risk|transfer_note --title <text> --body <text> [--sync] [--require-online]
  onyx knowledge list [--campaign <name>] [--limit <n>] [--json]
  onyx exp run (--campaign <name> [--base <sha>] | --resume [workflowRunId]) [--auto|--next] [--timeout <seconds>] [--checks-timeout <seconds>] [--project-path <path>]
  onyx workflow status [--run <workflowRunId>] [--campaign <name>] [--active] [--blocked] [--project-path <path>] [--json]
  onyx exp log [--campaign <name>] [--run-ref <ref>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>] [--commit <sha>] [--base <sha>] [--result-ref <ref>] [--metric <value>] [--metric-name <name>] [--status succeeded|failed|checks_failed|setup_violation|accepted|rejected|running|queued] [--allow-unmeasured] [--project-path <path>]
  onyx exp list [--campaign <name>] [--status <status>] [--grep <regex>] [--limit <n>] [--json]
  onyx listen
  onyx status [--json]
  onyx push
  onyx sync [--watch] [--interval <seconds>] [--sync-batch-size <1..100>] [--project <id>] [--repository-url <url>] [--project-path <path>] [--offline] [--require-online]
  onyx sync status
  onyx sync conflicts [--json]
  onyx sync retry
  onyx sync export [--campaign <name>]
  onyx sync doctor

Worker primitives are exposed through the separate worker-safe entrypoint:
  onyx-worker research brief [--campaign <name>] [--session <id>] [--hypothesis <id>] [--json]
  onyx-worker research should-stop [--session <id>] [--json]
  onyx-worker exp run (--campaign <name> [--base <sha>] | --resume [workflowRunId]) [--auto|--next]
  onyx-worker exp log [--campaign <name>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>]
  onyx-worker tools run <name> [args...]
  onyx-worker sync status

Results and research control-plane state are logged locally first in
.git/onyx/research.db. \`onyx push\`, \`onyx sync\`, \`onyx sync --watch\`, and
workers push immutable experiment refs and flush SQLite sync events. Pass
\`--offline\` to suppress network attempts, or \`--require-online\` when a command
must fail unless the app acknowledges the local events. \`onyx exp list\`
searches the local SQLite projection offline; \`onyx listen\` is a live
read-only view of the current repo's research session.

Env:
  ONYX_API_KEY   overrides the selected profile API key
  ONYX_API_URL   overrides the selected profile API URL
  ONYX_RESEARCH_DB overrides the local SQLite research ledger path
  Profiles may store a key locally or read it from apiKeyEnv
`

export async function main(argv = process.argv.slice(2)) {
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
      console.log(USAGE)
      return
    }

    if (process.env.ONYX_WORKER_CONTEXT || process.env.ONYX_WORKER_ID) {
      throw new Error(
        "The full `onyx` CLI is not available inside a worker runtime. Use `onyx-worker` for worker-safe research commands."
      )
    }

    if (command === "login") return commandLogin(args)
    if (command === "agent") return commandAgent(args)
    if (command === "profile") return commandProfile(args)
    if (command === "campaign" && sub === "setup")
      return commandCampaignCreate(args)
    if (command === "tools" && sub === "run") return commandToolsRun(args)
    if (command === "setup" && sub === "init") return commandSetupInit(args)
    if (command === "setup" && sub === "validate")
      return commandSetupValidate(args)
    if (
      command === "setup" &&
      (sub === "modules" || sub === "require" || sub === "optional")
    ) {
      throw new Error("Setup modules were removed. Use `onyx setup validate`.")
    }
    if (command === "campaign" && sub === "use") return commandCampaignUse(args)
    if (command === "campaign" && sub === "status")
      return commandCampaignStatus(args)
    if (command === "campaign" && sub === "delete")
      return commandCampaignDelete(args)
    if (command === "research" && sub === "start")
      return commandResearchStart(args)
    if (command === "research" && sub === "run") return commandResearchRun(args)
    if (command === "research" && sub === "hypotheses")
      return commandResearchHypotheses(args)
    if (command === "research" && sub === "lane") {
      throw new Error(
        "Lanes have been replaced by hypotheses. Use `onyx research hypothesis add`."
      )
    }
    if (
      command === "research" &&
      sub === "hypothesis" &&
      args.positional[2] === "add"
    )
      return commandResearchHypothesisAdd(args)
    if (command === "research" && sub === "should-stop")
      return commandResearchShouldStop(args)
    if (command === "research" && sub === "stop")
      return commandResearchStop(args)
    if (command === "research" && sub === "finish")
      return commandResearchFinish(args)
    if (command === "research" && sub === "brief")
      return commandResearchBrief(args)
    if (command === "research" && sub === "status")
      return commandResearchStatus(args)
    if (command === "summary" && sub === "upsert")
      return commandSummaryUpsert(args)
    if (command === "summary" && sub === "list") return commandSummaryList(args)
    if (command === "knowledge" && sub === "add")
      return commandKnowledgeAdd(args)
    if (command === "knowledge" && sub === "list")
      return commandKnowledgeList(args)
    if (command === "worker" && sub === "run") return commandWorkerRun(args)
    if (command === "exp" && sub === "run") return commandExpRun(args)
    if (command === "exp" && sub === "log") return commandExpLog(args)
    if (command === "exp" && sub === "list") return commandExpList(args)
    if (command === "workflow" && sub === "status")
      return commandWorkflowStatus(args)
    if (command === "listen") return commandListen()
    if (command === "status") return commandStatus(args)
    if (command === "push") return commandPush(args)
    if (command === "sync") return commandSync(args)

    console.error(`Unknown command: ${args.positional.join(" ")}`)
    console.error(USAGE)
    process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
