import type {
  LocalResearchCampaignExperimentLoggedRecord,
  LocalResearchCampaignStartedRecord,
  LocalResearchRecord,
} from "../protocol"

import type { Args } from "./args"
import {
  ApiError,
  getProjectDeletions,
  listProjectCampaigns,
  reportCampaignExperiment,
  resolveProject,
  upsertCampaign,
  type ApiProject,
  type ApiProjectDeletions,
} from "./api"
import { apiTarget } from "./config"
import { filterDeletedOutboxRecords } from "./deletions"
import { emitEvent } from "./events"
import { pushRef, repositoryUrl } from "./git"
import { applyHistorySyncUpdates, type HistorySyncUpdate } from "./history"
import { campaignStateKey, normalizeProjectPath } from "./project"
import {
  readOutbox,
  readState,
  rewriteOutbox,
  writeState,
  type CliState,
} from "./outbox"

export type FlushResult = {
  flushed: number
  pending: number
  offline: boolean
  skippedDeleted: number
}

function campaignSecondaryMetrics(
  record: LocalResearchCampaignExperimentLoggedRecord
) {
  const rest: Record<string, number> = { ...record.metrics }
  delete rest[record.primaryMetricName]
  return rest
}

async function flushCampaignStarted({
  root,
  record,
  state,
  args,
}: {
  root: string
  record: LocalResearchCampaignStartedRecord
  state: CliState
  args: Args
}): Promise<ApiProject> {
  if (record.projectPath !== undefined) {
    state.projectPath = record.projectPath
  }
  const projectPath = state.projectPath ?? ""
  const result = await upsertCampaign(
    {
      repositoryUrl: await repositoryUrl(root, args.options["repository-url"]),
      projectPath,
      name: record.name,
      description: record.description ?? undefined,
      baseCommitSha: record.baseCommitSha,
      metricName: record.metricName,
      metricUnit: record.metricUnit ?? undefined,
      metricDirection: record.metricDirection,
      tools: record.tools ?? undefined,
      constraints: record.constraints ?? undefined,
      reset: record.reset ?? undefined,
      humanFeedback: record.humanFeedback ?? undefined,
      promotionRefName: record.promotionRefName ?? undefined,
    },
    args
  )
  state.projectId = result.project.id
  state.activeCampaign = record.name
  const key = campaignStateKey(projectPath, record.name)
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: result.campaign.id,
    setupId: result.setup.id,
    projectPath,
    baseCommitSha: record.baseCommitSha,
    description: record.description ?? null,
    metricName: record.metricName,
    metricUnit: record.metricUnit ?? null,
    metricDirection: record.metricDirection,
    promotionRefName: record.promotionRefName ?? null,
  }
  record.sync = {
    ...(record.sync ?? {}),
    projectId: result.project.id,
    campaignId: result.campaign.id,
    setupId: result.setup.id,
    syncedAt: new Date().toISOString(),
  }
  return result.project
}

async function campaignIdFromMetadata({
  root,
  campaignName,
  state,
  args,
}: {
  root: string
  campaignName: string
  state: CliState
  args: Args
}) {
  const projectPath = state.projectPath ?? ""
  const key = campaignStateKey(projectPath, campaignName)
  const cached = state.campaigns?.[key]?.campaignId
  if (cached) return cached

  const project = state.projectId
    ? ({ id: state.projectId } as ApiProject)
    : await resolveProject(root, args)
  const campaigns = await listProjectCampaigns(project.id, args)
  const campaign = campaigns.find(
    (candidate) => candidate.name === campaignName
  )
  if (!campaign) {
    throw new Error(
      `Campaign ${campaignName} is not synced yet. Run \`onyx campaign setup --name ${campaignName} --metric <metric>\`.`
    )
  }
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    projectPath,
    baseCommitSha: campaign.baseCommitSha,
    description: campaign.description,
    metricName: campaign.metricName,
    metricUnit: campaign.metricUnit,
    metricDirection: campaign.metricDirection,
    promotionRefName: campaign.promotionRefName,
    setupId: campaign.activeSetupId ?? state.campaigns?.[key]?.setupId,
  }
  return campaign.id
}

async function flushCampaignExperiment({
  root,
  record,
  state,
  args,
}: {
  root: string
  record: LocalResearchCampaignExperimentLoggedRecord
  state: CliState
  args: Args
}): Promise<HistorySyncUpdate> {
  if (record.projectPath !== undefined) {
    state.projectPath = record.projectPath
  }
  const campaignId = await campaignIdFromMetadata({
    root,
    campaignName: record.campaignName,
    state,
    args,
  })

  await pushRef(root, record.resultCommitSha, record.resultRef)

  const reported = await reportCampaignExperiment(
    campaignId,
    {
      name: record.name,
      description: record.description ?? undefined,
      runRef: record.runRef,
      setupId: record.setupId,
      baseCommitSha: record.baseCommitSha,
      resultCommitSha: record.resultCommitSha,
      resultRef: record.resultRef,
      status: record.status,
      primaryMetricName: record.primaryMetricName,
      primaryMetricValue: record.primaryMetricValue ?? undefined,
      secondaryMetrics: campaignSecondaryMetrics(record),
      artifactRefs: {},
      agentNotes: record.agentNotes,
      checks: record.checks
        ? {
            status: record.checks.status,
            durationMs: record.checks.durationMs ?? null,
            outputSummary: record.checks.outputSummary ?? null,
          }
        : undefined,
      durationMs: record.durationMs ?? undefined,
      outputSummary: record.outputSummary ?? undefined,
      startedAt: record.startedAt ?? undefined,
      completedAt: record.completedAt ?? undefined,
      sessionId: record.sessionId,
      workerId: record.workerId,
      laneId: record.laneId,
      provenance: [],
    },
    args
  )
  record.sync = {
    ...(record.sync ?? {}),
    campaignId,
    setupId: record.setupId,
    experimentId: reported.id,
    syncedAt: new Date().toISOString(),
  }
  return {
    experimentId: reported.id,
    campaignId,
    setupId: reported.setupId,
  }
}

export async function flushOutbox(
  root: string,
  args: Args,
  options: { quiet?: boolean } = {}
): Promise<FlushResult> {
  const { records, corrupt } = await readOutbox(root)
  if (corrupt > 0 && !options.quiet) {
    console.warn(`Skipped ${corrupt} unreadable outbox record(s).`)
  }
  if (records.length === 0) {
    return { flushed: 0, pending: 0, offline: false, skippedDeleted: 0 }
  }

  const state = await readState(root)
  const requestedProjectPath = normalizeProjectPath(
    args.options["project-path"]
  )
  const queuedProjectPath = records.find(
    (record) => record.projectPath !== undefined
  )?.projectPath
  state.projectPath =
    requestedProjectPath || queuedProjectPath || state.projectPath
  await writeState(root, state)

  let project: ApiProject | null = null
  try {
    project = await resolveProject(root, args)
    state.projectId = project.id
  } catch (error) {
    if (!options.quiet) {
      console.warn(
        `Project lookup skipped; campaign sync will lazily create it if GitHub access is available (${
          error instanceof Error ? error.message : String(error)
        })`
      )
    }
  }

  let deletions: ApiProjectDeletions | null = null
  if (project) {
    try {
      deletions = await getProjectDeletions(project.id, args)
    } catch {
      deletions = null
    }
  }
  const { kept, dropped } = filterDeletedOutboxRecords(records, deletions)
  let skippedDeleted = dropped

  const remaining: LocalResearchRecord[] = []
  const historyUpdates = new Map<string, HistorySyncUpdate>()
  let flushed = 0

  for (const record of kept) {
    try {
      if (record.type === "campaign_started") {
        project = await flushCampaignStarted({ root, record, state, args })
      } else {
        const update = await flushCampaignExperiment({
          root,
          record,
          state,
          args,
        })
        historyUpdates.set(record.runRef, update)
      }
      flushed += 1
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        skippedDeleted += 1
        continue
      }
      if (!(error instanceof ApiError) || error.status !== 409) {
        if (!options.quiet) {
          console.warn(
            `Keeping queued record after error: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
      remaining.push(record)
    }
  }

  await rewriteOutbox(root, remaining)
  await writeState(root, state)
  await applyHistorySyncUpdates(root, historyUpdates).catch(() => {})
  await emitEvent(root, {
    type: "flush_finished",
    message: `synced ${flushed}, pending ${remaining.length}`,
  })

  if (!options.quiet) {
    const target = await apiTarget(args)
    console.log(
      `Synced ${flushed} record(s)${target ? ` to ${target.url}` : ""}; ${remaining.length} pending.`
    )
    if (skippedDeleted > 0) {
      console.log(`Skipped ${skippedDeleted} record(s) deleted on the server.`)
    }
  }

  return {
    flushed,
    pending: remaining.length,
    offline: false,
    skippedDeleted,
  }
}
