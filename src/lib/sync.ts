import type { Args } from "./args"
import { getProjectDeletions, resolveProject, syncResearchEvents } from "./api"
import { apiTarget } from "./config"
import { pushRefs, repositoryUrl } from "./git"
import { resolveProjectPath } from "./project"
import {
  getResearchSiteId,
  applyProjectDeletions,
  applyRemoteProjectionDeltas,
  applyRemoteTombstones,
  markExperimentRefsVerified,
  markResearchSyncAcked,
  markResearchSyncConflict,
  markResearchSyncError,
  oldestPendingResearchSyncAgeMs,
  pendingResearchSyncCount,
  pendingResearchSyncEvents,
} from "./research-db"
import { readState, updateState, withOnyxLock } from "./outbox"

const DELETION_REFRESH_INTERVAL_MS = 60_000
const DEFAULT_SYNC_BATCH_SIZE = 50
const MAX_SYNC_BATCH_SIZE = 100

export type FlushResult = {
  flushed: number
  pending: number
  offline: boolean
  skippedDeleted: number
  conflicts: number
  batches: number
  lastDurationMs: number | null
  lastError: string | null
  oldestPendingAgeMs: number | null
}

function eventExperimentRef(event: {
  type: string
  payload: Record<string, unknown>
}) {
  if (event.type !== "experiment.logged") return null
  const experiment = event.payload.experiment
  if (!experiment || typeof experiment !== "object") return null
  const record = experiment as Record<string, unknown>
  const runRef = record.runRef
  const campaignId = record.campaignId
  const resultCommitSha = record.resultCommitSha
  const resultRef = record.resultRef
  if (
    typeof campaignId !== "string" ||
    typeof runRef !== "string" ||
    typeof resultCommitSha !== "string" ||
    typeof resultRef !== "string"
  ) {
    return null
  }
  return { campaignId, runRef, resultCommitSha, resultRef }
}

function boundedIntegerOption({
  args,
  name,
  fallback,
  min,
  max,
}: {
  args: Args
  name: string
  fallback: number
  min: number
  max: number
}) {
  const raw = args.options[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}.`)
  }
  return value
}

function syncBatchSizeOption(args: Args) {
  return boundedIntegerOption({
    args,
    name: "sync-batch-size",
    fallback: DEFAULT_SYNC_BATCH_SIZE,
    min: 1,
    max: MAX_SYNC_BATCH_SIZE,
  })
}

async function resolveProjectIdForDeletionFeed(root: string, args: Args) {
  if (args.options.project) return args.options.project
  const state = await readState(root)
  if (state.projectId) return state.projectId
  return (await resolveProject(root, args)).id
}

async function fetchAndApplyRemoteDeletions(root: string, args: Args) {
  const state = await readState(root)
  const lastDeletionFetchAt = state.projectCache?.lastDeletionFetchAt
    ? Date.parse(state.projectCache.lastDeletionFetchAt)
    : Number.NaN
  if (
    Number.isFinite(lastDeletionFetchAt) &&
    Date.now() - lastDeletionFetchAt < DELETION_REFRESH_INTERVAL_MS
  ) {
    return
  }
  const projectId = await resolveProjectIdForDeletionFeed(root, args)
  const deletions = await getProjectDeletions(projectId, args)
  await applyProjectDeletions({ root, deletions })
  await updateState(root, (state) => {
    if (state.projectCache?.id === projectId) {
      state.projectCache.lastDeletionFetchAt = new Date().toISOString()
    }
  }).catch(() => {})
}

async function flushResearchDbEventBatch({
  root,
  args,
  events,
}: {
  root: string
  args: Args
  events: Awaited<ReturnType<typeof pendingResearchSyncEvents>>
}): Promise<{
  flushed: number
  conflicts: number
  invalid: number
  offline: boolean
  lastError: string | null
}> {
  const eventIds = events.map((event) => event.eventId)
  try {
    const refs = events.map(eventExperimentRef).filter(Boolean) as Array<{
      campaignId: string
      runRef: string
      resultCommitSha: string
      resultRef: string
    }>
    for (let index = 0; index < refs.length; index += 20) {
      await pushRefs(
        root,
        refs.slice(index, index + 20).map((ref) => ({
          runRef: ref.runRef,
          commitSha: ref.resultCommitSha,
          ref: ref.resultRef,
        }))
      )
    }
    await markExperimentRefsVerified({
      root,
      refs: refs.map((ref) => ({
        runRef: ref.runRef,
        commitSha: ref.resultCommitSha,
        ref: ref.resultRef,
      })),
    })

    const response = await syncResearchEvents(
      {
        siteId: await getResearchSiteId(root),
        repositoryUrl: await repositoryUrl(
          root,
          args.options["repository-url"]
        ),
        projectPath: await resolveProjectPath(root, args),
        pushedExperimentRefs: refs,
        events: events.map((event) => ({
          eventId: event.eventId,
          sequence: event.sequence,
          type: event.type,
          entityType: event.entityType,
          entityId: event.entityId,
          payload: event.payload,
          createdAt: event.createdAt,
        })),
      },
      args
    )
    await applyRemoteTombstones({
      root,
      tombstones: response.tombstones,
    })
    await applyRemoteProjectionDeltas({
      root,
      deltas: response.projectionDeltas,
    })

    let flushed = 0
    let conflicts = 0
    let invalid = 0
    for (const acknowledgement of response.acknowledgements) {
      if (
        acknowledgement.status === "acked" ||
        acknowledgement.status === "duplicate"
      ) {
        await markResearchSyncAcked({
          root,
          eventId: acknowledgement.eventId,
          serverStatus: acknowledgement.status,
          serverEntityId: acknowledgement.entityId,
          details: {
            code: acknowledgement.code,
            message: acknowledgement.message,
            sequence: acknowledgement.sequence,
            ...(acknowledgement.details ?? {}),
          },
        })
        flushed += 1
        continue
      }
      if (acknowledgement.status === "conflict") {
        conflicts += 1
        await markResearchSyncConflict({
          root,
          eventId: acknowledgement.eventId,
          message: acknowledgement.message ?? "sync conflict",
        })
        continue
      }
      invalid += 1
      await markResearchSyncError({
        root,
        eventIds: [acknowledgement.eventId],
        message: acknowledgement.message ?? "sync event was invalid",
      })
    }
    return { flushed, conflicts, invalid, offline: false, lastError: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markResearchSyncError({ root, eventIds, message }).catch(() => {})
    if (args.options["require-online"] === "true") {
      throw error
    }
    return {
      flushed: 0,
      conflicts: 0,
      invalid: 0,
      offline: true,
      lastError: message,
    }
  }
}

async function flushResearchDbEvents(
  root: string,
  args: Args,
  options: { quiet?: boolean; maxBatches?: number } = {}
): Promise<FlushResult> {
  const startedAt = Date.now()
  let lastError: string | null = null
  let oldestPendingAgeMs = await oldestPendingResearchSyncAgeMs(root)
  if (args.options.offline === "true") {
    if (args.options["require-online"] === "true") {
      throw new Error("--offline and --require-online cannot be used together.")
    }
    const pendingCount = await pendingResearchSyncCount(root)
    if (!options.quiet) {
      console.log(
        `SQLite ledger has ${pendingCount} pending sync event(s); sync skipped by --offline.`
      )
    }
    return {
      flushed: 0,
      pending: pendingCount,
      offline: true,
      skippedDeleted: 0,
      conflicts: 0,
      batches: 0,
      lastDurationMs: Date.now() - startedAt,
      lastError: null,
      oldestPendingAgeMs,
    }
  }

  const batchSize = syncBatchSizeOption(args)
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY
  const pendingCount = await pendingResearchSyncCount(root)
  if (pendingCount === 0) {
    try {
      await fetchAndApplyRemoteDeletions(root, args)
      return {
        flushed: 0,
        pending: 0,
        offline: false,
        skippedDeleted: 0,
        conflicts: 0,
        batches: 0,
        lastDurationMs: Date.now() - startedAt,
        lastError: null,
        oldestPendingAgeMs: null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (args.options["require-online"] === "true") throw error
      if (!options.quiet) {
        console.warn(`SQLite tombstone refresh skipped: ${message}`)
      }
      return {
        flushed: 0,
        pending: 0,
        offline: true,
        skippedDeleted: 0,
        conflicts: 0,
        batches: 0,
        lastDurationMs: Date.now() - startedAt,
        lastError: message,
        oldestPendingAgeMs: null,
      }
    }
  }

  let flushed = 0
  let conflicts = 0
  let offline = false
  let batches = 0
  while (batches < maxBatches) {
    const beforePending = await pendingResearchSyncCount(root)
    if (beforePending === 0) break
    const events = await pendingResearchSyncEvents(root, batchSize)
    if (events.length === 0) break
    const result = await flushResearchDbEventBatch({ root, args, events })
    batches += 1
    flushed += result.flushed
    conflicts += result.conflicts
    offline = offline || result.offline
    lastError = result.lastError
    const remaining = await pendingResearchSyncCount(root)
    if (!options.quiet) {
      const target = await apiTarget(args)
      console.log(
        `Synced batch ${batches}: accepted=${result.flushed} conflicts=${result.conflicts} invalid=${result.invalid}${target ? ` to ${target.url}` : ""}; ${remaining} pending.`
      )
    }
    if (result.offline || remaining === 0) break
    if (
      remaining >= beforePending &&
      result.flushed === 0 &&
      result.conflicts === 0
    ) {
      lastError =
        result.invalid > 0
          ? "sync batch contained invalid events that remain pending"
          : "sync batch made no progress"
      break
    }
  }

  const remaining = await pendingResearchSyncCount(root)
  oldestPendingAgeMs = await oldestPendingResearchSyncAgeMs(root)
  if (!options.quiet && conflicts > 0) {
    console.log(`${conflicts} SQLite sync event(s) need conflict resolution.`)
  }
  return {
    flushed,
    pending: remaining,
    offline,
    skippedDeleted: 0,
    conflicts,
    batches,
    lastDurationMs: Date.now() - startedAt,
    lastError,
    oldestPendingAgeMs,
  }
}

export async function flushOutbox(
  root: string,
  args: Args,
  options: { quiet?: boolean; maxBatches?: number } = {}
): Promise<FlushResult> {
  return withOnyxLock(root, "research-sync", () =>
    flushResearchDbEvents(root, args, options)
  )
}
