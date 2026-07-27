import { commandAgent } from "./commands/agent"
import { parseArgs } from "./lib/args"
import { cliVersionInfo, renderCliVersion } from "./lib/version"
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
  commandResearchBrief,
  commandResearchClean,
  commandResearchHypothesisAdd,
  commandResearchHypothesisClose,
  commandResearchHypothesisList,
  commandResearchHypothesisReopen,
  commandResearchHypotheses,
  commandResearchSessionStateBrief,
  commandResearchRun,
  commandResearchScale,
  commandResearchStatus,
  commandResearchStop,
  commandKnowledgeAdd,
  commandKnowledgeList,
  commandWorkerRun,
} from "./commands/research"
import { commandSetupInit, commandSetupValidate } from "./commands/setup"
import { commandStatus } from "./commands/status"
import { commandToolsRun } from "./commands/tools"
import { commandWorkflowStatus } from "./commands/workflow"
import { removedResearchSyncCommandMessage } from "./lib/removed-commands"

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
  onyx campaign setup --name <name> [--description <text>] [--project-path <path>]
      (creates a campaign and draft setup; each measured experiment is pushed
      as an immutable refs/onyx/experiments/* ref; setup comes from onyx/setup.json)
  onyx tools run <name> [args...] [--project-path <path>] [--timeout <seconds>]
  onyx setup init [--project-path <path>] [--goal <text>] [--metric-name <name>] [--metric-unit <unit>] [--metric-direction maximize|minimize] [--editable-scope <paths>] [--eval-command <cmd>]
  onyx setup validate [--project-path <path>]
      (executes the required metric tool once and records setup readiness)
  onyx campaign use --name <name> [--project-path <path>]
  onyx campaign status [--name <name>] [--project-path <path>]
  onyx campaign delete --name <name> [--project-path <path>]
  onyx research run --campaign <name> [--workers <n>] [--hypothesis <name-or-id>]... [--base <ref>] [--hypothesis-base <hypothesis>=<ref|experiment:id>]... [--new] [--experiments <n>] [--max-minutes <n>] [--agent codex|claude|opencode] [--model <model>] [--foreground] [--json]
      (always creates a new bounded session; starts its local supervisor detached by default)
  onyx research hypotheses --example
  onyx research hypothesis list --campaign <name> [--json]
  onyx research hypothesis add --campaign <name> (--plan <json-file> | --focus <text> --hypothesis <text>) [--name <name>]
  onyx research hypothesis close --campaign <name> --hypothesis <name-or-id> [--reason <text>]
  onyx research hypothesis reopen --campaign <name> --hypothesis <name-or-id>
  onyx worker run --session <id> [--hypothesis <id>] [--agent codex|claude|opencode] [--model <model>] [--worker-command "<cmd>"] [--max-minutes <n>] [--worker-timeout <seconds>] [--startup-timeout <seconds>] [--stop-grace-seconds <n>] [--quiet]
  onyx research stop [--session <id>] [--reason <text>]
  onyx research scale --workers <n> [--session <id>]
  onyx research clean [--dry-run]
  onyx research brief [--campaign <name>] [--session <id>] [--hypothesis <id>] [--json]
  onyx research status [--campaign <name>] [--all-sessions] [--summary] [--json] [--reconcile]
  onyx knowledge add [--campaign <name>] --kind insight|dead_end|promising_direction|risk|transfer_note --title <text> --body <text> [--require-online]
  onyx knowledge list [--campaign <name>] [--limit <n>] [--json]
  onyx exp run (--campaign <name> [--base <sha>] | --resume [workflowRunId]) [--auto|--next] [--timeout <seconds>] [--checks-timeout <seconds>] [--project-path <path>]
  onyx workflow status [--run <workflowRunId>] [--campaign <name>] [--active] [--blocked] [--project-path <path>] [--json]
  onyx exp log [--campaign <name>] [--run-ref <ref>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>] [--commit <sha>] [--base <sha>] [--result-ref <ref>] [--metric <value>] [--metric-name <name>] [--status succeeded|failed|checks_failed|setup_violation|running|queued] [--allow-unmeasured] [--project-path <path>]
  onyx exp list [--campaign <name>] [--status <status>] [--disposition all|received|accepted|discarded] [--grep <regex>] [--limit <n>] [--json]
  onyx listen
  onyx status [--json]

Worker primitives are exposed through the separate worker-safe entrypoint:
  onyx-worker research brief [--campaign <name>] [--session <id>] [--hypothesis <id>] [--json]
  onyx-worker research session-state-brief [--json]
  onyx-worker exp run (--campaign <name> [--base <sha>] | --resume [workflowRunId]) [--auto|--next]
  onyx-worker exp log [--campaign <name>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>]
  onyx-worker tools run <name> [args...]

Research control-plane state is remote-first through /api/v1. Local files under
.git/onyx/ hold runtime logs, workflow runs, transient pending-report outbox entries, resource locks,
session-state briefs, and convenience state only. Workers push immutable
experiment refs before reporting results; \`onyx exp list\`, \`onyx research status\`,
and knowledge read from the remote API.

Env:
  ONYX_API_KEY   overrides the selected profile API key
  ONYX_API_URL   overrides the selected profile API URL
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
      console.log(
        args.options.json === "true"
          ? JSON.stringify(cliVersionInfo("onyx"), null, 2)
          : renderCliVersion("onyx")
      )
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
    if (
      command === "research" &&
      sub === "hypothesis" &&
      args.positional[2] === "list"
    )
      return commandResearchHypothesisList(args)
    if (
      command === "research" &&
      sub === "hypothesis" &&
      args.positional[2] === "close"
    )
      return commandResearchHypothesisClose(args)
    if (
      command === "research" &&
      sub === "hypothesis" &&
      args.positional[2] === "reopen"
    )
      return commandResearchHypothesisReopen(args)
    if (command === "research" && sub === "session-state-brief")
      return commandResearchSessionStateBrief(args)
    if (command === "research" && sub === "stop")
      return commandResearchStop(args)
    if (command === "research" && sub === "scale")
      return commandResearchScale(args)
    if (command === "research" && sub === "clean")
      return commandResearchClean(args)
    if (command === "research" && sub === "brief")
      return commandResearchBrief(args)
    if (command === "research" && sub === "status")
      return commandResearchStatus(args)
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
    if (command === "listen") return commandListen(args)
    if (command === "status") return commandStatus(args)
    if (command === "push")
      throw new Error(removedResearchSyncCommandMessage("push"))
    if (command === "sync")
      throw new Error(removedResearchSyncCommandMessage("sync"))

    console.error(`Unknown command: ${args.positional.join(" ")}`)
    console.error(USAGE)
    process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
