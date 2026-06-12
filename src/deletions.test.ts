import { describe, expect, test } from "bun:test"

import type { ApiProjectDeletions } from "./lib/api"
import {
  filterDeletedOutboxRecords,
  isHistoryRecordDeleted,
} from "./lib/deletions"
import type { LocalResearchRecord } from "./protocol"

const BRANCH_DELETED_AT = "2026-06-10T12:00:00.000Z"
const BEFORE_DELETE = "2026-06-09T00:00:00.000Z"
const AFTER_DELETE = "2026-06-11T00:00:00.000Z"

const deletions: ApiProjectDeletions = {
  branches: [
    {
      branchId: "11111111-1111-4111-8111-111111111111",
      name: "fast-eval",
      gitBranchName: "onyx/fast-eval",
      deletedAt: BRANCH_DELETED_AT,
    },
  ],
  experiments: [
    {
      experimentId: "22222222-2222-4222-8222-222222222222",
      runRef: "local/other-branch/deleted-run",
      branchId: "33333333-3333-4333-8333-333333333333",
      branchName: "other-branch",
      deletedAt: BRANCH_DELETED_AT,
    },
  ],
}

function branchStarted(
  name: string,
  createdAt: string
): LocalResearchRecord {
  return {
    schemaVersion: 1,
    type: "branch_started",
    createdAt,
    name,
    gitBranchName: `onyx/${name}`,
    baseCommitSha: "abcdef1",
    metricName: "score",
    metricDirection: "maximize",
  }
}

function experimentLogged(
  branchName: string,
  runRef: string,
  createdAt: string
): LocalResearchRecord {
  return {
    schemaVersion: 1,
    type: "experiment_logged",
    createdAt,
    runRef,
    branchName,
    name: "exp",
    gitBranchName: `onyx/${branchName}`,
    commitSha: "abcdef1",
    status: "succeeded",
    primaryMetricName: "score",
    primaryMetricValue: 0.5,
    metrics: {},
    agentNotes: {},
  }
}

describe("filterDeletedOutboxRecords", () => {
  test("keeps everything when no deletions feed is available", () => {
    const records = [branchStarted("fast-eval", BEFORE_DELETE)]
    const result = filterDeletedOutboxRecords(records, null)
    expect(result.kept).toEqual(records)
    expect(result.dropped).toBe(0)
  })

  test("drops experiment records with tombstoned runRefs", () => {
    const records = [
      experimentLogged("other-branch", "local/other-branch/deleted-run", AFTER_DELETE),
      experimentLogged("other-branch", "local/other-branch/live-run", AFTER_DELETE),
    ]
    const result = filterDeletedOutboxRecords(records, deletions)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toBe(1)
  })

  test("drops branch_started and experiments created before the branch tombstone", () => {
    const records = [
      branchStarted("fast-eval", BEFORE_DELETE),
      experimentLogged("fast-eval", "local/fast-eval/old-run", BEFORE_DELETE),
    ]
    const result = filterDeletedOutboxRecords(records, deletions)
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toBe(2)
  })

  test("keeps records for a recreated branch with the same name", () => {
    const records = [
      branchStarted("fast-eval", AFTER_DELETE),
      experimentLogged("fast-eval", "local/fast-eval/new-run", AFTER_DELETE),
    ]
    const result = filterDeletedOutboxRecords(records, deletions)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toBe(0)
  })
})

describe("isHistoryRecordDeleted", () => {
  test("matches tombstoned runRefs regardless of branch", () => {
    expect(
      isHistoryRecordDeleted(
        {
          runRef: "local/other-branch/deleted-run",
          branchName: "other-branch",
          createdAt: AFTER_DELETE,
        },
        deletions
      )
    ).toBe(true)
  })

  test("matches records created before their branch's deletion", () => {
    expect(
      isHistoryRecordDeleted(
        {
          runRef: "local/fast-eval/unflushed",
          branchName: "fast-eval",
          createdAt: BEFORE_DELETE,
        },
        deletions
      )
    ).toBe(true)
    expect(
      isHistoryRecordDeleted(
        {
          runRef: "local/fast-eval/post-recreate",
          branchName: "fast-eval",
          createdAt: AFTER_DELETE,
        },
        deletions
      )
    ).toBe(false)
  })

  test("returns false without a deletions feed", () => {
    expect(
      isHistoryRecordDeleted(
        {
          runRef: "local/fast-eval/unflushed",
          branchName: "fast-eval",
          createdAt: BEFORE_DELETE,
        },
        null
      )
    ).toBe(false)
  })
})
