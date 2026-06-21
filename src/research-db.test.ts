import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import { normalizeSetupFile } from "./lib/contract"
import { runProcess } from "./lib/process"
import {
  acquireLocalResourceLease,
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
  listResearchSyncConflicts,
  logLocalExperiment,
  markResearchSyncConflict,
  pendingResearchSyncCount,
  pendingResearchSyncEvents,
  recordLocalWorkerHeartbeat,
  researchDbDoctor,
  readLocalAttempt,
  registerLocalWorker,
  renewLocalResourceLease,
  retryResearchSyncConflicts,
  writeLocalAttempt,
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
  test("records schema version and rejects newer databases", async () => {
    const root = await fixtureRepo()
    const doctor = await researchDbDoctor(root)
    expect(doctor.ok).toBe(true)
    expect(doctor.schemaVersion).toBe(1)

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

  test("stores measured attempts in SQLite and clears them after logging", async () => {
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
