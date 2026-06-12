import packageJson from "../package.json"

import { commandAgent } from "./commands/agent"
import { parseArgs } from "./lib/args"
import { commandExpList, commandExpLog, commandExpRun } from "./commands/exp"
import { commandBranchCreate } from "./commands/branch"
import { commandListen } from "./commands/listen"
import { commandLogin } from "./commands/login"
import { commandProfile } from "./commands/profile"
import { commandPush, commandStatus, commandSync } from "./commands/sync"

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
  onyx branch create --name <name> --metric <name> [--unit <unit>] [--direction maximize|minimize] [--description <text>] [--project-path <path>]
      (forks from the current git HEAD; when HEAD is on another onyx/* branch,
      that branch is recorded as the parent and the app nests it accordingly)
  onyx exp run [--branch <name>] [--timeout <seconds>] [--checks-timeout <seconds>] [--project-path <path>] [--no-log]
  onyx exp log [--branch <name>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>] [--commit <sha>] [--metric <value>] [--metric-name <name>] [--status succeeded|failed|checks_failed|accepted|rejected|running|queued] [--project-path <path>]
  onyx exp list [--branch <name>] [--status <status>] [--grep <regex>] [--limit <n>] [--json]
  onyx listen
  onyx status
  onyx push
  onyx sync [--project <id>] [--repository-url <url>] [--project-path <path>]

Results are reported to the Onyx app and queued in a local outbox
(.git/onyx/outbox.jsonl) when offline; \`onyx push\` and \`onyx sync\` flush the
queue and push the branch. \`onyx sync\` also refreshes the local history cache
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
    if (command === "branch" && sub === "create")
      return commandBranchCreate(args)
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
