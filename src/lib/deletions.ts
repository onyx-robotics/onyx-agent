import type { LocalResearchRecord } from "../protocol"

import type { ApiProjectDeletions } from "./api"

function matchesCampaignTombstone(
  record: { campaignName: string; createdAt: string },
  deletions: ApiProjectDeletions
) {
  return deletions.campaigns.some(
    (tombstone) =>
      tombstone.name === record.campaignName &&
      Date.parse(record.createdAt) < Date.parse(tombstone.deletedAt)
  )
}

export function isHistoryRecordDeleted(
  record: { runRef: string; campaignName: string; createdAt: string },
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
  return matchesCampaignTombstone(record, deletions)
}

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
    if (record.type === "campaign_experiment_logged") {
      if (
        deletedRunRefs.has(record.runRef) ||
        matchesCampaignTombstone(record, deletions)
      ) {
        dropped += 1
        continue
      }
    } else if (
      record.type === "campaign_started" &&
      matchesCampaignTombstone(
        { campaignName: record.name, createdAt: record.createdAt },
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
