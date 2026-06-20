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
  reportCampaignExperimentsBatch,
  resolveProject,
  upsertCampaign,
  type ApiProject,
  type ApiProjectDeletions,
} from "./api"
import { apiTarget } from "./config"
import { filterDeletedOutboxRecords } from "./deletions"
import { emitEvent } from "./events"
import { pushRefs, repositoryUrl } from "./git"
import { applyHistorySyncUpdates, type HistorySyncUpdate } from "./history"
import { campaignStateKey, normalizeProjectPath } from "./project"
import {
  quarantineOutboxRecord,
  readOutbox,
  readState,
  rewriteOutboxUnlocked,
  withOnyxLock,
  writeState,
  type CliState,
} from "./outbox"

export type FlushResult = {
  flushed: number
  pending: number
  offline: boolean
  skippedDeleted: number
  conflicts: number
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
      setup: record.setup,
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
    projectPath,
    baseCommitSha: record.baseCommitSha,
    description: record.description ?? null,
    metricName: record.metricName,
    metricUnit: record.metricUnit ?? null,
    metricDirection: record.metricDirection,
    setup: record.setup,
    promotionRefName: record.promotionRefName ?? null,
  }
  record.sync = {
    ...(record.sync ?? {}),
    projectId: result.project.id,
    campaignId: result.campaign.id,
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
      `Campaign ${campaignName} is not synced yet. Run \`onyx campaign setup --name ${campaignName}\` after creating onyx/setup.json.`
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
  }
  return campaign.id
}

function experimentRequestFromRecord(
  record: LocalResearchCampaignExperimentLoggedRecord
) {
  return {
    name: record.name,
    description: record.description ?? undefined,
    runRef: record.runRef,
    setupCompliance: record.setupCompliance,
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
    hypothesisId: record.hypothesisId,
    provenance: [],
  }
}

function comparableExperimentRecord(
  record: LocalResearchCampaignExperimentLoggedRecord
) {
  const comparable: Partial<LocalResearchCampaignExperimentLoggedRecord> = {
    ...record,
  }
  delete comparable.createdAt
  delete comparable.sync
  return JSON.stringify(comparable)
}

function dedupeExperimentRecords(
  records: LocalResearchCampaignExperimentLoggedRecord[]
) {
  const byRunRef = new Map<
    string,
    LocalResearchCampaignExperimentLoggedRecord[]
  >()
  for (const record of records) {
    const group = byRunRef.get(record.runRef) ?? []
    group.push(record)
    byRunRef.set(record.runRef, group)
  }

  const byRunRefUnique: LocalResearchCampaignExperimentLoggedRecord[] = []
  const conflicts: LocalResearchCampaignExperimentLoggedRecord[] = []
  let duplicateCount = 0
  for (const group of byRunRef.values()) {
    if (group.length === 1) {
      byRunRefUnique.push(group[0]!)
      continue
    }
    const first = group[0]!
    const firstComparable = comparableExperimentRecord(first)
    const exact = group.every(
      (record) => comparableExperimentRecord(record) === firstComparable
    )
    if (exact) {
      duplicateCount += group.length - 1
      byRunRefUnique.push(first)
    } else {
      conflicts.push(...group)
    }
  }

  const byResultRef = new Map<
    string,
    LocalResearchCampaignExperimentLoggedRecord[]
  >()
  for (const record of byRunRefUnique) {
    const group = byResultRef.get(record.resultRef) ?? []
    group.push(record)
    byResultRef.set(record.resultRef, group)
  }

  const unique: LocalResearchCampaignExperimentLoggedRecord[] = []
  const conflictedRunRefs = new Set(conflicts.map((record) => record.runRef))
  for (const group of byResultRef.values()) {
    const commits = new Set(group.map((record) => record.resultCommitSha))
    if (commits.size > 1) {
      for (const record of group) conflictedRunRefs.add(record.runRef)
      conflicts.push(...group)
      continue
    }
    unique.push(...group)
  }

  return {
    unique: unique.filter((record) => !conflictedRunRefs.has(record.runRef)),
    duplicateCount,
    conflicts,
  }
}

async function flushCampaignExperimentBatch({
  root,
  campaignName,
  records,
  state,
  args,
}: {
  root: string
  campaignName: string
  records: LocalResearchCampaignExperimentLoggedRecord[]
  state: CliState
  args: Args
}): Promise<{
  flushed: LocalResearchCampaignExperimentLoggedRecord[]
  remaining: LocalResearchCampaignExperimentLoggedRecord[]
  historyUpdates: Map<string, HistorySyncUpdate>
  skippedDeleted: number
}> {
  const campaignId = await campaignIdFromMetadata({
    root,
    campaignName,
    state,
    args,
  })

  for (let index = 0; index < records.length; index += 20) {
    const chunk = records.slice(index, index + 20)
    await pushRefs(
      root,
      chunk.map((record) => ({
        commitSha: record.resultCommitSha,
        ref: record.resultRef,
      }))
    )
  }

  const flushed: LocalResearchCampaignExperimentLoggedRecord[] = []
  const remaining: LocalResearchCampaignExperimentLoggedRecord[] = []
  const historyUpdates = new Map<string, HistorySyncUpdate>()
  let skippedDeleted = 0

  for (let index = 0; index < records.length; index += 100) {
    const chunk = records.slice(index, index + 100)
    const response = await reportCampaignExperimentsBatch(
      campaignId,
      chunk.map(experimentRequestFromRecord),
      args
    )
    const byRunRef = new Map(
      response.results.map((result) => [result.runRef, result])
    )

    for (const record of chunk) {
      const result = byRunRef.get(record.runRef)
      if (!result || result.status === "invalid") {
        remaining.push(record)
        continue
      }
      if (result.status === "deleted") {
        skippedDeleted += 1
        continue
      }
      if (result.experiment) {
        record.sync = {
          ...(record.sync ?? {}),
          campaignId,
          experimentId: result.experiment.id,
          syncedAt: new Date().toISOString(),
        }
        historyUpdates.set(record.runRef, {
          experimentId: result.experiment.id,
          campaignId,
        })
      }
      flushed.push(record)
    }
  }

  return { flushed, remaining, historyUpdates, skippedDeleted }
}

export async function flushOutbox(
  root: string,
  args: Args,
  options: { quiet?: boolean } = {}
): Promise<FlushResult> {
  return withOnyxLock(root, "outbox", () =>
    flushOutboxUnlocked(root, args, options)
  )
}

async function flushOutboxUnlocked(
  root: string,
  args: Args,
  options: { quiet?: boolean } = {}
): Promise<FlushResult> {
  const { records, corrupt } = await readOutbox(root)
  if (corrupt > 0 && !options.quiet) {
    console.warn(`Skipped ${corrupt} unreadable outbox record(s).`)
  }
  if (records.length === 0) {
    return {
      flushed: 0,
      pending: 0,
      offline: false,
      skippedDeleted: 0,
      conflicts: 0,
    }
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
      const hasQueuedCampaignSetup = records.some(
        (record) => record.type === "campaign_started"
      )
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(
        hasQueuedCampaignSetup
          ? `Project lookup skipped before campaign sync; the queued campaign setup can create or reuse the project. If sync reports a missing base commit, push the base commit and run \`onyx sync\` again. (${detail})`
          : `Project lookup skipped; grant Onyx GitHub access to this repository or run \`onyx campaign setup\` before syncing. (${detail})`
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
  let conflictCount = 0

  const remaining: LocalResearchRecord[] = []
  const historyUpdates = new Map<string, HistorySyncUpdate>()
  let flushed = 0
  const experimentRecords = new Map<
    string,
    LocalResearchCampaignExperimentLoggedRecord[]
  >()

  for (const record of kept) {
    if (record.type === "campaign_experiment_logged") {
      const records = experimentRecords.get(record.campaignName) ?? []
      records.push(record)
      experimentRecords.set(record.campaignName, records)
      continue
    }

    try {
      if (record.type === "campaign_started") {
        project = await flushCampaignStarted({ root, record, state, args })
      }
      flushed += 1
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        skippedDeleted += 1
        continue
      }
      if (!options.quiet) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          error instanceof ApiError && error.status === 409
            ? `Keeping queued record after conflict: ${message}`
            : `Keeping queued record after error: ${message}`
        )
      }
      remaining.push(record)
    }
  }

  for (const [campaignName, records] of experimentRecords) {
    const deduped = dedupeExperimentRecords(records)
    conflictCount += deduped.conflicts.length
    for (const record of deduped.conflicts) {
      await quarantineOutboxRecord(
        root,
        record,
        `Conflicting queued experiment record for runRef ${record.runRef} or resultRef ${record.resultRef}.`
      ).catch(() => {})
    }
    if (deduped.duplicateCount > 0 && !options.quiet) {
      console.warn(
        `Dropped ${deduped.duplicateCount} duplicate queued experiment record(s) for ${campaignName}.`
      )
    }
    if (deduped.conflicts.length > 0 && !options.quiet) {
      console.warn(
        `Quarantined ${deduped.conflicts.length} conflicting queued experiment record(s) for ${campaignName}.`
      )
    }
    if (deduped.unique.length === 0) continue
    try {
      const result = await flushCampaignExperimentBatch({
        root,
        campaignName,
        records: deduped.unique,
        state,
        args,
      })
      flushed += result.flushed.length
      skippedDeleted += result.skippedDeleted
      for (const record of result.remaining) remaining.push(record)
      for (const [runRef, update] of result.historyUpdates) {
        historyUpdates.set(runRef, update)
      }
    } catch (error) {
      if (!options.quiet) {
        console.warn(
          `Keeping ${deduped.unique.length} queued experiment record(s) after error: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      remaining.push(...deduped.unique)
    }
  }

  await rewriteOutboxUnlocked(root, remaining)
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
    if (conflictCount > 0) {
      console.log(
        `Quarantined ${conflictCount} conflicting record(s) under .git/onyx/outbox.d/conflicts.`
      )
    }
  }

  return {
    flushed,
    pending: remaining.length,
    offline: false,
    skippedDeleted,
    conflicts: conflictCount,
  }
}
