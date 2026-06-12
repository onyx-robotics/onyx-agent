import type { LocalResearchRecord } from "../protocol"

import type { ApiProjectDeletions } from "./api"

/**
 * Server-side deletion matching for local records. Experiments are matched
 * by runRef tombstone (exact, never expires); branch matches use
 * record.createdAt < tombstone.deletedAt so records created after a branch
 * was deleted — i.e. for a legitimately recreated branch with the same
 * name — are never dropped.
 */
function matchesBranchTombstone(
  record: { branchName: string; createdAt: string },
  deletions: ApiProjectDeletions
) {
  return deletions.branches.some(
    (tombstone) =>
      tombstone.name === record.branchName &&
      Date.parse(record.createdAt) < Date.parse(tombstone.deletedAt)
  )
}

export function isHistoryRecordDeleted(
  record: { runRef: string; branchName: string; createdAt: string },
  deletions: ApiProjectDeletions | null
): boolean {
  if (!deletions) return false
  if (
    deletions.experiments.some(
      (tombstone) => tombstone.runRef === record.runRef
    )
  ) {
    return true
  }
  return matchesBranchTombstone(record, deletions)
}

/**
 * Drops outbox records the server has deleted, so a stale queue can never
 * resurrect them: experiment records whose runRef is tombstoned or whose
 * branch was deleted after they were created, and branch_started records
 * predating their branch's deletion.
 */
export function filterDeletedOutboxRecords(
  records: LocalResearchRecord[],
  deletions: ApiProjectDeletions | null
): { kept: LocalResearchRecord[]; dropped: number } {
  if (!deletions) {
    return { kept: records, dropped: 0 }
  }

  const deletedRunRefs = new Set(
    deletions.experiments.map((tombstone) => tombstone.runRef)
  )
  const kept: LocalResearchRecord[] = []
  let dropped = 0

  for (const record of records) {
    if (record.type === "experiment_logged") {
      if (
        deletedRunRefs.has(record.runRef) ||
        matchesBranchTombstone(record, deletions)
      ) {
        dropped += 1
        continue
      }
    } else if (
      matchesBranchTombstone(
        { branchName: record.name, createdAt: record.createdAt },
        deletions
      )
    ) {
      dropped += 1
      continue
    }

    kept.push(record)
  }

  return { kept, dropped }
}
