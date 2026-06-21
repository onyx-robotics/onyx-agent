import { descriptionOption, nameOption, type Args } from "../lib/args"
import {
  deleteCampaign,
  listProjectCampaigns,
  resolveProject,
} from "../lib/api"
import { readSetupFile } from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, repoRoot } from "../lib/git"
import { readHistory, rewriteHistory } from "../lib/history"
import {
  readOutbox,
  readState,
  rewriteOutbox,
  writeState,
} from "../lib/outbox"
import { campaignStateKey, resolveProjectPath } from "../lib/project"
import {
  createLocalCampaign,
  getActiveLocalCampaignName,
  listLocalExperimentHistory,
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
  console.log(`session: ${stateCampaign?.sessionId ?? "(none)"}`)
}

export async function commandCampaignDelete(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const name = nameOption(args)
  await flushOutbox(root, args, { quiet: true }).catch(() => {})
  const state = await readState(root)
  const key = campaignStateKey(projectPath, name)
  let campaignId = state.campaigns?.[key]?.campaignId
  if (!campaignId) {
    const project = await resolveProject(root, args)
    const campaigns = await listProjectCampaigns(project.id, args)
    campaignId = campaigns.find((campaign) => campaign.name === name)?.id
  }
  if (!campaignId) {
    throw new Error(`Campaign ${name} is not synced or does not exist.`)
  }

  const result = await deleteCampaign(campaignId, args)
  const outbox = await readOutbox(root)
  await rewriteOutbox(
    root,
    outbox.records.filter((record) => {
      if (record.type === "campaign_started") return record.name !== name
      return record.campaignName !== name
    })
  )
  const history = await readHistory(root)
  const sqliteHistory = await listLocalExperimentHistory(root).catch(() => [])
  await rewriteHistory(
    root,
    history.records
      .filter((record) => record.campaignName !== name)
      .concat(
        sqliteHistory.filter((record) => record.campaignName !== name) as typeof history.records
      )
  )

  state.campaigns = state.campaigns ?? {}
  delete state.campaigns[key]
  if (state.activeCampaign === name) delete state.activeCampaign
  await writeState(root, state)
  await emitEvent(root, {
    type: "campaign_deleted",
    campaignName: name,
    campaignId,
    message: `${result.deletedExperimentCount} experiment(s)`,
  })
  console.log(`Deleted campaign ${name}`)
}
