import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  localResearchHistoryRecordSchema,
  type LocalResearchCampaignExperimentLoggedRecord,
  type LocalResearchHistoryRecord,
} from "../protocol"

import {
  listCampaignExperiments,
  listProjectCampaigns,
  resolveProject,
  type ApiCampaign,
  type ApiCampaignExperiment,
} from "./api"
import type { Args } from "./args"
import { isHistoryRecordDeleted } from "./deletions"
import { onyxStateDir, readState } from "./runtime-state"

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

export function experimentRecordToHistory(
  record: LocalResearchCampaignExperimentLoggedRecord
): LocalResearchHistoryRecord {
  return {
    schemaVersion: 1,
    source: "local",
    campaignName: record.campaignName,
    runRef: record.runRef,
    baseCommitSha: record.baseCommitSha,
    resultCommitSha: record.resultCommitSha,
    resultRef: record.resultRef,
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
    campaignId: record.remote?.campaignId,
    experimentId: record.remote?.experimentId,
    sessionId: record.sessionId ?? record.remote?.sessionId,
    workerId: record.workerId ?? record.remote?.workerId,
    hypothesisId: record.hypothesisId ?? record.remote?.hypothesisId,
  }
}

export function apiExperimentToHistory(
  campaign: Pick<ApiCampaign, "id" | "name">,
  experiment: ApiCampaignExperiment
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
    campaignName: campaign.name,
    runRef: experiment.runRef,
    baseCommitSha: experiment.baseCommitSha,
    resultCommitSha: experiment.resultCommitSha,
    resultRef: experiment.resultRef,
    gitStatus: experiment.gitStatus,
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
    campaignId: campaign.id,
    sessionId: experiment.sessionId ?? undefined,
    workerId: experiment.workerId ?? undefined,
    hypothesisId: experiment.hypothesisId ?? undefined,
  })
  return result.success ? result.data : null
}

export function mergeHistory(
  canonical: LocalResearchHistoryRecord[],
  localCandidates: LocalResearchHistoryRecord[]
): LocalResearchHistoryRecord[] {
  const byRunRef = new Map<string, LocalResearchHistoryRecord>()
  for (const record of localCandidates) byRunRef.set(record.runRef, record)
  for (const record of canonical) byRunRef.set(record.runRef, record)

  return [...byRunRef.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  )
}

export type HistorySyncUpdate = {
  experimentId: string
  campaignId: string
}

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
      experimentId: update.experimentId,
      campaignId: update.campaignId,
    }
  })
  if (changed) await rewriteHistory(root, next)
}

export type HydrateResult = {
  experiments: number
  campaigns: number
  pendingLocal: number
}

export async function hydrateHistoryFromApi(
  root: string,
  args: Args
): Promise<HydrateResult> {
  const state = await readState(root)
  const projectId = state.projectId ?? (await resolveProject(root, args)).id
  const campaigns = await listProjectCampaigns(projectId, args)
  const deletions = null

  const canonical: LocalResearchHistoryRecord[] = []
  for (const campaign of campaigns) {
    let cursor: string | null = null
    do {
      const page = await listCampaignExperiments(campaign.id, args, {
        limit: 100,
        cursor: cursor ?? undefined,
      })
      for (const experiment of page.items) {
        const record = apiExperimentToHistory(campaign, experiment)
        if (record) canonical.push(record)
      }
      cursor = page.page.nextCursor
    } while (cursor)
  }
  const canonicalRunRefs = new Set(canonical.map((record) => record.runRef))

  const { records: existing } = await readHistory(root)
  const localCandidates = existing.filter(
    (record) =>
      record.source === "local" &&
      !canonicalRunRefs.has(record.runRef) &&
      !isHistoryRecordDeleted(record, deletions)
  )
  const merged = mergeHistory(canonical, localCandidates)
  await rewriteHistory(root, merged)

  return {
    experiments: merged.length,
    campaigns: new Set(merged.map((record) => record.campaignName)).size,
    pendingLocal: localCandidates.length,
  }
}
