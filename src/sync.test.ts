import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, test } from "bun:test"

import { normalizeSetupFile } from "./lib/contract"
import { runProcess } from "./lib/process"
import {
  createLocalCampaign,
  listLocalExperimentHistory,
  logLocalExperiment,
  markResearchSyncAcked,
  pendingResearchSyncCount,
  pendingResearchSyncEvents,
} from "./lib/research-db"
import { flushOutbox } from "./lib/sync"
import { parseArgs } from "./lib/args"
import { updateState } from "./lib/outbox"

async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "onyx-sync-"))
  await runProcess("git", ["init"], { cwd: root })
  await runProcess("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  })
  await runProcess("git", ["config", "user.name", "Test"], { cwd: root })
  await writeFile(join(root, "README.md"), "test\n", "utf8")
  await runProcess("git", ["add", "README.md"], { cwd: root })
  await runProcess("git", ["commit", "-m", "init"], { cwd: root })
  return root
}

function setup() {
  return normalizeSetupFile({
    schemaVersion: 1,
    goal: "Improve score.",
    metric: { name: "score", unit: null, direction: "maximize" },
    projectPath: "",
    editableScope: ["src"],
    protectedPaths: [],
    commands: {
      evaluate: {
        command: "printf 'METRIC score=1\\n'",
        args: [],
        shell: true,
        cwd: "project",
        env: {},
        resources: [],
        timeoutSeconds: 5,
        leaseTimeoutSeconds: 5,
        outputLimitBytes: 4000,
      },
    },
    resources: {},
    constraints: [],
    modules: {},
    riskModel: { risks: [], antiGamingChecks: [] },
    measurement: { trials: 1, aggregation: "single", notes: null },
  })
}

describe("SQLite sync", () => {
  test("fetches remote tombstones even when no local events are pending", async () => {
    const root = await fixtureRepo()
    const projectId = "11111111-1111-4111-8111-111111111111"
    const campaign = await createLocalCampaign({
      root,
      name: "zero-pending",
      projectPath: "",
      baseCommitSha: "abcdef1",
      setup: setup(),
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const experiment = await logLocalExperiment({
      root,
      record: {
        schemaVersion: 1,
        type: "campaign_experiment_logged",
        createdAt: "2026-01-01T00:00:00.000Z",
        runRef: "local/zero-pending/deleted",
        campaignName: campaign.name,
        name: "deleted",
        description: null,
        projectPath: "",
        baseCommitSha: "abcdef1",
        resultCommitSha: "abcdef2",
        resultRef: `refs/onyx/experiments/${campaign.id}/zero-pending`,
        status: "succeeded",
        setupCompliance: {
          status: "passed",
          protectedPathsChanged: [],
          outOfScopePathsChanged: [],
          setupPathsChanged: [],
          notes: null,
        },
        primaryMetricName: "score",
        primaryMetricValue: 1,
        metrics: { score: 1 },
        agentNotes: {},
        checks: null,
      },
    })

    await updateState(root, (state) => {
      state.projectId = projectId
      state.projectPath = ""
    })
    for (const event of await pendingResearchSyncEvents(root)) {
      await markResearchSyncAcked({
        root,
        eventId: event.eventId,
        serverStatus: "acked",
        serverEntityId: event.entityId,
      })
    }
    expect(await pendingResearchSyncCount(root)).toBe(0)
    expect(await listLocalExperimentHistory(root)).toHaveLength(1)

    const originalFetch = globalThis.fetch
    const previousApiUrl = process.env.ONYX_API_URL
    const previousApiKey = process.env.ONYX_API_KEY
    process.env.ONYX_API_URL = "https://api.onyx.test"
    process.env.ONYX_API_KEY = "test-key"
    const paths: string[] = []
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input))
      paths.push(url.pathname)
      return Response.json({
        data: {
          campaigns: [],
          experiments: [
            {
              experimentId: experiment.id,
              runRef: experiment.runRef,
              campaignId: campaign.id,
              campaignName: campaign.name,
              deletedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        },
      })
    }) as typeof fetch

    try {
      const result = await flushOutbox(root, parseArgs(["sync"]))
      expect(result).toMatchObject({ flushed: 0, pending: 0, offline: false })
      expect(paths).toEqual([`/api/v1/research/projects/${projectId}/deletions`])
    } finally {
      globalThis.fetch = originalFetch
      if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
      else process.env.ONYX_API_URL = previousApiUrl
      if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
      else process.env.ONYX_API_KEY = previousApiKey
    }

    expect(await listLocalExperimentHistory(root)).toEqual([])
  })
})
