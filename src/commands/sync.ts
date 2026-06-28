import type { Args } from "../lib/args"
import { resolveProject } from "../lib/api"
import {
  apiTarget,
  describeApiTarget,
  profileNameFromArgs,
  readConfig,
} from "../lib/config"
import { repoRoot } from "../lib/git"
import { readState } from "../lib/outbox"
import { resolveProjectPath } from "../lib/project"
import { removedSyncCommandMessage } from "../lib/sync"

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function commandPush(_args: Args) {
  void _args
  throw new Error(removedSyncCommandMessage("push"))
}

export async function commandSync(_args: Args) {
  void _args
  throw new Error(removedSyncCommandMessage("sync"))
}

export async function commandStatus(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const config = await readConfig()
  const profileName = profileNameFromArgs(args, config)
  const profile = profileName ? config.profiles[profileName] : undefined
  const target = await apiTarget(args)

  let project: Awaited<ReturnType<typeof resolveProject>> | null = null
  let projectError: string | null = null
  try {
    project = await resolveProject(root, args)
  } catch (error) {
    projectError = errorMessage(error)
  }

  const activeCampaign = state.activeCampaign
    ? (state.campaigns ?? {})[state.activeCampaign]
    : null
  const activeSessionId =
    activeCampaign?.sessionId ??
    Object.entries(state.sessions ?? {}).find(
      ([, session]) => session.status === "running"
    )?.[0] ??
    null

  if (args.options.json === "true") {
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
          projectPath,
          activeCampaign: state.activeCampaign ?? null,
          activeCampaignId: activeCampaign?.campaignId ?? null,
          activeSessionId,
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
  console.log(`projectPath: ${projectPath || "(repo root)"}`)
  console.log(`campaign: ${state.activeCampaign ?? "(none)"}`)
  console.log(`campaignId: ${activeCampaign?.campaignId ?? "(none)"}`)
  console.log(`sessionId: ${activeSessionId ?? "(none)"}`)
  if (project) {
    console.log(`project: ${project.name} (${project.id})`)
  } else {
    console.log(`project: unavailable${projectError ? ` (${projectError})` : ""}`)
  }
}
