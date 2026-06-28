import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

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

describe("onyx listen", () => {
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
    await writeState(root, {
      projectPath: "",
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: "campaign_123",
          sessionId,
          metricName: "score",
          metricDirection: "maximize",
        },
      },
      sessions: {
        [sessionId]: {
          campaignName,
          campaignId: "campaign_123",
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

    const text = output.join("")
    expect(text).toContain("worker-cache")
    expect(text).toContain("phase=measuring")
    expect(text).toContain("Evaluating widget cache")
    expect(text).toContain("backoff rate_limit")
  })
})
