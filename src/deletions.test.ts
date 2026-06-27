import { describe, expect, test } from "bun:test"

import type { ApiProjectDeletions } from "./lib/api"
import {
  filterDeletedOutboxRecords,
  isHistoryRecordDeleted,
} from "./lib/deletions"
import type { LocalResearchRecord } from "./protocol"

const CAMPAIGN_DELETED_AT = "2026-06-10T12:00:00.000Z"
const BEFORE_DELETE = "2026-06-09T00:00:00.000Z"
const AFTER_DELETE = "2026-06-11T00:00:00.000Z"
const setup = {
  schemaVersion: 2 as const,
  goal: "Improve score",
  projectPath: "",
  scope: {
    editable: [],
    protected: ["onyx/setup.json", "onyx/validation.json", "onyx/tools/"],
  },
  metric: {
    name: "score",
    unit: null,
    direction: "maximize" as const,
  },
  resources: {},
  tools: {
    "evaluation.run": {
      command: "printf 'METRIC score=1\\n'",
      args: [],
      shell: false,
      cwd: "project",
      env: {},
      resources: [],
      timeoutSeconds: 600,
      leaseTimeoutSeconds: 120,
      outputLimitBytes: 4000,
    },
  },
  workflow: [
    {
      id: "edit",
      agent: "Make one scoped code change.",
      optional: false as const,
    },
    {
      id: "evaluate",
      run: "evaluation.run",
      metric: true as const,
      optional: false as const,
    },
  ],
}

const deletions: ApiProjectDeletions = {
  campaigns: [
    {
      campaignId: "11111111-1111-4111-8111-111111111111",
      name: "fast-eval",
      deletedAt: CAMPAIGN_DELETED_AT,
    },
  ],
  experiments: [
    {
      experimentId: "22222222-2222-4222-8222-222222222222",
      runRef: "local/other-campaign/deleted-run",
      campaignId: "33333333-3333-4333-8333-333333333333",
      campaignName: "other-campaign",
      deletedAt: CAMPAIGN_DELETED_AT,
    },
  ],
}

function campaignStarted(
  name: string,
  createdAt: string
): LocalResearchRecord {
  return {
    schemaVersion: 1,
    type: "campaign_started",
    createdAt,
    name,
    baseCommitSha: "abcdef1",
    setup,
    metricName: "score",
    metricDirection: "maximize",
  }
}

function experimentLogged(
  campaignName: string,
  runRef: string,
  createdAt: string
): LocalResearchRecord {
  return {
    schemaVersion: 1,
    type: "campaign_experiment_logged",
    createdAt,
    runRef,
    campaignName,
    name: "exp",
    baseCommitSha: "abcdef1",
    resultCommitSha: "1234567",
    resultRef: `refs/onyx/experiments/${campaignName}/${runRef}`,
    status: "succeeded",
    setupCompliance: {
      status: "passed",
      protectedPathsChanged: [],
      outOfScopePathsChanged: [],
      setupPathsChanged: [],
      notes: null,
    },
    primaryMetricName: "score",
    primaryMetricValue: 0.5,
    metrics: {},
    agentNotes: {},
  }
}

describe("filterDeletedOutboxRecords", () => {
  test("keeps everything when no deletions feed is available", () => {
    const records = [campaignStarted("fast-eval", BEFORE_DELETE)]
    const result = filterDeletedOutboxRecords(records, null)
    expect(result.kept).toEqual(records)
    expect(result.dropped).toBe(0)
  })

  test("drops experiment records with tombstoned runRefs", () => {
    const records = [
      experimentLogged(
        "other-campaign",
        "local/other-campaign/deleted-run",
        AFTER_DELETE
      ),
      experimentLogged(
        "other-campaign",
        "local/other-campaign/live-run",
        AFTER_DELETE
      ),
    ]
    const result = filterDeletedOutboxRecords(records, deletions)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toBe(1)
  })

  test("drops campaign and experiment records created before a campaign tombstone", () => {
    const records = [
      campaignStarted("fast-eval", BEFORE_DELETE),
      experimentLogged("fast-eval", "local/fast-eval/old-run", BEFORE_DELETE),
    ]
    const result = filterDeletedOutboxRecords(records, deletions)
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toBe(2)
  })

  test("keeps records for a recreated campaign with the same name", () => {
    const records = [
      campaignStarted("fast-eval", AFTER_DELETE),
      experimentLogged("fast-eval", "local/fast-eval/new-run", AFTER_DELETE),
    ]
    const result = filterDeletedOutboxRecords(records, deletions)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toBe(0)
  })
})

describe("isHistoryRecordDeleted", () => {
  test("matches tombstoned runRefs regardless of campaign", () => {
    expect(
      isHistoryRecordDeleted(
        {
          runRef: "local/other-campaign/deleted-run",
          campaignName: "other-campaign",
          createdAt: AFTER_DELETE,
        },
        deletions
      )
    ).toBe(true)
  })

  test("matches records created before their campaign deletion", () => {
    expect(
      isHistoryRecordDeleted(
        {
          runRef: "local/fast-eval/unflushed",
          campaignName: "fast-eval",
          createdAt: BEFORE_DELETE,
        },
        deletions
      )
    ).toBe(true)
    expect(
      isHistoryRecordDeleted(
        {
          runRef: "local/fast-eval/post-recreate",
          campaignName: "fast-eval",
          createdAt: AFTER_DELETE,
        },
        deletions
      )
    ).toBe(false)
  })
})
