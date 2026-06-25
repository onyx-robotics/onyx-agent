import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import { normalizeSetupFile } from "./lib/contract"
import { runProcess } from "./lib/process"
import {
  acquireLocalResourceLease,
  applyProjectDeletions,
  cacheLocalCampaign,
  createLocalCampaign,
  createLocalSession,
  clearLocalAttempt,
  cleanupExpiredResourceLeases,
  deleteLocalCampaignWithTombstone,
  getLocalSessionState,
  listLocalResourceLeases,
  listLocalAttempts,
  listLocalCampaigns,
  listLocalExperimentHistory,
  listLocalSummaries,
  listResearchSyncConflicts,
  localBriefMarkdown,
  localCampaignByName,
  logLocalExperiment,
  markResearchSyncConflict,
  pendingResearchSyncCount,
  pendingResearchSyncEvents,
  recordLocalWorkerHeartbeat,
  researchDbPath,
  researchDbDoctor,
  readLocalAttempt,
  registerLocalWorker,
  renewLocalResourceLease,
  retryResearchSyncConflicts,
  writeLocalAttempt,
} from "./lib/research-db"
import { researchSyncEventSchema } from "./protocol"

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

function experimentRecord({
  campaignName,
  campaignId,
  runRef,
  name,
  value,
  createdAt,
  sessionId,
  hypothesisId,
}: {
  campaignName: string
  campaignId: string
  runRef: string
  name: string
  value: number
  createdAt: string
  sessionId?: string
  hypothesisId?: string
}) {
  return {
    schemaVersion: 1 as const,
    type: "campaign_experiment_logged" as const,
    createdAt,
    runRef,
    campaignName,
    name,
    description: null,
    projectPath: "",
    baseCommitSha: "abcdef1",
    resultCommitSha: `${name}-commit`,
    resultRef: `refs/onyx/experiments/${campaignId}/${runRef}`,
    status: "succeeded" as const,
    setupCompliance: {
      status: "passed" as const,
      protectedPathsChanged: [],
      outOfScopePathsChanged: [],
      setupPathsChanged: [],
      notes: null,
    },
    primaryMetricName: "score",
    primaryMetricValue: value,
    metrics: { score: value },
    agentNotes: {},
    checks: null,
    sessionId,
    hypothesisId,
  }
}

describe("SQLite research ledger", () => {
  test("records schema version and rejects newer databases", async () => {
    const root = await fixtureRepo()
    const doctor = await researchDbDoctor(root)
    expect(doctor.ok).toBe(true)
    expect(doctor.schemaVersion).toBe(4)
    const localDb = new Database(await researchDbPath(root))
    try {
      const launchTable = localDb
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_launches'"
        )
        .get() as { name: string } | null
      expect(launchTable?.name).toBe("worker_launches")
    } finally {
      localDb.close()
    }

    const dbPath = join(
      await mkdtemp(join(tmpdir(), "onyx-newer-db-")),
      "db.sqlite"
    )
    const db = new Database(dbPath, { create: true })
    db.run(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
    ).run(999, new Date().toISOString())
    db.close()

    const previous = process.env.ONYX_RESEARCH_DB
    process.env.ONYX_RESEARCH_DB = dbPath
    try {
      await expect(pendingResearchSyncCount(root)).rejects.toThrow(
        "newer than this Onyx CLI supports"
      )
    } finally {
      if (previous === undefined) delete process.env.ONYX_RESEARCH_DB
      else process.env.ONYX_RESEARCH_DB = previous
    }
  })

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

  test("serializes concurrent worker registration without SQLite lock errors", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "concurrent-workers",
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
      name: "two-slots",
      workerTarget: 2,
      hypotheses: [
        {
          focus: "try one thing",
          statement: "First focused change.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
        {
          focus: "try another thing",
          statement: "Second focused change.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
      ],
    })

    const results = await Promise.all(
      session.hypotheses.map((hypothesis, index) =>
        registerLocalWorker({
          root,
          campaignId: campaign.id,
          sessionId: session.session.id,
          hypothesisId: hypothesis.id,
          workerName: `worker-${index + 1}`,
          agentKind: "codex",
        })
      )
    )

    expect(results).toHaveLength(2)
    const state = await getLocalSessionState(root, session.session.id)
    expect(
      state.workers.filter((worker) => worker.status === "registered")
    ).toHaveLength(2)
  })

  test("capacity races fail cleanly without creating summaries", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "one-slot",
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
      name: "one-slot",
      workerTarget: 1,
      hypotheses: [
        {
          focus: "try one thing",
          statement: "First focused change.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
        {
          focus: "try another thing",
          statement: "Second focused change.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
      ],
    })

    const results = await Promise.allSettled(
      session.hypotheses.map((hypothesis, index) =>
        registerLocalWorker({
          root,
          campaignId: campaign.id,
          sessionId: session.session.id,
          hypothesisId: hypothesis.id,
          workerName: `worker-${index + 1}`,
          agentKind: "codex",
        })
      )
    )

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1)
    const state = await getLocalSessionState(root, session.session.id)
    expect(state.workers).toHaveLength(1)
    expect(await listLocalSummaries(root, campaign.id)).toHaveLength(0)
  })

  test("terminal worker heartbeats do not regress to active states", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "terminal-worker",
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
      name: "session",
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
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "completed",
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      event: "completed",
      experimentId: "11111111-1111-4111-8111-111111111111",
    })
    const pendingAfterTerminal = await pendingResearchSyncCount(root)

    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "running",
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      event: "heartbeat",
      progressMessage: "late heartbeat",
    })

    const state = await getLocalSessionState(root, session.session.id)
    expect(state.workers[0]?.status).toBe("completed")
    expect(state.workers[0]?.currentExperimentId).toBeNull()
    expect(await pendingResearchSyncCount(root)).toBe(pendingAfterTerminal)
  })

  test("caches server project ids with campaigns", async () => {
    const root = await fixtureRepo()
    const campaign = await cacheLocalCampaign({
      root,
      projectPath: "",
      setup: setup(),
      campaign: {
        id: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        name: "synced",
        description: "Synced campaign.",
        baseCommitSha: "abcdef1",
        metricName: "score",
        metricUnit: null,
        metricDirection: "maximize",
        bestMetricValue: null,
        bestCommitSha: null,
        experimentCount: 0,
        promotionRefName: null,
      },
    })

    expect(campaign?.projectId).toBe("22222222-2222-4222-8222-222222222222")
    const byName = await localCampaignByName({
      root,
      projectPath: "",
      name: "synced",
    })
    expect(byName?.projectId).toBe("22222222-2222-4222-8222-222222222222")
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

  test("keeps the earliest maximizing experiment when best metrics tie", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "maximize-tie",
      projectPath: "",
      baseCommitSha: "abcdef1",
      setup: setup(),
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/maximize-tie/baseline",
        name: "baseline",
        value: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    })
    const firstBest = await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/maximize-tie/first-best",
        name: "first-best",
        value: 2,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    })
    await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/maximize-tie/later-tie",
        name: "later-tie",
        value: 2,
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    })

    const projected = await localCampaignByName({
      root,
      projectPath: "",
      name: campaign.name,
    })
    expect(projected?.bestExperimentId).toBe(firstBest.id)
    expect(projected?.bestMetricValue).toBe(2)
    expect(projected?.bestCommitSha).toBe(firstBest.resultCommitSha)

    const db = new Database(await researchDbPath(root), { readonly: true })
    try {
      const row = db
        .query(
          "SELECT best_experiment_id AS bestExperimentId, best_metric_value AS bestMetricValue, best_commit_sha AS bestCommitSha FROM campaigns WHERE id = ?"
        )
        .get(campaign.id) as {
          bestExperimentId: string | null
          bestMetricValue: number | null
          bestCommitSha: string | null
        }
      expect(row.bestExperimentId).toBe(firstBest.id)
      expect(row.bestMetricValue).toBe(2)
      expect(row.bestCommitSha).toBe(firstBest.resultCommitSha)
    } finally {
      db.close()
    }
  })

  test("keeps the earliest minimizing experiment when best metrics tie", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "minimize-tie",
      projectPath: "",
      baseCommitSha: "abcdef1",
      setup: setup(),
      metricName: "score",
      metricUnit: null,
      metricDirection: "minimize",
    })
    await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/minimize-tie/baseline",
        name: "baseline",
        value: 5,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    })
    const firstBest = await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/minimize-tie/first-best",
        name: "first-best",
        value: 3,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    })
    await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/minimize-tie/later-tie",
        name: "later-tie",
        value: 3,
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    })

    const projected = await localCampaignByName({
      root,
      projectPath: "",
      name: campaign.name,
    })
    expect(projected?.bestExperimentId).toBe(firstBest.id)
    expect(projected?.bestMetricValue).toBe(3)
    expect(projected?.bestCommitSha).toBe(firstBest.resultCommitSha)

    const db = new Database(await researchDbPath(root), { readonly: true })
    try {
      const row = db
        .query(
          "SELECT best_experiment_id AS bestExperimentId, best_metric_value AS bestMetricValue, best_commit_sha AS bestCommitSha FROM campaigns WHERE id = ?"
        )
        .get(campaign.id) as {
          bestExperimentId: string | null
          bestMetricValue: number | null
          bestCommitSha: string | null
        }
      expect(row.bestExperimentId).toBe(firstBest.id)
      expect(row.bestMetricValue).toBe(3)
      expect(row.bestCommitSha).toBe(firstBest.resultCommitSha)
    } finally {
      db.close()
    }
  })

  test("filters tombstoned experiments from offline history and read models", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "tombstone-filter",
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
      name: "session",
      workerTarget: 1,
      hypotheses: [
        {
          focus: "controller",
          statement: "Try a scoped controller change.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
      ],
    })
    const hypothesis = session.hypotheses[0]!
    const first = await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/tombstone-filter/deleted",
        name: "deleted-best",
        value: 10,
        createdAt: "2026-01-01T00:00:00.000Z",
        sessionId: session.session.id,
        hypothesisId: hypothesis.id,
      }),
    })
    const second = await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/tombstone-filter/live",
        name: "surviving",
        value: 2,
        createdAt: "2026-01-02T00:00:00.000Z",
        sessionId: session.session.id,
        hypothesisId: hypothesis.id,
      }),
    })

    await applyProjectDeletions({
      root,
      deletions: {
        campaigns: [],
        experiments: [
          {
            experimentId: first.id,
            runRef: first.runRef,
            campaignId: campaign.id,
            campaignName: campaign.name,
            deletedAt: "2026-01-03T00:00:00.000Z",
          },
        ],
      },
    })

    const history = await listLocalExperimentHistory(root)
    expect(history.map((item) => item.runRef)).toEqual([second.runRef])

    const projectedCampaign = await localCampaignByName({
      root,
      projectPath: "",
      name: campaign.name,
    })
    expect(projectedCampaign?.experimentCount).toBe(1)
    expect(projectedCampaign?.bestExperimentId).toBe(second.id)
    expect(projectedCampaign?.bestMetricValue).toBe(2)

    const sessionState = await getLocalSessionState(root, session.session.id)
    expect(sessionState.latestExperiments.map((item) => item.runRef)).toEqual([
      second.runRef,
    ])
    expect(sessionState.bestExperiment?.id).toBe(second.id)

    const brief = await localBriefMarkdown({
      root,
      campaignId: campaign.id,
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
    })
    expect(brief).toContain("surviving")
    expect(brief).not.toContain("deleted-best")
  })

  test("updates hypothesis projections independently of campaign best", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "hypothesis-projection",
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
      name: "session",
      workerTarget: 2,
      hypotheses: [
        {
          focus: "fast controller",
          statement: "Try aggressive tuning.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
        {
          focus: "stable controller",
          statement: "Try conservative tuning.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
      ],
    })
    const [bestHypothesis, nonBestHypothesis] = session.hypotheses
    if (!bestHypothesis || !nonBestHypothesis) {
      throw new Error("expected hypotheses")
    }

    const campaignBest = await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/hypothesis-projection/best",
        name: "campaign-best",
        value: 10,
        createdAt: "2026-01-01T00:00:00.000Z",
        sessionId: session.session.id,
        hypothesisId: bestHypothesis.id,
      }),
    })
    const hypothesisProgress = await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/hypothesis-projection/non-best",
        name: "non-best-progress",
        value: 2,
        createdAt: "2026-01-02T00:00:00.000Z",
        sessionId: session.session.id,
        hypothesisId: nonBestHypothesis.id,
      }),
    })

    const state = await getLocalSessionState(root, session.session.id)
    expect(state.bestExperiment?.id).toBe(campaignBest.id)
    const projected = state.hypotheses.find(
      (hypothesis) => hypothesis.id === nonBestHypothesis.id
    )
    expect(projected?.bestExperimentId).toBe(hypothesisProgress.id)
    expect(projected?.bestMetricValue).toBe(2)
    expect(projected?.lastWorkedAt).toBe("2026-01-02T00:00:00.000Z")

    await applyProjectDeletions({
      root,
      deletions: {
        campaigns: [],
        experiments: [
          {
            experimentId: hypothesisProgress.id,
            runRef: hypothesisProgress.runRef,
            campaignId: campaign.id,
            campaignName: campaign.name,
            deletedAt: "2026-01-03T00:00:00.000Z",
          },
        ],
      },
    })

    const afterTombstone = await getLocalSessionState(root, session.session.id)
    const cleared = afterTombstone.hypotheses.find(
      (hypothesis) => hypothesis.id === nonBestHypothesis.id
    )
    expect(afterTombstone.bestExperiment?.id).toBe(campaignBest.id)
    expect(cleared?.bestExperimentId).toBeNull()
    expect(cleared?.bestMetricValue).toBeNull()
    expect(cleared?.lastWorkedAt).toBeNull()
  })

  test("filters experiments that predate a campaign tombstone", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "deleted-campaign",
      projectPath: "",
      baseCommitSha: "abcdef1",
      setup: setup(),
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/deleted-campaign/old",
        name: "old-run",
        value: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    })

    await applyProjectDeletions({
      root,
      deletions: {
        campaigns: [
          {
            campaignId: campaign.id,
            name: campaign.name,
            deletedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        experiments: [],
      },
    })

    expect(await listLocalExperimentHistory(root)).toEqual([])
    expect(
      (
        await localCampaignByName({
          root,
          projectPath: "",
          name: campaign.name,
        })
      )?.experimentCount
    ).toBe(0)
  })

  test("emitted SQLite sync events satisfy the generated protocol contract", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "contract",
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
      name: "session",
      workerTarget: 1,
      hypotheses: [
        {
          focus: "controller",
          statement: "Try a scoped controller change.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
      ],
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
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "completed",
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      event: "completed",
      progressMessage: "done",
      gitLabel: "abcdef2",
    })
    await logLocalExperiment({
      root,
      record: experimentRecord({
        campaignName: campaign.name,
        campaignId: campaign.id,
        runRef: "local/contract/1",
        name: "contract-run",
        value: 4,
        createdAt: "2026-01-01T00:00:00.000Z",
        sessionId: session.session.id,
        hypothesisId: hypothesis.id,
      }),
    })

    for (const event of await pendingResearchSyncEvents(root)) {
      expect(() =>
        researchSyncEventSchema.parse({
          eventId: event.eventId,
          sequence: event.sequence,
          type: event.type,
          entityType: event.entityType,
          entityId: event.entityId,
          payload: event.payload,
          createdAt: event.createdAt,
        })
      ).not.toThrow()
    }
  })

  test("stores measured attempts in SQLite and supports explicit cleanup", async () => {
    const root = await fixtureRepo()
    await writeLocalAttempt({
      root,
      record: {
        schemaVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        runRef: "local/attempt/1",
        campaignName: "attempts",
        projectPath: "",
        baseCommitSha: "abcdef1",
        resultCommitSha: "abcdef2",
        resultRef: "refs/onyx/experiments/campaign/local-attempt-1",
        status: "running",
        setupCompliance: {
          status: "passed",
          protectedPathsChanged: [],
          outOfScopePathsChanged: [],
          setupPathsChanged: [],
          notes: null,
        },
        primaryMetricName: "score",
        primaryMetricValue: null,
        metrics: {},
        agentNotes: {},
        checks: null,
        durationMs: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        outputSummary: null,
      },
    })

    expect(await listLocalAttempts(root)).toHaveLength(1)
    expect(
      await readLocalAttempt(root, {
        campaignName: "attempts",
        projectPath: "",
      })
    ).toMatchObject({ runRef: "local/attempt/1" })

    await clearLocalAttempt(root, { runRef: "local/attempt/1" })
    expect(await listLocalAttempts(root)).toHaveLength(0)
  })

  test("tombstones deleted local campaigns and retries sync conflicts", async () => {
    const root = await fixtureRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "delete-me",
      description: "offline campaign",
      projectPath: "",
      baseCommitSha: "abcdef1",
      setup: setup(),
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const pendingBeforeDelete = await pendingResearchSyncEvents(root)

    const deleted = await deleteLocalCampaignWithTombstone({
      root,
      projectPath: "",
      name: "delete-me",
      reason: "test",
    })
    expect(deleted.campaignId).toBe(campaign.id)
    expect(
      (await listLocalCampaigns(root)).map((item) => item.name)
    ).not.toContain("delete-me")

    const [deleteEvent] = (await pendingResearchSyncEvents(root)).filter(
      (event) =>
        !pendingBeforeDelete.some((before) => before.eventId === event.eventId)
    )
    expect(deleteEvent?.type).toBe("entity.deleted")
    await markResearchSyncConflict({
      root,
      eventId: deleteEvent!.eventId,
      message: "conflict",
    })
    expect(await listResearchSyncConflicts(root)).toHaveLength(1)
    expect(await retryResearchSyncConflicts(root)).toBe(1)
    expect(await listResearchSyncConflicts(root)).toHaveLength(0)
  })

  test("resource leases do not oversubscribe slots under contention", async () => {
    const root = await fixtureRepo()
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        acquireLocalResourceLease({
          root,
          resourceName: "hardware-rig",
          slots: 3,
          ownerId: `worker-${index}`,
          timeoutMs: 50,
          leaseMs: 5_000,
          metadata: { index },
        })
      )
    )
    const acquired = attempts.filter(
      (result): result is PromiseFulfilledResult<() => Promise<void>> =>
        result.status === "fulfilled"
    )
    expect(acquired).toHaveLength(3)

    const leases = await listLocalResourceLeases(root)
    expect(leases).toHaveLength(3)
    expect(new Set(leases.map((lease) => lease.slot)).size).toBe(3)
    expect(
      await renewLocalResourceLease({
        root,
        resourceName: "hardware-rig",
        ownerId: leases[0]!.ownerId,
        leaseMs: 10_000,
      })
    ).toBe(1)

    for (const lease of acquired) await lease.value()
    expect(await listLocalResourceLeases(root)).toHaveLength(0)

    const releaseExpired = await acquireLocalResourceLease({
      root,
      resourceName: "hardware-rig",
      slots: 1,
      ownerId: "short-lived",
      timeoutMs: 50,
      leaseMs: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await cleanupExpiredResourceLeases(root)).toBe(1)
    await releaseExpired()
  })
})
