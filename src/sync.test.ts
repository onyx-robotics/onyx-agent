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
    schemaVersion: 2,
    goal: "Improve score.",
    projectPath: "",
    scope: { editable: ["src"], protected: [] },
    metric: { name: "score", unit: null, direction: "maximize" },
    resources: {},
    tools: {
      "evaluation.run": {
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
    workflow: [
      { id: "edit", agent: "Make one scoped code change." },
      { id: "evaluate", run: "evaluation.run", metric: true },
    ],
  })
}

describe("SQLite sync", () => {
  test("marks experiment refs verified after a successful push", async () => {
    const root = await fixtureRepo()
    const remote = await mkdtemp(join(tmpdir(), "onyx-sync-remote-"))
    await runProcess("git", ["init", "--bare"], { cwd: remote })
    await runProcess("git", ["remote", "add", "origin", remote], {
      cwd: root,
    })
    const head = (
      await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim()
    const campaign = await createLocalCampaign({
      root,
      name: "push-verify",
      projectPath: "",
      baseCommitSha: head,
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
        runRef: "local/push-verify/run",
        campaignName: campaign.name,
        name: "pushed",
        description: null,
        projectPath: "",
        baseCommitSha: head,
        resultCommitSha: head,
        resultRef: `refs/onyx/experiments/${campaign.id}/push-verify`,
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

    const originalFetch = globalThis.fetch
    const previousApiUrl = process.env.ONYX_API_URL
    const previousApiKey = process.env.ONYX_API_KEY
    process.env.ONYX_API_URL = "https://api.onyx.test"
    process.env.ONYX_API_KEY = "test-key"
    let syncBody: {
      pushedExperimentRefs?: Array<{
        campaignId: string
        runRef: string
        resultRef: string
        resultCommitSha: string
      }>
    } | null = null
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        events: Array<{
          eventId: string
          sequence: number
          entityType: string
          entityId: string
        }>
        pushedExperimentRefs?: Array<{
          campaignId: string
          runRef: string
          resultRef: string
          resultCommitSha: string
        }>
      }
      syncBody = body
      return Response.json({
        data: {
          accepted: body.events.length,
          duplicate: 0,
          conflicts: 0,
          invalid: 0,
          acknowledgements: body.events.map((event) => ({
            eventId: event.eventId,
            sequence: event.sequence,
            status: "acked",
            code: "accepted",
            entityType: event.entityType,
            entityId: event.entityId,
            message: null,
            details: {},
          })),
          tombstones: [],
          projectionDeltas: {
            campaigns: [],
            sessions: [],
            hypotheses: [],
            workers: [],
            experiments: [],
            summaries: [],
            knowledge: [],
          },
        },
      })
    }) as typeof fetch

    try {
      const result = await flushOutbox(root, parseArgs(["sync"]))
      expect(result.offline).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
      else process.env.ONYX_API_URL = previousApiUrl
      if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
      else process.env.ONYX_API_KEY = previousApiKey
    }

    const history = await listLocalExperimentHistory(root)
    const pushed = history.find((record) => record.runRef === experiment.runRef)
    expect(pushed?.gitStatus).toBe("verified")
    expect(
      (
        syncBody as {
          pushedExperimentRefs?: Array<{
            campaignId: string
            runRef: string
            resultRef: string
            resultCommitSha: string
          }>
        } | null
      )?.pushedExperimentRefs
    ).toEqual([
      {
        campaignId: campaign.id,
        runRef: experiment.runRef,
        resultRef: experiment.resultRef,
        resultCommitSha: experiment.resultCommitSha,
      },
    ])
  })

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
      state.projectCache = {
        id: projectId,
        name: "zero-pending",
        repositoryUrl: "",
        repositoryFullName: null,
        defaultBranch: "main",
        projectPath: "",
        resolvedAt: "2026-01-01T00:00:00.000Z",
      }
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
      expect(paths).toEqual([
        `/api/v1/research/projects/${projectId}/deletions`,
      ])
      const second = await flushOutbox(root, parseArgs(["sync"]))
      expect(second).toMatchObject({ flushed: 0, pending: 0, offline: false })
      expect(paths).toEqual([
        `/api/v1/research/projects/${projectId}/deletions`,
      ])
    } finally {
      globalThis.fetch = originalFetch
      if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
      else process.env.ONYX_API_URL = previousApiUrl
      if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
      else process.env.ONYX_API_KEY = previousApiKey
    }

    expect(await listLocalExperimentHistory(root)).toEqual([])
  })

  test("flushes 250+ pending events in bounded sync batches", async () => {
    const root = await fixtureRepo()
    const remote = await mkdtemp(join(tmpdir(), "onyx-sync-remote-"))
    await runProcess("git", ["init", "--bare"], { cwd: remote })
    await runProcess("git", ["remote", "add", "origin", remote], {
      cwd: root,
    })
    const head = (
      await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim()
    for (let index = 0; index < 251; index += 1) {
      await createLocalCampaign({
        root,
        name: `many-pending-${index}`,
        projectPath: "",
        baseCommitSha: head,
        setup: setup(),
        metricName: "score",
        metricUnit: null,
        metricDirection: "maximize",
      })
    }

    expect(await pendingResearchSyncCount(root)).toBe(251)
    const originalFetch = globalThis.fetch
    const previousApiUrl = process.env.ONYX_API_URL
    const previousApiKey = process.env.ONYX_API_KEY
    process.env.ONYX_API_URL = "https://api.onyx.test"
    process.env.ONYX_API_KEY = "test-key"
    const batchSizes: number[] = []
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        events: Array<{
          eventId: string
          sequence: number
          entityType: string
          entityId: string
        }>
      }
      batchSizes.push(body.events.length)
      return Response.json({
        data: {
          accepted: body.events.length,
          duplicate: 0,
          conflicts: 0,
          invalid: 0,
          acknowledgements: body.events.map((event) => ({
            eventId: event.eventId,
            sequence: event.sequence,
            status: "acked",
            code: "accepted",
            entityType: event.entityType,
            entityId: event.entityId,
            message: null,
            details: {},
          })),
          tombstones: [],
          projectionDeltas: {
            campaigns: [],
            sessions: [],
            hypotheses: [],
            workers: [],
            experiments: [],
            summaries: [],
            knowledge: [],
          },
        },
      })
    }) as typeof fetch

    try {
      const result = await flushOutbox(
        root,
        parseArgs(["sync", "--sync-batch-size", "50"])
      )
      expect(result.offline).toBe(false)
      expect(result.batches).toBe(6)
      expect(result.pending).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
      else process.env.ONYX_API_URL = previousApiUrl
      if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
      else process.env.ONYX_API_KEY = previousApiKey
    }

    expect(batchSizes).toEqual([50, 50, 50, 50, 50, 1])
    expect(await pendingResearchSyncCount(root)).toBe(0)
  }, 20_000)
})
