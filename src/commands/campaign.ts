import { descriptionOption, nameOption, type Args } from "../lib/args"
import {
  deleteCampaign,
  getCampaignOverview,
  listProjectCampaigns,
  resolveProject,
  upsertCampaign,
} from "../lib/api"
import { readSetupFile } from "../lib/contract"
import { emitEvent } from "../lib/events"
import {
  currentCommit,
  normalizeRepositoryUrl,
  repoRoot,
  repositoryUrl,
} from "../lib/git"
import { readState, writeState } from "../lib/runtime-state"
import { campaignStateKey, resolveProjectPath } from "../lib/project"
import { assertSetupCommitted } from "../lib/setup-git"

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
  if (args.options.offline === "true") {
    throw new Error(
      "`--offline` was removed. Campaign setup writes directly to the Onyx API."
    )
  }

  const result = await upsertCampaign(
    {
      repositoryUrl: normalizeRepositoryUrl(
        await repositoryUrl(root, args.options["repository-url"])
      ),
      name,
      projectPath,
      ...(description ? { description } : {}),
      createdFromCommitSha: baseCommitSha,
      setup,
      ...(humanFeedback ? { humanFeedback } : {}),
      promotionRefName,
    },
    args
  )

  const state = await readState(root)
  const key = campaignStateKey(projectPath, name)
  state.projectId = result.project.id
  state.projectCache = {
    id: result.project.id,
    name: result.project.name,
    repositoryUrl: result.project.repositoryUrl,
    repositoryAccessMode: result.project.repositoryAccessMode,
    repositoryFullName: result.project.repositoryFullName,
    defaultBranch: result.project.defaultBranch,
    projectPath: result.project.projectPath,
    resolvedAt: new Date().toISOString(),
  }
  state.projectPath = projectPath
  state.activeCampaign = name
  state.campaigns = {
    ...(state.campaigns ?? {}),
    [key]: {
      ...(state.campaigns ?? {})[key],
      campaignId: result.campaign.id,
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
    campaignId: result.campaign.id,
    commitSha: baseCommitSha,
    message: name,
  })
  console.log(`Created campaign ${name}`)
  console.log(`Campaign id: ${result.campaign.id}`)
  console.log(`Base commit: ${baseCommitSha}`)
}

export async function commandCampaignUse(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const name = nameOption(args)
  const project = await resolveProject(root, args)
  const campaigns = await listProjectCampaigns(project.id, args)
  const campaign = campaigns.find((candidate) => candidate.name === name)
  if (!campaign) throw new Error(`Campaign ${name} was not found.`)
  const state = await readState(root)
  state.projectId = project.id
  state.projectCache = {
    id: project.id,
    name: project.name,
    repositoryUrl: project.repositoryUrl,
    repositoryAccessMode: project.repositoryAccessMode,
    repositoryFullName: project.repositoryFullName,
    defaultBranch: project.defaultBranch,
    projectPath: project.projectPath,
    resolvedAt: new Date().toISOString(),
  }
  state.projectPath = projectPath
  state.activeCampaign = name
  state.campaigns = state.campaigns ?? {}
  const key = campaignStateKey(projectPath, name)
  state.campaigns[key] = {
    ...(state.campaigns[key] ?? {}),
    campaignId: campaign.id,
    projectPath,
    baseCommitSha: campaign.createdFromCommitSha ?? undefined,
    description: campaign.description,
    metricName: campaign.metricName,
    metricUnit: campaign.metricUnit,
    metricDirection: campaign.metricDirection,
    promotionRefName: campaign.promotionRefName,
  }
  await writeState(root, state)
  console.log(`Using campaign ${name}`)
}

export async function commandCampaignStatus(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const name = args.options.name ?? state.activeCampaign ?? undefined
  if (!name) {
    console.log("campaign: none")
    return
  }
  const stateCampaign = state.campaigns?.[campaignStateKey(projectPath, name)]
  let campaign = null
  if (stateCampaign?.campaignId) {
    campaign = await getCampaignOverview(stateCampaign.campaignId, args)
      .then((overview) => overview.campaign)
      .catch(() => null)
  }
  if (!campaign) {
    const project = await resolveProject(root, args)
    campaign =
      (await listProjectCampaigns(project.id, args)).find(
        (candidate) => candidate.name === name
      ) ?? null
  }
  console.log(`campaign: ${name}`)
  console.log(`id: ${campaign?.id ?? stateCampaign?.campaignId ?? "(unknown)"}`)
  console.log(
    `metric: ${campaign?.metricName ?? stateCampaign?.metricName ?? "(unknown)"}`
  )
  console.log(
    `created from: ${campaign?.createdFromCommitSha ?? stateCampaign?.baseCommitSha ?? "(unknown)"}`
  )
  const promotionRefName =
    campaign?.promotionRefName ?? stateCampaign?.promotionRefName ?? null
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
  if (args.options.offline === "true") {
    throw new Error(
      "`--offline` was removed. Campaign deletion is applied directly through the Onyx API."
    )
  }
  const cachedCampaignId = state.campaigns?.[key]?.campaignId
  const campaignId =
    cachedCampaignId ??
    (await resolveProject(root, args)
      .then((project) => listProjectCampaigns(project.id, args))
      .then(
        (campaigns) => campaigns.find((campaign) => campaign.name === name)?.id
      ))
  if (!campaignId) throw new Error(`Campaign ${name} was not found.`)
  const result = await deleteCampaign(campaignId, args)

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
  console.log(`Deleted campaign ${name}`)
}
