import type { LocalResearchCampaignStartedRecord } from "../protocol"

import {
  descriptionOption,
  nameOption,
  type Args,
} from "../lib/args"
import { deleteCampaign, listProjectCampaigns, resolveProject } from "../lib/api"
import { readSetupFile } from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, repoRoot } from "../lib/git"
import { readHistory, rewriteHistory } from "../lib/history"
import {
  appendOutbox,
  readOutbox,
  readState,
  rewriteOutbox,
  writeState,
} from "../lib/outbox"
import { campaignStateKey, resolveProjectPath } from "../lib/project"
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

  const baseCommitSha = await currentCommit(root)
  const description = descriptionOption(args)
  const humanFeedback = args.options["human-feedback"] ?? null
  const promotionRefName =
    args.options["promotion-ref"] ?? `refs/heads/onyx/${name}/best`

  const record: LocalResearchCampaignStartedRecord = {
    schemaVersion: 1,
    type: "campaign_started",
    createdAt: new Date().toISOString(),
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
  }
  await appendOutbox(root, record)

  const state = await readState(root)
  const key = campaignStateKey(projectPath, name)
  state.projectPath = projectPath
  state.activeCampaign = name
  state.campaigns = {
    ...(state.campaigns ?? {}),
    [key]: {
      ...(state.campaigns ?? {})[key],
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

  await flushOutbox(root, args, { quiet: true }).catch(() => {})
}

export async function commandCampaignUse(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const name = nameOption(args)
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
  const name = args.options.name ?? state.activeCampaign
  if (!name) {
    console.log("campaign: none")
    return
  }
  const campaign = state.campaigns?.[campaignStateKey(projectPath, name)]
  console.log(`campaign: ${name}`)
  console.log(`id: ${campaign?.campaignId ?? "(not synced)"}`)
  console.log(`metric: ${campaign?.metricName ?? "(unknown)"}`)
  console.log(`base: ${campaign?.baseCommitSha ?? "(unknown)"}`)
  console.log(`session: ${campaign?.sessionId ?? "(none)"}`)
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
  await rewriteHistory(
    root,
    history.records.filter((record) => record.campaignName !== name)
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
