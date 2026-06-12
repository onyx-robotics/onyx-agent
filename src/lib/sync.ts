import type {
  LocalResearchExperimentLoggedRecord,
  LocalResearchBranchStartedRecord,
  LocalResearchRecord,
} from "../protocol"

import type { Args } from "./args"
import {
  ApiError,
  getProjectDeletions,
  listProjectBranches,
  reportExperiment,
  resolveProject,
  upsertBranch,
  type ApiProject,
  type ApiProjectDeletions,
} from "./api"
import { apiTarget } from "./config"
import { filterDeletedOutboxRecords } from "./deletions"
import { emitEvent } from "./events"
import { pushBranch, repositoryUrl } from "./git"
import { applyHistorySyncUpdates, type HistorySyncUpdate } from "./history"
import { branchMetadata } from "./markdown"
import { branchStateKey, normalizeProjectPath } from "./project"
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

function secondaryMetrics(record: LocalResearchExperimentLoggedRecord) {
  const rest: Record<string, number> = { ...record.metrics }
  delete rest[record.primaryMetricName]
  return rest
}

async function upsertBranchFromMetadata({
  root,
  branchName,
  gitBranchName,
  state,
  args,
}: {
  root: string
  branchName: string
  gitBranchName: string
  state: CliState
  args: Args
}): Promise<string> {
  const projectPath = state.projectPath ?? ""
  const key = branchStateKey(projectPath, branchName)
  const cached = state.branches[key]?.branchId
  if (cached) return cached

  const meta = await branchMetadata({
    root,
    projectPath,
    branchName,
    gitBranchName,
  })
  if (!meta.baseCommitSha) {
    throw new Error(
      `Branch ${branchName} is missing a base commit. Run \`onyx branch create\` again.`
    )
  }
  const result = await upsertBranch(
    {
      repositoryUrl: await repositoryUrl(root, args.options["repository-url"]),
      projectPath,
      name: branchName,
      description: meta.description ?? undefined,
      gitBranchName,
      parentGitBranchName: meta.parentGitBranchName ?? undefined,
      baseCommitSha: meta.baseCommitSha,
      metricName: meta.metricName,
      metricUnit: meta.metricUnit ?? undefined,
      metricDirection: meta.metricDirection,
    },
    args
  )
  state.projectId = result.project.id
  state.branches[key] = {
    ...state.branches[key],
    branchId: result.branch.id,
  }
  return result.branch.id
}

async function flushBranchStarted({
  root,
  record,
  state,
  args,
}: {
  root: string
  record: LocalResearchBranchStartedRecord
  state: CliState
  args: Args
}): Promise<ApiProject> {
  if (record.projectPath !== undefined) {
    state.projectPath = record.projectPath
  }
  const projectPath = state.projectPath ?? ""
  const result = await upsertBranch(
    {
      repositoryUrl: await repositoryUrl(root, args.options["repository-url"]),
      projectPath,
      name: record.name,
      description: record.description ?? undefined,
      gitBranchName: record.gitBranchName,
      parentGitBranchName: record.parentGitBranchName ?? undefined,
      baseCommitSha: record.baseCommitSha,
      metricName: record.metricName,
      metricUnit: record.metricUnit ?? undefined,
      metricDirection: record.metricDirection,
    },
    args
  )
  state.projectId = result.project.id
  const key = branchStateKey(projectPath, record.name)
  state.branches[key] = {
    ...state.branches[key],
    branchId: result.branch.id,
    projectPath,
    gitBranchName: record.gitBranchName,
    ...(record.parentGitBranchName
      ? { parentGitBranchName: record.parentGitBranchName }
      : {}),
    baseCommitSha: record.baseCommitSha,
    description: record.description ?? null,
    metricName: record.metricName,
    metricUnit: record.metricUnit ?? null,
    metricDirection: record.metricDirection,
  }
  return result.project
}

async function flushExperiment({
  root,
  record,
  state,
  args,
}: {
  root: string
  record: LocalResearchExperimentLoggedRecord
  state: CliState
  args: Args
}): Promise<HistorySyncUpdate> {
  if (record.projectPath !== undefined) {
    state.projectPath = record.projectPath
  }
  const branchId = await upsertBranchFromMetadata({
    root,
    branchName: record.branchName,
    gitBranchName: record.gitBranchName,
    state,
    args,
  })

  const reported = await reportExperiment(
    branchId,
    {
      name: record.name,
      description: record.description ?? undefined,
      runRef: record.runRef,
      commitSha: record.commitSha,
      status: record.status,
      primaryMetricName: record.primaryMetricName,
      primaryMetricValue: record.primaryMetricValue ?? undefined,
      secondaryMetrics: secondaryMetrics(record),
      artifactRefs: {},
      agentNotes: record.agentNotes,
      checks: record.checks ?? undefined,
      durationMs: record.durationMs ?? undefined,
      outputSummary: record.outputSummary ?? undefined,
      startedAt: record.startedAt ?? undefined,
      completedAt: record.completedAt ?? undefined,
    },
    args
  )
  return {
    sequenceNumber: reported.sequenceNumber,
    experimentId: reported.id,
    branchId,
  }
}

/**
 * Replays the local outbox to the Onyx API. Pushes every referenced branch so
 * reported commits are reachable, then lazily upserts the project/branches and
 * reports experiments idempotently (server dedups by runRef). A 409 means the
 * commit is not reachable through GitHub yet (push/propagation lag) and is retried on the
 * next flush; a 410 means the record was deleted server-side and is dropped
 * without retry; any other error keeps the record queued and is surfaced.
 * Records matching the project's deletions feed are dropped up front so a
 * stale queue never resurrects deleted branches or experiments.
 */
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
        `Project lookup skipped; branch sync will lazily create it if GitHub access is available (${
          error instanceof Error ? error.message : String(error)
        })`
      )
    }
  }

  // Drop records the server has deleted before replaying anything. Best
  // effort: with no deletions feed (offline, older server) everything is
  // kept and the report path's 410 still catches deleted runRefs.
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

  // Push every referenced branch up front so reported commits are reachable.
  for (const branch of new Set(kept.map((record) => record.gitBranchName))) {
    try {
      await pushBranch(root, branch)
    } catch {
      // Keep going: the report 409s and is retried if the commit is unreachable.
    }
  }

  // Pre-populate branch ids so concurrently-created branches resolve without upsert.
  if (project) {
    try {
      for (const branch of await listProjectBranches(project.id, args)) {
        const key = branchStateKey(state.projectPath ?? "", branch.name)
        state.branches[key] = { ...state.branches[key], branchId: branch.id }
      }
    } catch {
      // best-effort
    }
  }

  const remaining: LocalResearchRecord[] = []
  const historyUpdates = new Map<string, HistorySyncUpdate>()
  // Outbox order guarantees a parent's branch_started precedes its child's,
  // but a parent that fails to flush must hold its children back: a child
  // upserted first would be permanently recorded without a parent.
  const failedBranchNames = new Set<string>()
  let flushed = 0

  for (const record of kept) {
    try {
      if (record.type === "branch_started") {
        if (
          record.parentGitBranchName &&
          failedBranchNames.has(record.parentGitBranchName)
        ) {
          remaining.push(record)
          continue
        }
        project = await flushBranchStarted({ root, record, state, args })
      } else {
        const update = await flushExperiment({
          root,
          record,
          state,
          args,
        })
        historyUpdates.set(record.runRef, update)
      }
      flushed += 1
    } catch (error) {
      // 410 Gone: the runRef was deleted server-side — drop it for good
      // instead of re-queueing (replaying it would always 410 again).
      if (error instanceof ApiError && error.status === 410) {
        skippedDeleted += 1
        continue
      }
      if (record.type === "branch_started") {
        failedBranchNames.add(record.gitBranchName)
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
  // Stamp server-assigned sequence numbers onto the local history cache so
  // the TUI shows them immediately. Best-effort: hydration also covers this.
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
