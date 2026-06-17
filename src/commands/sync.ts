import type { Args } from "../lib/args"
import { requestProjectSync, resolveProject } from "../lib/api"
import {
  apiTarget,
  describeApiTarget,
  profileNameFromArgs,
  readConfig,
} from "../lib/config"
import { emitEvent } from "../lib/events"
import { repoRoot } from "../lib/git"
import { hydrateHistoryFromApi } from "../lib/history"
import { readLastRun, readOutbox, readState } from "../lib/outbox"
import { resolveProjectPath } from "../lib/project"
import { flushOutbox } from "../lib/sync"

export async function commandPush(args: Args) {
  const root = await repoRoot()
  const result = await flushOutbox(root, args)
  await emitEvent(root, {
    type: "pushed",
    message: `${result.flushed} flushed, ${result.pending} pending`,
  })
}

export async function commandSync(args: Args) {
  const root = await repoRoot()
  const result = await flushOutbox(root, args)
  if (result.offline) return

  // Refresh the local history cache to the canonical API state. Runs even
  // when the outbox was empty so fresh clones pick up cross-branch history.
  try {
    const hydrated = await hydrateHistoryFromApi(root, args)
    console.log(
      `history: ${hydrated.experiments} experiment(s) across ${hydrated.campaigns} campaign(s)${
        hydrated.pendingLocal ? `, ${hydrated.pendingLocal} pending local` : ""
      }`
    )
  } catch (error) {
    console.warn(
      `History refresh skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  // Refresh repository metadata so file/diff views see the latest GitHub head.
  try {
    const project = await resolveProject(root, args)
    await requestProjectSync(project.id, args)
    console.log(`Requested repository sync for project ${project.id}`)
  } catch (error) {
    console.warn(
      `Repository sync skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export async function commandStatus(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const { records, corrupt } = await readOutbox(root)
  const lastRun = await readLastRun(root)
  const experiments = records.filter(
    (record) => record.type === "campaign_experiment_logged"
  ).length
  const campaigns = records.filter(
    (record) => record.type === "campaign_started"
  ).length

  const config = await readConfig()
  const profileName = profileNameFromArgs(args, config)
  const profile = profileName ? config.profiles[profileName] : undefined
  console.log(
    profile
      ? `profile: ${profileName} (${profile.teamName})`
      : "profile: (none)"
  )
  const target = await apiTarget(args)
  console.log(
    target
      ? `api: ${describeApiTarget(target)}`
      : "api: not configured (run `onyx login`)"
  )
  console.log(`campaign: ${state.activeCampaign ?? "(none)"}`)
  console.log(`projectPath: ${projectPath || "(repo root)"}`)
  console.log(
    `outbox: ${experiments} experiment(s), ${campaigns} campaign(s) pending${
      corrupt ? `, ${corrupt} unreadable` : ""
    }`
  )
  if (lastRun) {
    console.log(
      `last run: ${lastRun.resultCommitSha.slice(0, 7)} (${lastRun.status}, ${lastRun.primaryMetricName}=${lastRun.primaryMetricValue ?? "null"})`
    )
  }

  try {
    const project = await resolveProject(root, args)
    console.log(`project: ${project.name} (${project.id})`)
  } catch {
    console.log("project: not provisioned / offline")
  }
}
