import type { Args } from "./args"
import { getProjectDeletions, resolveProject, syncResearchEvents } from "./api"
import { apiTarget } from "./config"
import { pushRefs, repositoryUrl } from "./git"
import { resolveProjectPath } from "./project"
import {
  getResearchSiteId,
  applyProjectDeletions,
  applyRemoteTombstones,
  markResearchSyncAcked,
  markResearchSyncConflict,
  markResearchSyncError,
  pendingResearchSyncCount,
  pendingResearchSyncEvents,
} from "./research-db"
import { readState, withOnyxLock } from "./outbox"

export type FlushResult = {
  flushed: number
  pending: number
  offline: boolean
  skippedDeleted: number
  conflicts: number
}

function eventExperimentRef(event: {
  type: string
  payload: Record<string, unknown>
}) {
  if (event.type !== "experiment.logged") return null
  const experiment = event.payload.experiment
  if (!experiment || typeof experiment !== "object") return null
  const record = experiment as Record<string, unknown>
  const commitSha = record.resultCommitSha
  const ref = record.resultRef
  if (typeof commitSha !== "string" || typeof ref !== "string") return null
  return { commitSha, ref }
}

async function resolveProjectIdForDeletionFeed(root: string, args: Args) {
  if (args.options.project) return args.options.project
  const state = await readState(root)
  if (state.projectId) return state.projectId
  return (await resolveProject(root, args)).id
}

async function fetchAndApplyRemoteDeletions(root: string, args: Args) {
  const projectId = await resolveProjectIdForDeletionFeed(root, args)
  const deletions = await getProjectDeletions(projectId, args)
  await applyProjectDeletions({ root, deletions })
}

async function flushResearchDbEvents(
  root: string,
  args: Args,
  options: { quiet?: boolean } = {}
): Promise<FlushResult> {
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
    }
  }

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
      }
    } catch (error) {
      if (args.options["require-online"] === "true") throw error
      if (!options.quiet) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`SQLite tombstone refresh skipped: ${message}`)
      }
      return {
        flushed: 0,
        pending: 0,
        offline: true,
        skippedDeleted: 0,
        conflicts: 0,
      }
    }
  }

  const events = await pendingResearchSyncEvents(root, 500)
  const eventIds = events.map((event) => event.eventId)
  try {
    const refs = events.map(eventExperimentRef).filter(Boolean) as Array<{
      commitSha: string
      ref: string
    }>
    for (let index = 0; index < refs.length; index += 20) {
      await pushRefs(root, refs.slice(index, index + 20))
    }

    const response = await syncResearchEvents(
      {
        siteId: await getResearchSiteId(root),
        repositoryUrl: await repositoryUrl(
          root,
          args.options["repository-url"]
        ),
        projectPath: await resolveProjectPath(root, args),
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

    let flushed = 0
    let conflicts = 0
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
      await markResearchSyncError({
        root,
        eventIds: [acknowledgement.eventId],
        message: acknowledgement.message ?? "sync event was invalid",
      })
    }

    const remaining = await pendingResearchSyncCount(root)
    if (!options.quiet) {
      const target = await apiTarget(args)
      console.log(
        `Synced ${flushed} SQLite event(s)${target ? ` to ${target.url}` : ""}; ${remaining} pending.`
      )
      if (conflicts > 0) {
        console.log(
          `${conflicts} SQLite sync event(s) need conflict resolution.`
        )
      }
    }
    return {
      flushed,
      pending: remaining,
      offline: false,
      skippedDeleted: 0,
      conflicts,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markResearchSyncError({ root, eventIds, message }).catch(() => {})
    if (args.options["require-online"] === "true") {
      throw error
    }
    if (!options.quiet) {
      console.warn(`SQLite sync skipped: ${message}`)
    }
    return {
      flushed: 0,
      pending: await pendingResearchSyncCount(root),
      offline: true,
      skippedDeleted: 0,
      conflicts: 0,
    }
  }
}

export async function flushOutbox(
  root: string,
  args: Args,
  options: { quiet?: boolean } = {}
): Promise<FlushResult> {
  return withOnyxLock(root, "research-sync", () =>
    flushResearchDbEvents(root, args, options)
  )
}
