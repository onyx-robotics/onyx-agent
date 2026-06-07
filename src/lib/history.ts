import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  localResearchHistoryRecordSchema,
  type LocalResearchExperimentLoggedRecord,
  type LocalResearchHistoryRecord,
} from "../protocol"

import {
  getProjectTree,
  resolveProject,
  type ApiTreeBranch,
  type ApiTreeExperiment,
} from "./api"
import type { Args } from "./args"
import { onyxStateDir, readOutbox, readState } from "./outbox"

export async function historyPath(root: string) {
  return join(await onyxStateDir(root), "history.jsonl")
}

export async function appendHistory(
  root: string,
  record: LocalResearchHistoryRecord
) {
  const validated = localResearchHistoryRecordSchema.parse(record)
  await writeFile(await historyPath(root), `${JSON.stringify(validated)}\n`, {
    encoding: "utf8",
    flag: "a",
  })
}

/**
 * Reads the local history cache. Corrupt or partially-written lines are
 * skipped and counted rather than thrown, mirroring the outbox.
 */
export async function readHistory(
  root: string
): Promise<{ records: LocalResearchHistoryRecord[]; corrupt: number }> {
  let text = ""
  try {
    text = await readFile(await historyPath(root), "utf8")
  } catch {
    return { records: [], corrupt: 0 }
  }

  const records: LocalResearchHistoryRecord[] = []
  let corrupt = 0

  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      corrupt += 1
      continue
    }
    const result = localResearchHistoryRecordSchema.safeParse(parsed)
    if (result.success) {
      records.push(result.data)
    } else {
      corrupt += 1
    }
  }

  return { records, corrupt }
}

/** Atomically replaces the history cache. */
export async function rewriteHistory(
  root: string,
  records: LocalResearchHistoryRecord[]
) {
  const path = await historyPath(root)
  const body = records.map((record) => JSON.stringify(record)).join("\n")
  const tmp = `${path}.tmp`
  await writeFile(tmp, body ? `${body}\n` : "", "utf8")
  await rename(tmp, path)
}

/** Provisional history record for a just-logged experiment. */
export function experimentRecordToHistory(
  record: LocalResearchExperimentLoggedRecord
): LocalResearchHistoryRecord {
  return {
    schemaVersion: 1,
    source: "local",
    branchName: record.branchName,
    gitBranchName: record.gitBranchName,
    runRef: record.runRef,
    commitSha: record.commitSha,
    status: record.status,
    name: record.name,
    description: record.description ?? null,
    primaryMetricName: record.primaryMetricName,
    primaryMetricValue: record.primaryMetricValue,
    metrics: record.metrics,
    agentNotes: record.agentNotes,
    checks: record.checks ?? null,
    durationMs: record.durationMs ?? null,
    outputSummary: record.outputSummary ?? null,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    createdAt: record.createdAt,
  }
}

/** Canonical history record from a tree-endpoint experiment DTO. */
export function apiExperimentToHistory(
  branch: ApiTreeBranch,
  experiment: ApiTreeExperiment
): LocalResearchHistoryRecord | null {
  const metrics: Record<string, number> = {}
  for (const [key, value] of Object.entries(experiment.secondaryMetrics)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      metrics[key] = value
    }
  }
  if (experiment.primaryMetricValue !== null) {
    metrics[experiment.primaryMetricName] = experiment.primaryMetricValue
  }

  const result = localResearchHistoryRecordSchema.safeParse({
    schemaVersion: 1,
    source: "api",
    branchName: branch.name,
    gitBranchName: branch.gitBranchName ?? undefined,
    runRef: experiment.runRef,
    commitSha: experiment.commitSha,
    status: experiment.status,
    name: experiment.name.slice(0, 160),
    description: experiment.description?.slice(0, 2000) ?? null,
    primaryMetricName: experiment.primaryMetricName,
    primaryMetricValue: experiment.primaryMetricValue,
    metrics,
    agentNotes: experiment.agentNotes,
    checks: experiment.checks
      ? {
          status: experiment.checks.status,
          durationMs: experiment.checks.durationMs,
          outputSummary: experiment.checks.outputSummary?.slice(0, 4000),
        }
      : null,
    durationMs: experiment.durationMs,
    outputSummary: experiment.outputSummary?.slice(0, 4000) ?? null,
    startedAt: experiment.startedAt,
    completedAt: experiment.completedAt,
    createdAt: experiment.createdAt,
    experimentId: experiment.id,
    branchId: experiment.branchId,
    sequenceNumber: experiment.sequenceNumber,
  })
  return result.success ? result.data : null
}

/**
 * Merges canonical API records with still-pending local records. Keyed by
 * runRef (globally unique: `local/{branch}/{uuid}`); canonical wins so
 * server-updated statuses (accepted/rejected) replace provisional rows.
 */
export function mergeHistory(
  canonical: LocalResearchHistoryRecord[],
  localCandidates: LocalResearchHistoryRecord[]
): LocalResearchHistoryRecord[] {
  const byRunRef = new Map<string, LocalResearchHistoryRecord>()
  for (const record of localCandidates) byRunRef.set(record.runRef, record)
  for (const record of canonical) byRunRef.set(record.runRef, record)

  return [...byRunRef.values()].sort((a, b) => {
    if (a.branchName !== b.branchName) {
      return a.branchName < b.branchName ? -1 : 1
    }
    // Server-sequenced records first in order; pending local records after.
    if (a.sequenceNumber !== undefined && b.sequenceNumber !== undefined) {
      return a.sequenceNumber - b.sequenceNumber
    }
    if (a.sequenceNumber !== undefined) return -1
    if (b.sequenceNumber !== undefined) return 1
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  })
}

export type HistorySyncUpdate = {
  sequenceNumber: number
  experimentId: string
  branchId: string
}

/**
 * Stamps server-assigned fields onto matching history records right after a
 * flush, so `onyx listen` and `exp list` show sequence numbers immediately
 * instead of waiting for the next full hydrate. Matched records become
 * canonical (`source: "api"`).
 */
export async function applyHistorySyncUpdates(
  root: string,
  updates: Map<string, HistorySyncUpdate>
) {
  if (updates.size === 0) return
  const { records } = await readHistory(root)
  let changed = false
  const next = records.map((record) => {
    const update = updates.get(record.runRef)
    if (!update) return record
    changed = true
    return {
      ...record,
      source: "api" as const,
      sequenceNumber: update.sequenceNumber,
      experimentId: update.experimentId,
      branchId: update.branchId,
    }
  })
  if (changed) await rewriteHistory(root, next)
}

export type HydrateResult = {
  experiments: number
  branches: number
  pendingLocal: number
}

/**
 * Rewrites `.git/onyx/history.jsonl` to the canonical API state, keeping
 * local records the server doesn't know yet (offline-logged, unflushed).
 * Throws on network/auth failure; callers treat hydration as best-effort.
 */
export async function hydrateHistoryFromApi(
  root: string,
  args: Args
): Promise<HydrateResult> {
  const state = await readState(root)
  const projectId = state.projectId ?? (await resolveProject(root, args)).id
  const tree = await getProjectTree(projectId, args)

  const canonical: LocalResearchHistoryRecord[] = []
  for (const branch of tree.branches) {
    for (const experiment of branch.experiments) {
      const record = apiExperimentToHistory(branch, experiment)
      if (record) canonical.push(record)
    }
  }
  const canonicalRunRefs = new Set(canonical.map((record) => record.runRef))

  // Local records the server doesn't have yet: provisional history rows plus
  // anything still queued in the outbox (covers a failed earlier append).
  const { records: existing } = await readHistory(root)
  const localCandidates = existing.filter(
    (record) =>
      record.source === "local" && !canonicalRunRefs.has(record.runRef)
  )
  const seen = new Set(localCandidates.map((record) => record.runRef))
  const { records: outbox } = await readOutbox(root)
  for (const record of outbox) {
    if (record.type !== "experiment_logged") continue
    if (canonicalRunRefs.has(record.runRef) || seen.has(record.runRef)) continue
    localCandidates.push(experimentRecordToHistory(record))
    seen.add(record.runRef)
  }

  const merged = mergeHistory(canonical, localCandidates)
  await rewriteHistory(root, merged)

  return {
    experiments: merged.length,
    branches: new Set(merged.map((record) => record.branchName)).size,
    pendingLocal: localCandidates.length,
  }
}
