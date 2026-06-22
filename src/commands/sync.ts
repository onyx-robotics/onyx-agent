import type { Args } from "../lib/args"
import { resolveProject } from "../lib/api"
import {
  apiTarget,
  describeApiTarget,
  profileNameFromArgs,
  readConfig,
} from "../lib/config"
import { emitEvent } from "../lib/events"
import { repoRoot } from "../lib/git"
import { readState } from "../lib/outbox"
import { resolveProjectPath } from "../lib/project"
import {
  listLocalCampaigns,
  listLocalAttempts,
  listLocalExperimentHistory,
  listResearchSyncConflicts,
  pendingResearchSyncCount,
  researchDbDoctor,
  researchSyncConflictCount,
  researchSyncStatus,
  retryResearchSyncConflicts,
} from "../lib/research-db"
import { flushOutbox } from "../lib/sync"

function positiveNumberOption(args: Args, name: string, fallback: number) {
  const raw = args.options[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive number`)
  }
  return parsed
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

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
  const sub = args.positional[1]
  if (sub === "status") {
    console.log(JSON.stringify(await researchSyncStatus(root), null, 2))
    return
  }
  if (sub === "conflicts") {
    const conflicts = await listResearchSyncConflicts(root)
    if (args.options.json === "true") {
      console.log(JSON.stringify(conflicts, null, 2))
      return
    }
    if (conflicts.length === 0) {
      console.log("No SQLite sync conflicts.")
      return
    }
    for (const conflict of conflicts) {
      const payloadSummary = JSON.stringify(conflict.payload).slice(0, 240)
      console.log(
        [
          `${conflict.sequence} ${conflict.eventId}`,
          conflict.type,
          `${conflict.entityType}:${conflict.entityId}`,
          conflict.lastError ? `error=${conflict.lastError}` : null,
          `payload=${payloadSummary}`,
        ]
          .filter(Boolean)
          .join(" ")
      )
    }
    return
  }
  if (sub === "retry") {
    const retried = await retryResearchSyncConflicts(root)
    console.log(`Retried ${retried} conflict event(s).`)
    return
  }
  if (sub === "doctor") {
    console.log(JSON.stringify(await researchDbDoctor(root), null, 2))
    return
  }
  if (sub === "export") {
    const campaignName = args.options.campaign
    const campaigns = (await listLocalCampaigns(root)).filter(
      (campaign) => !campaignName || campaign.name === campaignName
    )
    const campaignNames = new Set(campaigns.map((campaign) => campaign.name))
    const experiments = (await listLocalExperimentHistory(root)).filter(
      (experiment) => campaignNames.has(experiment.campaignName)
    )
    console.log(JSON.stringify({ campaigns, experiments }, null, 2))
    return
  }

  if (args.options.watch === "true") {
    const intervalMs = positiveNumberOption(args, "interval", 5) * 1000
    console.log(`Watching SQLite ledger; syncing every ${intervalMs / 1000}s.`)
    while (true) {
      await flushOutbox(root, args).catch((error) => {
        console.warn(
          `Sync attempt failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
      await sleep(intervalMs)
    }
  }

  const result = await flushOutbox(root, args)
  if (result.offline) return
}

export async function commandStatus(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  let ledgerLine: string
  try {
    const [sqlitePending, sqliteConflicts] = await Promise.all([
      pendingResearchSyncCount(root),
      researchSyncConflictCount(root),
    ])
    ledgerLine = `ledger: ${sqlitePending} SQLite sync event(s) pending, ${sqliteConflicts} conflict(s)`
  } catch (error) {
    ledgerLine = `ledger: unavailable (${errorMessage(error)})`
  }
  const lastRuns = await listLocalAttempts(root).catch(() => [])

  const config = await readConfig()
  const profileName = profileNameFromArgs(args, config)
  const profile = profileName ? config.profiles[profileName] : undefined
  const target = await apiTarget(args)
  let project:
    | Awaited<ReturnType<typeof resolveProject>>
    | null = null
  let projectError: string | null = null
  try {
    project = await resolveProject(root, args)
  } catch (error) {
    projectError = errorMessage(error)
  }
  if (args.options.json === "true") {
    const [sqlitePending, sqliteConflicts] = await Promise.all([
      pendingResearchSyncCount(root).catch(() => null),
      researchSyncConflictCount(root).catch(() => null),
    ])
    console.log(
      JSON.stringify(
        {
          profile: profileName
            ? {
                name: profileName,
                teamName: profile?.teamName ?? null,
              }
            : null,
          apiTarget: target ? describeApiTarget(target) : null,
          activeCampaign: state.activeCampaign ?? null,
          projectPath,
          ledger: {
            pending: sqlitePending,
            conflicts: sqliteConflicts,
          },
          lastRun: lastRuns[0] ?? null,
          project,
          projectError,
        },
        null,
        2
      )
    )
    return
  }
  console.log(
    profile
      ? `profile: ${profileName} (${profile.teamName})`
      : "profile: (none)"
  )
  console.log(
    target
      ? `api: ${describeApiTarget(target)}`
      : "api: not configured (run `onyx login`)"
  )
  console.log(`campaign: ${state.activeCampaign ?? "(none)"}`)
  console.log(`projectPath: ${projectPath || "(repo root)"}`)
  console.log(ledgerLine)
  if (lastRuns.length > 0) {
    const lastRun = lastRuns[0]!
    console.log(
      `last run: ${lastRun.resultCommitSha.slice(0, 7)} (${lastRun.status}, ${lastRun.primaryMetricName}=${lastRun.primaryMetricValue ?? "null"})${
        lastRuns.length > 1 ? `, ${lastRuns.length - 1} more unlogged` : ""
      }`
    )
  }

  if (project) {
    console.log(`project: ${project.name} (${project.id})`)
  } else {
    console.log("project: not provisioned / offline")
  }
}
