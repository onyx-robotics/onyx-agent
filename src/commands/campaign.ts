import { descriptionOption, nameOption, type Args } from "../lib/args"
import { readSetupFile } from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, repoRoot } from "../lib/git"
import { readState, writeState } from "../lib/outbox"
import { campaignStateKey, resolveProjectPath } from "../lib/project"
import {
  createLocalCampaign,
  deleteLocalCampaignWithTombstone,
  getActiveLocalCampaignName,
  localCampaignByName,
  setActiveLocalCampaign,
} from "../lib/research-db"
import { assertSetupCommitted } from "../lib/setup-git"
import { flushOutbox } from "../lib/sync"

export async function commandCampaignCreate(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const name = nameOption(args)
  const setup = await readSetupFile(root, projectPath)
  if (setup.projectPath !== projectPath) {
    throw new Error(
      `onyx/setup.json projectPath is "${setup.projectPath}", but the active project path is "${projectPath}".`
    )
  }

  await assertSetupCommitted({ root, projectPath })
  const baseCommitSha = await currentCommit(root)
  const description = descriptionOption(args)
  const humanFeedback = args.options["human-feedback"] ?? null
  const promotionRefName =
    args.options["promotion-ref"] ?? `refs/heads/onyx/${name}/best`

  const localCampaign = await createLocalCampaign({
    root,
    name,
    description,
    projectPath,
    baseCommitSha,
    setup,
    metricName: setup.metric.name,
    metricUnit: setup.metric.unit,
    metricDirection: setup.metric.direction,
    humanFeedback,
    promotionRefName,
  })

  const state = await readState(root)
  const key = campaignStateKey(projectPath, name)
  state.projectPath = projectPath
  state.activeCampaign = name
  state.campaigns = {
    ...(state.campaigns ?? {}),
    [key]: {
      ...(state.campaigns ?? {})[key],
      campaignId: localCampaign.id,
      projectPath,
      baseCommitSha,
      description,
      metricName: setup.metric.name,
      metricUnit: setup.metric.unit,
      metricDirection: setup.metric.direction,
      setup,
      humanFeedback,
      promotionRefName,
    },
  }
  await writeState(root, state)

  await emitEvent(root, {
    type: "campaign_created",
    campaignName: name,
    commitSha: baseCommitSha,
    message: name,
  })
  console.log(`Created campaign ${name}`)
  console.log(`Base commit: ${baseCommitSha}`)

  if (args.options.offline === "true") {
    console.log("Saved locally in SQLite; sync skipped by --offline.")
    return
  }

  const syncResult = await flushOutbox(root, args).catch((error) => {
    if (args.options["require-online"] === "true") throw error
    console.warn(
      `Campaign sync skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  })
  if (syncResult && syncResult.pending > 0) {
    console.warn(
      [
        "Campaign setup is saved locally but not fully synced.",
        "If the server says the base commit is missing, push the base commit to the repository remote, then run `onyx sync`.",
      ].join(" ")
    )
  }
}

export async function commandCampaignUse(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const name = nameOption(args)
  await setActiveLocalCampaign({ root, projectPath, campaignName: name })
  const state = await readState(root)
  state.projectPath = projectPath
  state.activeCampaign = name
  state.campaigns = state.campaigns ?? {}
  state.campaigns[campaignStateKey(projectPath, name)] = state.campaigns[
    campaignStateKey(projectPath, name)
  ] ?? { projectPath }
  await writeState(root, state)
  console.log(`Using campaign ${name}`)
}

export async function commandCampaignStatus(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const name =
    args.options.name ??
    state.activeCampaign ??
    (await getActiveLocalCampaignName(root)) ??
    undefined
  if (!name) {
    console.log("campaign: none")
    return
  }
  const localCampaign = await localCampaignByName({ root, projectPath, name })
  const stateCampaign = state.campaigns?.[campaignStateKey(projectPath, name)]
  console.log(`campaign: ${name}`)
  console.log(
    `id: ${localCampaign?.id ?? stateCampaign?.campaignId ?? "(not synced)"}`
  )
  console.log(
    `metric: ${localCampaign?.metricName ?? stateCampaign?.metricName ?? "(unknown)"}`
  )
  console.log(
    `base: ${localCampaign?.baseCommitSha ?? stateCampaign?.baseCommitSha ?? "(unknown)"}`
  )
  const promotionRefName =
    localCampaign?.promotionRefName ?? stateCampaign?.promotionRefName ?? null
  if (promotionRefName) {
    console.log(`configured promotion ref: ${promotionRefName}`)
  }
  console.log(`session: ${stateCampaign?.sessionId ?? "(none)"}`)
}

export async function commandCampaignDelete(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const name = nameOption(args)
  const state = await readState(root)
  const key = campaignStateKey(projectPath, name)
  const result = await deleteLocalCampaignWithTombstone({
    root,
    projectPath,
    name,
    reason: args.options.reason ?? "campaign deleted locally",
  })

  state.campaigns = state.campaigns ?? {}
  delete state.campaigns[key]
  if (state.activeCampaign === name) delete state.activeCampaign
  await writeState(root, state)
  await emitEvent(root, {
    type: "campaign_deleted",
    campaignName: name,
    campaignId: result.campaignId,
    message: `${result.deletedExperimentCount} experiment(s)`,
  })
  if (args.options.offline !== "true") {
    await flushOutbox(root, args, { quiet: true }).catch((error) => {
      if (args.options["require-online"] === "true") throw error
      console.warn(
        `Campaign delete sync skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  }
  console.log(`Deleted campaign ${name}`)
}
