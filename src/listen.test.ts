import { mkdtemp, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { commandListen } from "./commands/listen"
import { repoRoot } from "./lib/git"
import { writeState } from "./lib/runtime-state"
import { campaignStateKey } from "./lib/project"
import { runProcess } from "./lib/process"
import { writeWorkerLatestState } from "./lib/worker-activity"
import {
  workerLaunchPaths,
  writeWorkerLaunchManifest,
} from "./lib/worker-launcher"

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111"

const savedEnv: Record<string, string | undefined> = {}

async function captureSnapshot(root: string) {
  const previousCwd = process.cwd()
  const output: string[] = []
  const originalWrite = process.stdout.write
  const stdoutIsTty = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: false,
  })
  process.stdout.write = ((chunk: unknown) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    process.chdir(root)
    await commandListen()
  } finally {
    process.chdir(previousCwd)
    process.stdout.write = originalWrite
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: stdoutIsTty,
    })
  }
  return output.join("")
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : null
      server.close((error) => {
        if (error) reject(error)
        else if (port) resolve(port)
        else reject(new Error("Could not allocate a free port."))
      })
    })
  })
}

describe("onyx listen", () => {
  beforeEach(() => {
    savedEnv.ONYX_API_URL = process.env.ONYX_API_URL
    savedEnv.ONYX_API_KEY = process.env.ONYX_API_KEY
    // Hermetic by default: an unreachable API keeps snapshots offline-only.
    process.env.ONYX_API_URL = "http://127.0.0.1:1"
    process.env.ONYX_API_KEY = "test-key"
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("renders worker latest-state telemetry in a snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-listen-"))
    await runProcess("git", ["init"], { cwd: root })
    await repoRoot(root)
    const sessionId = "session_123"
    const campaignName = "smoke"
    const now = new Date().toISOString()
    const paths = await workerLaunchPaths({
      root,
      sessionId,
      hypothesisId: "hyp_123",
      hypothesisName: "Cache tune",
      workerId: "worker_123",
    })
    await writeWorkerLaunchManifest({
      schemaVersion: 1,
      agentKind: "codex",
      workerModel: null,
      command: "codex",
      args: [],
      onyxWorkerPath: null,
      workerContextPath: null,
      addedWritableRoots: [],
      cwd: root,
      promptPath: join(paths.dir, "prompt.md"),
      logPath: paths.logPath,
      activityLogPath: paths.activityLogPath,
      activityJsonlPath: paths.activityJsonlPath,
      latestStatePath: paths.latestStatePath,
      manifestPath: paths.manifestPath,
      sessionId,
      hypothesisId: "hyp_123",
      hypothesisName: "Cache tune",
      workerId: "worker_123",
      workerName: "worker-cache",
      slotIndex: 1,
      version: null,
      startedAt: now,
      lastOutputAt: now,
      completedAt: null,
      status: "running",
      exitCode: null,
      signal: null,
      timedOut: false,
      startupTimedOut: false,
      error: null,
      preflight: null,
      finalization: null,
    })
    await writeWorkerLatestState(paths.latestStatePath, {
      schemaVersion: 1,
      at: now,
      sessionId,
      workerId: "worker_123",
      hypothesisId: "hyp_123",
      status: "running",
      phase: "measuring",
      progressMessage: "Evaluating widget cache",
    })
    // The live reasoning feed prefers the model's own words over trailing
    // tool/step bookkeeping, and strips the timestamp prefix.
    await writeFile(
      paths.activityLogPath,
      [
        "[12:00:01] [stdout] thought: Trying a larger cache size",
        "[12:00:02] [stdout] tool: bash",
        "[12:00:03] [stdout] step: finish",
        "",
      ].join("\n"),
      "utf8"
    )
    // A finished worker whose latest-state snapshot froze at "running" — the
    // harness killed the process before it could write a terminal snapshot.
    const donePaths = await workerLaunchPaths({
      root,
      sessionId,
      hypothesisId: "hyp_456",
      hypothesisName: "Batch tune",
      workerId: "worker_456",
    })
    await writeWorkerLaunchManifest({
      schemaVersion: 1,
      agentKind: "codex",
      workerModel: null,
      command: "codex",
      args: [],
      onyxWorkerPath: null,
      workerContextPath: null,
      addedWritableRoots: [],
      cwd: root,
      promptPath: join(donePaths.dir, "prompt.md"),
      logPath: donePaths.logPath,
      activityLogPath: donePaths.activityLogPath,
      activityJsonlPath: donePaths.activityJsonlPath,
      latestStatePath: donePaths.latestStatePath,
      manifestPath: donePaths.manifestPath,
      sessionId,
      hypothesisId: "hyp_456",
      hypothesisName: "Batch tune",
      workerId: "worker_456",
      workerName: "worker-done",
      slotIndex: 2,
      version: null,
      startedAt: now,
      lastOutputAt: now,
      completedAt: now,
      status: "stopped",
      exitCode: 0,
      signal: null,
      timedOut: false,
      startupTimedOut: false,
      error: null,
      preflight: null,
      finalization: null,
    })
    await writeWorkerLatestState(donePaths.latestStatePath, {
      schemaVersion: 1,
      at: now,
      sessionId,
      workerId: "worker_456",
      hypothesisId: "hyp_456",
      status: "running",
      phase: "running",
      progressMessage: "still going (stale)",
    })
    await writeState(root, {
      projectPath: "",
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: CAMPAIGN_ID,
          sessionId,
          metricName: "score",
          metricDirection: "maximize",
        },
      },
      sessions: {
        [sessionId]: {
          campaignName,
          campaignId: CAMPAIGN_ID,
          status: "running",
          providerBackoff: {
            reason: "rate_limit",
            until: new Date(Date.now() + 30_000).toISOString(),
            attempt: 2,
            delayMs: 60_000,
          },
        },
      },
    })

    const text = await captureSnapshot(root)
    // Slot rows: name · hypothesis · status phase · age · trace.
    expect(text).toContain("1 worker-cache · Cache tune · running measuring")
    expect(text).toContain("Trying a larger cache size")
    expect(text).not.toContain("step: finish")
    expect(text).toContain("backoff rate_limit")
    // The terminal manifest wins over the stale "running" snapshot, and
    // terminal workers show no trace line.
    expect(text).toContain("2 worker-done · Batch tune · stopped")
    expect(text).not.toContain("still going (stale)")
    expect(text).toContain("workers 1/2")
  })

  test("collapses the worker panel when the session is terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-listen-"))
    await runProcess("git", ["init"], { cwd: root })
    await repoRoot(root)
    const sessionId = "session_done"
    const now = new Date().toISOString()
    const paths = await workerLaunchPaths({
      root,
      sessionId,
      hypothesisId: "hyp_123",
      hypothesisName: "Cache tune",
      workerId: "worker_123",
    })
    await writeWorkerLaunchManifest({
      schemaVersion: 1,
      agentKind: "codex",
      workerModel: null,
      command: "codex",
      args: [],
      onyxWorkerPath: null,
      workerContextPath: null,
      addedWritableRoots: [],
      cwd: root,
      promptPath: join(paths.dir, "prompt.md"),
      logPath: paths.logPath,
      activityLogPath: paths.activityLogPath,
      activityJsonlPath: paths.activityJsonlPath,
      latestStatePath: paths.latestStatePath,
      manifestPath: paths.manifestPath,
      sessionId,
      hypothesisId: "hyp_123",
      hypothesisName: "Cache tune",
      workerId: "worker_123",
      workerName: "worker-cache",
      slotIndex: 1,
      version: null,
      startedAt: now,
      lastOutputAt: now,
      completedAt: now,
      status: "stopped",
      exitCode: 0,
      signal: null,
      timedOut: false,
      startupTimedOut: false,
      error: null,
      preflight: null,
      finalization: {
        finalizationStatus: "already_logged",
      } as never,
    })
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      campaigns: {
        [campaignStateKey("", "smoke")]: {
          campaignId: CAMPAIGN_ID,
          sessionId,
          metricName: "score",
          metricDirection: "maximize",
        },
      },
      sessions: {
        [sessionId]: {
          campaignName: "smoke",
          campaignId: CAMPAIGN_ID,
          status: "completed",
        },
      },
    })

    const text = await captureSnapshot(root)
    // One summary line, no per-slot rows.
    expect(text).toContain("session completed · 1 workers · 1 already_logged")
    expect(text).not.toContain("worker-cache ·")
  })

  test("renders logged experiments from the Onyx API", async () => {
    const now = new Date().toISOString()
    const experiment = {
      id: "22222222-2222-4222-8222-222222222222",
      runRef: "run-1",
      baseCommitSha: "a".repeat(40),
      resultCommitSha: "b".repeat(40),
      resultRef: `refs/onyx/experiments/${CAMPAIGN_ID}/run-1`,
      gitStatus: "verified",
      status: "succeeded",
      name: "tune-cache-sizes",
      description: "Larger widget cache",
      primaryMetricName: "score",
      primaryMetricValue: 0.42,
      secondaryMetrics: {},
      agentNotes: {},
      checks: null,
      durationMs: 1200,
      outputSummary: null,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      acceptedIndex: 1,
      sessionId: null,
      workerId: null,
      hypothesisId: null,
    }
    const violation = {
      ...experiment,
      id: "33333333-3333-4333-8333-333333333333",
      runRef: "run-2",
      resultCommitSha: "c".repeat(40),
      name: "edited-protected-path",
      status: "setup_violation",
      primaryMetricValue: null,
    }
    const requests: string[] = []
    const port = await getFreePort()
    const server = Bun.serve({
      port,
      fetch(request) {
        const url = new URL(request.url)
        requests.push(url.pathname)
        if (
          url.pathname ===
          `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
        ) {
          return Response.json({
            data: {
              items: [experiment, violation],
              page: { nextCursor: null },
            },
          })
        }
        if (
          url.pathname === `/api/v1/research/campaigns/${CAMPAIGN_ID}/overview`
        ) {
          // The campaign best projection covers experiments beyond the
          // fetched page window.
          return Response.json({
            data: {
              campaign: { id: CAMPAIGN_ID, name: "smoke" },
              bestExperiment: { ...experiment, primaryMetricValue: 0.97 },
              latestExperiments: [],
              sessions: [],
              workers: [],
              hypotheses: [],
              summaries: [],
              knowledge: [],
              counts: { experiments: 2, hypothesisCount: 0, activeWorkers: 0 },
            },
          })
        }
        return Response.json(
          { error: { code: "not_found", message: "not found" } },
          { status: 404 }
        )
      },
    })
    process.env.ONYX_API_URL = `http://127.0.0.1:${server.port}`

    try {
      const root = await mkdtemp(join(tmpdir(), "onyx-listen-"))
      await runProcess("git", ["init"], { cwd: root })
      await repoRoot(root)
      await writeState(root, {
        projectPath: "",
        activeCampaign: "smoke",
        campaigns: {
          [campaignStateKey("", "smoke")]: {
            campaignId: CAMPAIGN_ID,
            metricName: "score",
            metricDirection: "maximize",
          },
        },
      })

      const text = await captureSnapshot(root)
      // Completed experiments come from the remote projection — the old
      // local-history read returned nothing, leaving only unlogged attempts.
      expect(requests).toContain(
        `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
      )
      expect(text).toContain("tune-cache-sizes")
      expect(text).toContain("0.42")
      // The overview projection wins when it beats the fetched window.
      expect(text).toContain("best 0.97")
      // Setup violations render as warnings, not as successes.
      expect(text).toContain("edited-protected-path")
      expect(text).toContain("setup")
      expect(text).not.toContain("api unreachable")
    } finally {
      server.stop(true)
    }
  })

  test("keeps rendering when the Onyx API is unreachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-listen-"))
    await runProcess("git", ["init"], { cwd: root })
    await repoRoot(root)
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      campaigns: {
        [campaignStateKey("", "smoke")]: {
          campaignId: CAMPAIGN_ID,
          metricName: "score",
          metricDirection: "maximize",
        },
      },
    })

    const text = await captureSnapshot(root)
    expect(text).toContain("no experiments yet")
    // A failed fetch is surfaced instead of silently rendering stale data.
    expect(text).toContain("api unreachable")
  })
})
