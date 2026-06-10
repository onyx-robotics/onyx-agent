import type {
  LocalResearchExperimentLoggedRecord,
  LocalResearchBranchStartedRecord,
  LocalResearchRecord,
} from "../protocol"

import type { Args } from "./args"
import {
  ApiError,
  listProjectBranches,
  reportExperiment,
  resolveProject,
  upsertBranch,
  type ApiProject,
} from "./api"
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
 * next flush; any other error keeps the record queued and is surfaced.
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
    return { flushed: 0, pending: 0, offline: false }
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

  // Push every referenced branch up front so reported commits are reachable.
  for (const branch of new Set(records.map((record) => record.gitBranchName))) {
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
  let flushed = 0

  for (const record of records) {
    try {
      if (record.type === "branch_started") {
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
    console.log(`Synced ${flushed} record(s); ${remaining.length} pending.`)
  }

  return { flushed, pending: remaining.length, offline: false }
}
