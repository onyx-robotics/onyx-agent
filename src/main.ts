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
  commandResearchShouldStop,
  commandResearchStart,
  commandResearchStatus,
  commandResearchStop,
  commandKnowledgeAdd,
  commandSummaryUpsert,
  commandWorkerRun,
} from "./commands/research"
import {
  commandSetupInit,
  commandSetupModules,
  commandSetupOptional,
  commandSetupRequire,
  commandSetupValidate,
} from "./commands/setup"
import { commandPush, commandStatus, commandSync } from "./commands/sync"
import { commandToolsRun } from "./commands/tools"

export const USAGE = `onyx - research workflow CLI

Usage:
  onyx --version
  onyx developer status
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
  onyx campaign setup --name <name> [--description <text>] [--project-path <path>]
      (creates a campaign and draft setup; each measured experiment is pushed
      as an immutable refs/onyx/experiments/* ref; setup comes from onyx/setup.json)
  onyx tools run <name> [args...] [--project-path <path>] [--timeout <seconds>]
  onyx setup init [--project-path <path>] [--goal <text>] [--metric-name <name>] [--metric-unit <unit>] [--metric-direction maximize|minimize]
  onyx setup validate [--project-path <path>] [--modules <ids>] [--required]
  onyx setup modules [--project-path <path>]
  onyx setup require <module> [--project-path <path>] [--reason <text>]
  onyx setup optional <module> [--project-path <path>]
  onyx campaign use --name <name> [--project-path <path>]
  onyx campaign status [--name <name>] [--project-path <path>]
  onyx campaign delete --name <name> [--project-path <path>]
  onyx research start --campaign <name> [--agents <n>] [--lane-plans <json>] [--max-iterations <n>] [--max-minutes <n>]
      (creates an async research session and prints worker launch commands)
  onyx worker run --session <id> [--lane <id>] [--agent codex|claude] [--worker-command "<cmd>"] [--max-iterations <n>] [--max-minutes <n>] [--worker-timeout <seconds>] [--sync-interval <seconds>] [--final-sync-timeout <seconds>]
  onyx research should-stop [--session <id>] [--iteration <n>] [--json]
  onyx research stop [--session <id>] [--reason <text>]
  onyx research finish [--campaign <name>] [--session <id>]
  onyx research status [--campaign <name>]
  onyx summary upsert [--campaign <name>] [--kind <kind>] [--title <text>] --body <text>
  onyx knowledge add [--campaign <name>] --kind insight|dead_end|promising_direction|risk|transfer_note --title <text> --body <text>
  onyx exp run [--campaign <name>] [--timeout <seconds>] [--checks-timeout <seconds>] [--project-path <path>] [--no-log]
  onyx exp log [--campaign <name>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>] [--commit <sha>] [--base <sha>] [--result-ref <ref>] [--metric <value>] [--metric-name <name>] [--status succeeded|failed|checks_failed|setup_violation|accepted|rejected|running|queued] [--allow-unmeasured] [--project-path <path>]
  onyx exp list [--campaign <name>] [--status <status>] [--grep <regex>] [--limit <n>] [--json]
  onyx listen
  onyx status
  onyx push
  onyx sync [--watch] [--interval <seconds>] [--project <id>] [--repository-url <url>] [--project-path <path>]

Results are logged locally first in .git/onyx/outbox.d/pending/*.json. \`onyx push\`,
\`onyx sync\`, \`onyx sync --watch\`, and \`onyx research start\` flush the queue
and push immutable experiment refs. \`onyx sync\` also refreshes the local history cache
(.git/onyx/history.jsonl) that \`onyx exp list\` searches offline; \`onyx listen\`
is a live read-only view of the current repo's research session.

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
    if (command === "login") return commandLogin(args)
    if (command === "agent") return commandAgent(args)
    if (command === "profile") return commandProfile(args)
    if (command === "campaign" && sub === "setup")
      return commandCampaignCreate(args)
    if (command === "tools" && sub === "run") return commandToolsRun(args)
    if (command === "setup" && sub === "init") return commandSetupInit(args)
    if (command === "setup" && sub === "validate")
      return commandSetupValidate(args)
    if (command === "setup" && sub === "modules")
      return commandSetupModules(args)
    if (command === "setup" && sub === "require")
      return commandSetupRequire(args)
    if (command === "setup" && sub === "optional")
      return commandSetupOptional(args)
    if (command === "campaign" && sub === "use") return commandCampaignUse(args)
    if (command === "campaign" && sub === "status")
      return commandCampaignStatus(args)
    if (command === "campaign" && sub === "delete")
      return commandCampaignDelete(args)
    if (command === "research" && sub === "start")
      return commandResearchStart(args)
    if (command === "research" && sub === "should-stop")
      return commandResearchShouldStop(args)
    if (command === "research" && sub === "stop")
      return commandResearchStop(args)
    if (command === "research" && sub === "finish")
      return commandResearchFinish(args)
    if (command === "research" && sub === "status")
      return commandResearchStatus(args)
    if (command === "summary" && sub === "upsert")
      return commandSummaryUpsert(args)
    if (command === "knowledge" && sub === "add")
      return commandKnowledgeAdd(args)
    if (command === "worker" && sub === "run") return commandWorkerRun(args)
    if (command === "exp" && sub === "run") return commandExpRun(args)
    if (command === "exp" && sub === "log") return commandExpLog(args)
    if (command === "exp" && sub === "list") return commandExpList(args)
    if (command === "listen") return commandListen()
    if (command === "status") return commandStatus(args)
    if (command === "push") return commandPush(args)
    if (command === "sync") return commandSync(args)

    if (
      args.options.version === "true" ||
      command === "--version" ||
      command === "-v" ||
      command === "version"
    ) {
      console.log(packageJson.version)
      return
    }

    if (command === "help" || command === "--help" || !command) {
      console.log(USAGE)
      return
    }

    console.error(`Unknown command: ${args.positional.join(" ")}`)
    console.error(USAGE)
    process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
