import { describe, expect, test } from "bun:test"

import type { LocalResearchHistoryRecord } from "./protocol"
import {
  clientRunRef,
  localResearchRecordSchema,
  mergeHistory,
  parseMetricLines,
  renderExperimentTable,
  USAGE,
} from "./onyx"

describe("campaign CLI surface", () => {
  test("usage exposes campaigns and not legacy branch commands", () => {
    expect(USAGE).toContain("onyx campaign setup")
    expect(USAGE).toContain("onyx research start --campaign")
    expect(USAGE).not.toContain("onyx campaign create")
    expect(USAGE).not.toContain("onyx branch create")
  })

  test("run refs are campaign scoped", () => {
    expect(clientRunRef("fast-eval")).toMatch(/^local\/fast-eval\//)
  })
})

describe("local research protocol", () => {
  test("accepts campaign outbox records", () => {
    const parsed = localResearchRecordSchema.parse({
      schemaVersion: 1,
      type: "campaign_experiment_logged",
      createdAt: "2026-06-17T12:00:00.000Z",
      runRef: "local/fast-eval/abc",
      campaignName: "fast-eval",
      name: "experiment-abcdef1",
      baseCommitSha: "abcdef1",
      resultCommitSha: "1234567",
      resultRef:
        "refs/onyx/experiments/11111111-1111-4111-8111-111111111111/local/fast-eval/abc",
      status: "succeeded",
      setupId: "22222222-2222-4222-8222-222222222222",
      primaryMetricName: "score",
      primaryMetricValue: 0.9,
      metrics: { score: 0.9 },
      agentNotes: {},
    })
    expect(parsed.type).toBe("campaign_experiment_logged")
  })
})

describe("history helpers", () => {
  const local: LocalResearchHistoryRecord = {
    schemaVersion: 1,
    source: "local",
    campaignName: "fast-eval",
    runRef: "local/fast-eval/1",
    baseCommitSha: "abcdef1",
    resultCommitSha: "1234567",
    resultRef: "refs/onyx/experiments/campaign/local/fast-eval/1",
    status: "succeeded",
    name: "local",
    primaryMetricName: "score",
    primaryMetricValue: 0.8,
    metrics: { score: 0.8 },
    agentNotes: {},
    createdAt: "2026-06-17T12:00:00.000Z",
  }
  const api: LocalResearchHistoryRecord = {
    ...local,
    source: "api",
    experimentId: "11111111-1111-4111-8111-111111111111",
    campaignId: "22222222-2222-4222-8222-222222222222",
    primaryMetricValue: 0.9,
  }

  test("canonical API records replace provisional local rows by runRef", () => {
    expect(mergeHistory([api], [local])).toEqual([api])
  })
})

describe("rendering", () => {
  test("experiment table labels campaigns", () => {
    const lines = renderExperimentTable(
      [
        {
          source: "api",
          campaignName: "fast-eval",
          resultCommitSha: "1234567",
          status: "succeeded",
          name: "faster loop",
          primaryMetricName: "score",
          primaryMetricValue: 0.9,
          createdAt: "2026-06-17T12:00:00.000Z",
        },
      ],
      { columns: 100, color: false, nowMs: Date.now(), showCampaign: true }
    )
    expect(lines.join("\n")).toContain("CAMPAIGN")
    expect(lines.join("\n")).toContain("fast-eval")
  })
})

describe("metrics", () => {
  test("parses metric lines", () => {
    expect(parseMetricLines("METRIC score=1.25\n", "score")).toEqual({
      score: 1.25,
    })
  })
})
