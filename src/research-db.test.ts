import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, test } from "bun:test"

import { normalizeSetupFile } from "./lib/contract"
import { runProcess } from "./lib/process"
import {
  createLocalCampaign,
  createLocalSession,
  getLocalSessionState,
  listLocalExperimentHistory,
  logLocalExperiment,
  pendingResearchSyncCount,
  recordLocalWorkerHeartbeat,
  registerLocalWorker,
} from "./lib/research-db"

async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "onyx-research-db-"))
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

describe("SQLite research ledger", () => {
  test("creates local campaigns, sessions, hypotheses, workers, and bounded heartbeats", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "local-first",
      description: "offline campaign",
      projectPath: "",
      baseCommitSha: "abcdef1",
      setup: setup(),
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "offline-session",
      workerTarget: 1,
      hypotheses: [
        {
          focus: "try one thing",
          statement: "A focused local change can improve score.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
      ],
      metadata: { agentKind: "codex" },
    })
    const hypothesis = session.hypotheses[0]!
    const worker = await registerLocalWorker({
      root,
      campaignId: campaign.id,
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      workerName: "worker-1",
      agentKind: "codex",
    })

    await expect(
      registerLocalWorker({
        root,
        campaignId: campaign.id,
        sessionId: session.session.id,
        hypothesisId: hypothesis.id,
        workerName: "worker-2",
        agentKind: "codex",
      })
    ).rejects.toThrow("no open worker slots")

    const beforeHeartbeat = await pendingResearchSyncCount(root)
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "running",
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      event: "heartbeat",
    })
    expect(await pendingResearchSyncCount(root)).toBe(beforeHeartbeat)

    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "completed",
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      event: "completed",
    })
    expect(await pendingResearchSyncCount(root)).toBe(beforeHeartbeat + 1)

    const state = await getLocalSessionState(root, session.session.id)
    expect(state.workers[0]?.status).toBe("completed")
  })

  test("logs experiments into SQLite and exposes offline history", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "experiments",
      projectPath: "",
      baseCommitSha: "abcdef1",
      setup: setup(),
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })

    await logLocalExperiment({
      root,
      record: {
        schemaVersion: 1,
        type: "campaign_experiment_logged",
        createdAt: "2026-01-01T00:00:00.000Z",
        runRef: "local/experiments/1",
        campaignName: campaign.name,
        name: "first",
        description: null,
        projectPath: "",
        baseCommitSha: "abcdef1",
        resultCommitSha: "abcdef2",
        resultRef: `refs/onyx/experiments/${campaign.id}/local-experiments-1`,
        status: "succeeded",
        setupCompliance: {
          status: "passed",
          protectedPathsChanged: [],
          outOfScopePathsChanged: [],
          setupPathsChanged: [],
          notes: null,
        },
        primaryMetricName: "score",
        primaryMetricValue: 2,
        metrics: { score: 2 },
        agentNotes: {},
        checks: null,
      },
    })

    const history = await listLocalExperimentHistory(root)
    expect(history).toHaveLength(1)
    expect(history[0]?.runRef).toBe("local/experiments/1")
    expect(history[0]?.primaryMetricValue).toBe(2)
  })
})

