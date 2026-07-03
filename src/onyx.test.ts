import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, test } from "bun:test"

import {
  commandResearchFinish,
  commandResearchStatus,
  commandResearchSessionStateBrief,
} from "./commands/research"
import { commandExpList } from "./commands/exp"
import type { ApiSessionStateBrief } from "./lib/api"
import { git } from "./lib/git"
import {
  cacheResearchSessionState,
  researchRuntimeStatePath,
  upsertWorkflowRun,
} from "./lib/research-runtime"
import { updateState } from "./lib/runtime-state"
import {
  placeholderSessionStateBrief,
  writeSessionStateBriefSnapshot,
} from "./lib/session-state-brief"
import {
  workerRuntimePaths,
  writeWorkerRuntimeContext,
  type WorkerRuntimePaths,
} from "./lib/worker-launcher"
import { main } from "./main"

const SESSION_ID = "11111111-1111-4111-8111-111111111111"

let previousApiUrl: string | undefined
let previousApiKey: string | undefined
let previousFetch: typeof fetch | null = null

async function tempRepo(prefix = "onyx-remote-first-") {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await git(["init"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Onyx Test"], root)
  return root
}

async function writeTestWorkerContext({
  root,
  workerId = "22222222-2222-4222-8222-222222222222",
  campaignId = "33333333-3333-4333-8333-333333333333",
  campaignName = "scale-test",
  hypothesisId = "44444444-4444-4444-8444-444444444444",
  hypothesisName = "Hypothesis",
}: {
  root: string
  workerId?: string
  campaignId?: string
  campaignName?: string
  hypothesisId?: string
  hypothesisName?: string
}): Promise<WorkerRuntimePaths> {
  const paths = await workerRuntimePaths({ root, sessionId: SESSION_ID, workerId })
  await writeWorkerRuntimeContext({
    paths,
    context: {
      schemaVersion: 1,
      campaignId,
      campaignName,
      sessionId: SESSION_ID,
      hypothesisId,
      hypothesisName,
      workerId,
      workerLeaseToken: "lease-token",
      workerBranch: "onyx/worker",
      worktreeRoot: root,
      projectPath: "",
      projectRoot: root,
      setupFile: join(root, "onyx/setup.json"),
      validationFile: join(root, "onyx/validation.json"),
      researchSpecFile: join(root, "onyx/onyx.md"),
    },
  })
  return paths
}

function makeSessionStateBrief(): ApiSessionStateBrief {
  const now = new Date("2026-06-29T12:00:00.000Z").toISOString()
  return {
    generatedAt: now,
    session: {
      id: SESSION_ID,
      campaignId: "33333333-3333-4333-8333-333333333333",
      name: "scale-run",
      status: "running",
      workerTarget: 100,
      experimentTarget: 100,
      acceptedExperimentCount: 7,
      remainingExperimentCount: 93,
      deadlineAt: null,
      terminalReason: null,
      schedulerSiteId: "site-1",
      finalizationStatus: "running",
      metadata: {},
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    campaign: {
      id: "33333333-3333-4333-8333-333333333333",
      projectId: "55555555-5555-4555-8555-555555555555",
      parentCampaignId: null,
      name: "scale-test",
      description: "Scale test",
      baseCommitSha: "abc123",
      baseGitStatus: "verified",
      baseGitVerifiedAt: now,
      baseGitStatusReason: null,
      status: "active",
      metricName: "error",
      metricUnit: null,
      metricDirection: "minimize",
      bestExperimentId: null,
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 7,
      lastExperimentAt: now,
      promotionRefName: null,
      createdAt: now,
      updatedAt: now,
    },
    project: {
      id: "55555555-5555-4555-8555-555555555555",
      name: "research-test",
      repositoryUrl: "https://github.com/example/research-test.git",
      repositoryAccessMode: "github_app",
      repositoryFullName: "example/research-test",
      defaultBranch: "main",
      projectPath: "",
    },
    progress: {
      experimentTarget: 100,
      acceptedExperimentCount: 7,
      remainingExperimentCount: 93,
      deadlineAt: null,
      terminalReason: null,
    },
    latestExperiments: [],
    bestExperiment: null,
    activeHypotheses: [],
    summaries: [],
    knowledge: [],
    updatedAt: now,
  }
}

function installMockApi(
  handler: (request: { method: string; path: string; body: unknown }) => unknown
) {
  previousApiUrl = process.env.ONYX_API_URL
  previousApiKey = process.env.ONYX_API_KEY
  previousFetch = globalThis.fetch
  process.env.ONYX_API_URL = "https://api.onyx.test"
  process.env.ONYX_API_KEY = "test-key"
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    const bodyText =
      typeof init?.body === "string" && init.body.length > 0 ? init.body : null
    const response = handler({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: bodyText ? JSON.parse(bodyText) : null,
    })
    return new Response(JSON.stringify({ data: response }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch
  previousFetch = null
  if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
  else process.env.ONYX_API_URL = previousApiUrl
  if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
  else process.env.ONYX_API_KEY = previousApiKey
})

describe("remote-first agent architecture", () => {
  test("runtime state no longer points at .git/onyx/research.db", async () => {
    const root = await tempRepo()
    try {
      const path = await researchRuntimeStatePath(root)
      expect(path).toEndWith(".git/onyx/runtime/runtime-state.json")
      expect(path).not.toContain("research.db")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("public sync and push commands are removed", async () => {
    const originalError = console.error
    const originalExit = process.exit
    const errors: string[] = []
    console.error = (message?: unknown) => {
      errors.push(String(message))
    }
    process.exit = ((code?: number) => {
      throw new Error(`exit ${code ?? 0}`)
    }) as typeof process.exit
    try {
      await expect(main(["push"])).rejects.toThrow("exit 1")
      await expect(main(["sync"])).rejects.toThrow("exit 1")
      expect(errors.join("\n")).toContain("removed")
    } finally {
      console.error = originalError
      process.exit = originalExit
    }
  })

  test("worker session-state-brief reads the local supervisor file only", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const calls: string[] = []
    const originalLog = console.log
    const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    const paths = await writeTestWorkerContext({ root })
    process.env.ONYX_WORKER_CONTEXT = paths.contextPath
    await writeSessionStateBriefSnapshot({
      root,
      sessionId: SESSION_ID,
      snapshot: {
        schemaVersion: 1,
        sequence: 3,
        refreshStatus: "ok",
        generatedAt: "2026-06-29T12:00:00.000Z",
        fetchedAt: "2026-06-29T12:00:01.000Z",
        lastRefreshAttemptAt: "2026-06-29T12:00:01.000Z",
        brief: makeSessionStateBrief(),
      },
    })
    installMockApi(({ method, path }) => {
      calls.push(`${method} ${path}`)
      throw new Error(`unexpected API call: ${method} ${path}`)
    })
    try {
      await commandResearchSessionStateBrief({
        positional: ["research", "session-state-brief"],
        options: { cwd: root, json: "true" },
      })
      const payload = JSON.parse(logs.join("\n"))
      expect(payload.sequence).toBe(3)
      expect(payload.refreshStatus).toBe("ok")
      expect(payload.progress.acceptedExperimentCount).toBe(7)
      expect(payload.worker.sessionId).toBe(SESSION_ID)
      expect(payload.stop).toEqual({
        shouldStopStartingNewWork: false,
        reasonCodes: [],
        reasons: [],
        recommendedAction: "continue",
        activeWorkflowCount: 0,
        unloggedAttemptCount: 0,
      })
      expect(calls).toEqual([])
    } finally {
      console.log = originalLog
      if (previousWorkerContext === undefined)
        delete process.env.ONYX_WORKER_CONTEXT
      else process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker session-state-brief exits after target completion with no active work", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const calls: string[] = []
    const originalLog = console.log
    const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    const paths = await writeTestWorkerContext({ root })
    process.env.ONYX_WORKER_CONTEXT = paths.contextPath
    const brief = makeSessionStateBrief()
    brief.session.status = "completed"
    brief.session.acceptedExperimentCount = 100
    brief.session.remainingExperimentCount = 0
    brief.session.terminalReason = "experiment_target_reached"
    brief.progress.acceptedExperimentCount = 100
    brief.progress.remainingExperimentCount = 0
    brief.progress.terminalReason = "experiment_target_reached"
    await writeSessionStateBriefSnapshot({
      root,
      sessionId: SESSION_ID,
      snapshot: {
        schemaVersion: 1,
        sequence: 4,
        refreshStatus: "ok",
        generatedAt: "2026-06-29T12:00:00.000Z",
        fetchedAt: "2026-06-29T12:00:01.000Z",
        lastRefreshAttemptAt: "2026-06-29T12:00:01.000Z",
        brief,
      },
    })
    installMockApi(({ method, path }) => {
      calls.push(`${method} ${path}`)
      throw new Error(`unexpected API call: ${method} ${path}`)
    })
    try {
      await commandResearchSessionStateBrief({
        positional: ["research", "session-state-brief"],
        options: { cwd: root, json: "true" },
      })
      const payload = JSON.parse(logs.join("\n"))
      expect(payload.stop.shouldStopStartingNewWork).toBe(true)
      expect(payload.stop.reasonCodes).toContain("experiment_target_reached")
      expect(payload.stop.reasonCodes).toContain("session_terminal")
      expect(payload.stop.recommendedAction).toBe("exit")
      expect(payload.stop.activeWorkflowCount).toBe(0)
      expect(payload.stop.unloggedAttemptCount).toBe(0)
      expect(calls).toEqual([])
    } finally {
      console.log = originalLog
      if (previousWorkerContext === undefined)
        delete process.env.ONYX_WORKER_CONTEXT
      else process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker session-state-brief finishes active work before exiting after target completion", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const calls: string[] = []
    const originalLog = console.log
    const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT
    const workerId = "22222222-2222-4222-8222-222222222222"
    const campaignId = "33333333-3333-4333-8333-333333333333"
    const campaignName = "scale-test"
    const hypothesisId = "44444444-4444-4444-8444-444444444444"
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    const paths = await writeTestWorkerContext({
      root,
      workerId,
      campaignId,
      campaignName,
      hypothesisId,
    })
    process.env.ONYX_WORKER_CONTEXT = paths.contextPath
    const now = "2026-06-29T12:00:00.000Z"
    await upsertWorkflowRun({
      root,
      run: {
        id: "workflow-1",
        campaignId,
        campaignName,
        projectPath: "",
        runRef: "run-ref-1",
        baseCommitSha: "abc123",
        resultCommitSha: null,
        resultRef: `refs/onyx/experiments/${campaignId}/run-ref-1`,
        setupHash: "setup-hash",
        status: "running",
        currentStepIndex: 0,
        metrics: {},
        blockReason: null,
        createdAt: now,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        sessionId: SESSION_ID,
        workerId,
        hypothesisId,
      },
    })
    const brief = makeSessionStateBrief()
    brief.session.status = "completed"
    brief.session.acceptedExperimentCount = 100
    brief.session.remainingExperimentCount = 0
    brief.session.terminalReason = "experiment_target_reached"
    brief.progress.acceptedExperimentCount = 100
    brief.progress.remainingExperimentCount = 0
    brief.progress.terminalReason = "experiment_target_reached"
    await writeSessionStateBriefSnapshot({
      root,
      sessionId: SESSION_ID,
      snapshot: {
        schemaVersion: 1,
        sequence: 5,
        refreshStatus: "ok",
        generatedAt: "2026-06-29T12:00:00.000Z",
        fetchedAt: "2026-06-29T12:00:01.000Z",
        lastRefreshAttemptAt: "2026-06-29T12:00:01.000Z",
        brief,
      },
    })
    installMockApi(({ method, path }) => {
      calls.push(`${method} ${path}`)
      throw new Error(`unexpected API call: ${method} ${path}`)
    })
    try {
      await commandResearchSessionStateBrief({
        positional: ["research", "session-state-brief"],
        options: { cwd: root, json: "true" },
      })
      const payload = JSON.parse(logs.join("\n"))
      expect(payload.stop.shouldStopStartingNewWork).toBe(true)
      expect(payload.stop.reasonCodes).toContain("experiment_target_reached")
      expect(payload.stop.recommendedAction).toBe(
        "finish_current_attempt_then_exit"
      )
      expect(payload.stop.activeWorkflowCount).toBe(1)
      expect(payload.stop.unloggedAttemptCount).toBe(0)
      expect(calls).toEqual([])
    } finally {
      console.log = originalLog
      if (previousWorkerContext === undefined)
        delete process.env.ONYX_WORKER_CONTEXT
      else process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker session-state-brief tolerates a missing local brief", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const originalLog = console.log
    const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    const paths = await writeTestWorkerContext({ root })
    process.env.ONYX_WORKER_CONTEXT = paths.contextPath
    try {
      await commandResearchSessionStateBrief({
        positional: ["research", "session-state-brief"],
        options: { cwd: root, json: "true" },
      })
      const payload = JSON.parse(logs.join("\n"))
      expect(payload.refreshStatus).toBe("initializing")
      expect(payload.brief).toBeUndefined()
      expect(payload.progress).toBeNull()
      expect(payload.warnings.length).toBeGreaterThan(0)
      expect(payload.stop.shouldStopStartingNewWork).toBe(false)
      expect(payload.stop.recommendedAction).toBe("continue")
    } finally {
      console.log = originalLog
      if (previousWorkerContext === undefined)
        delete process.env.ONYX_WORKER_CONTEXT
      else process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker session-state-brief treats an initializing placeholder as context-only", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const originalLog = console.log
    const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    const paths = await writeTestWorkerContext({ root })
    process.env.ONYX_WORKER_CONTEXT = paths.contextPath
    await writeSessionStateBriefSnapshot({
      root,
      sessionId: SESSION_ID,
      snapshot: placeholderSessionStateBrief({
        now: "2026-06-29T12:00:00.000Z",
      }),
    })
    try {
      await commandResearchSessionStateBrief({
        positional: ["research", "session-state-brief"],
        options: { cwd: root, json: "true" },
      })
      const payload = JSON.parse(logs.join("\n"))
      expect(payload.refreshStatus).toBe("initializing")
      expect(payload.progress).toBeNull()
      expect(payload.latestExperiments).toEqual([])
      expect(payload.stop.shouldStopStartingNewWork).toBe(false)
      expect(payload.stop.recommendedAction).toBe("continue")
      expect(payload.warnings.join("\n")).toContain(
        "supervisor has not fetched remote state yet"
      )
    } finally {
      console.log = originalLog
      if (previousWorkerContext === undefined)
        delete process.env.ONYX_WORKER_CONTEXT
      else process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
      await rm(root, { recursive: true, force: true })
    }
  })

  test("worker exp list uses worker context campaign id without overview fanout", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const calls: string[] = []
    const originalLog = console.log
    const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT
    const campaignId = "33333333-3333-4333-8333-333333333333"
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    const paths = await writeTestWorkerContext({ root, campaignId })
    process.env.ONYX_WORKER_CONTEXT = paths.contextPath
    installMockApi(({ method, path }) => {
      calls.push(`${method} ${path}`)
      if (
        path.includes("/overview") ||
        path.includes("/projects") ||
        path.includes("/loop-state")
      ) {
        throw new Error(`unexpected fanout read: ${path}`)
      }
      if (path === `/api/v1/research/campaigns/${campaignId}/experiments`) {
        return { items: [], page: { nextCursor: null } }
      }
      throw new Error(`unexpected API call: ${method} ${path}`)
    })
    try {
      await commandExpList({
        positional: ["exp", "list"],
        options: { cwd: root, campaign: "scale-test", limit: "5" },
      })
      expect(logs.join("\n")).toContain(
        "No experiments recorded in the Onyx API yet."
      )
      expect(calls).toEqual([
        `GET /api/v1/research/campaigns/${campaignId}/experiments`,
      ])
    } finally {
      console.log = originalLog
      if (previousWorkerContext === undefined)
        delete process.env.ONYX_WORKER_CONTEXT
      else process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
      await rm(root, { recursive: true, force: true })
    }
  })

  test("research status JSON prefers fresh remote campaign counts over local cache", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const calls: string[] = []
    const originalLog = console.log
    const brief = makeSessionStateBrief()
    const staleCampaign = { ...brief.campaign, experimentCount: 0 }
    const freshCampaign = { ...brief.campaign, experimentCount: 50 }
    const completedSession = {
      ...brief.session,
      acceptedExperimentCount: 50,
      remainingExperimentCount: 0,
      status: "completed" as const,
      terminalReason: "experiment_target_reached" as const,
    }
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    await git(
      ["remote", "add", "origin", "https://github.com/example/research-test.git"],
      root
    )
    await cacheResearchSessionState({
      root,
      campaign: staleCampaign,
      session: completedSession,
    })
    await updateState(root, (state) => {
      state.projectPath = ""
      state.activeCampaign = brief.campaign.name
      state.campaigns = state.campaigns ?? {}
      state.campaigns[brief.campaign.name] = {
        ...(state.campaigns[brief.campaign.name] ?? {}),
        campaignId: brief.campaign.id,
        sessionId: SESSION_ID,
        projectPath: "",
      }
    })
    installMockApi(({ method, path }) => {
      calls.push(`${method} ${path}`)
      if (path === `/api/v1/research/campaigns/${brief.campaign.id}/overview`) {
        return {
          campaign: freshCampaign,
          bestExperiment: null,
          latestExperiments: [],
          sessions: [completedSession],
          workers: [],
          hypotheses: [],
          summaries: [],
          knowledge: [],
          counts: {
            experiments: 50,
            hypothesisCount: 0,
            activeWorkers: 0,
          },
        }
      }
      if (path === `/api/v1/research/sessions/${SESSION_ID}/live`) {
        return {
          session: completedSession,
          campaign: freshCampaign,
          progress: {
            experimentTarget: 100,
            acceptedExperimentCount: 50,
            remainingExperimentCount: 50,
            deadlineAt: null,
            terminalReason: "experiment_target_reached",
          },
          finalization: {
            status: "complete",
            reasons: [],
            terminalReason: "experiment_target_reached",
            unmeasuredSalvageCount: 0,
          },
          livenessCounts: {
            active: 0,
            stale: 0,
            lost: 0,
            unknown: 0,
            terminal: 0,
          },
          phaseCounts: {},
          workers: [],
          sites: [],
          unmatchedPresenceCount: 0,
          ignoredPresence: {},
          providerBackoff: null,
          recentExperiments: [],
          recentTerminalWorkers: [],
          liveWatermark: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      }
      throw new Error(`unexpected API call: ${method} ${path}`)
    })
    try {
      await commandResearchStatus({
        positional: ["research", "status"],
        options: { cwd: root, campaign: brief.campaign.name, json: "true" },
      })
      const payload = JSON.parse(logs.join("\n"))
      expect(payload.campaign.experimentCount).toBe(50)
      expect(calls).toContain(
        `GET /api/v1/research/campaigns/${brief.campaign.id}/overview`
      )
    } finally {
      console.log = originalLog
      await rm(root, { recursive: true, force: true })
    }
  })

  test("research finish completes the campaign before writing final summary", async () => {
    const root = await tempRepo()
    const logs: string[] = []
    const calls: string[] = []
    const originalLog = console.log
    const brief = makeSessionStateBrief()
    const completedSession = {
      ...brief.session,
      status: "completed" as const,
      acceptedExperimentCount: 50,
      remainingExperimentCount: 0,
      terminalReason: "experiment_target_reached" as const,
      finalizationStatus: "complete" as const,
    }
    const completedCampaign = {
      ...brief.campaign,
      status: "completed" as const,
      experimentCount: 50,
    }
    console.log = (message?: unknown) => {
      logs.push(String(message))
    }
    await git(
      ["remote", "add", "origin", "https://github.com/example/research-test.git"],
      root
    )
    await cacheResearchSessionState({
      root,
      campaign: brief.campaign,
      session: completedSession,
    })
    await updateState(root, (state) => {
      state.projectPath = ""
      state.activeCampaign = brief.campaign.name
      state.campaigns = state.campaigns ?? {}
      state.campaigns[brief.campaign.name] = {
        ...(state.campaigns[brief.campaign.name] ?? {}),
        campaignId: brief.campaign.id,
        sessionId: SESSION_ID,
        projectPath: "",
      }
    })
    installMockApi(({ method, path, body }) => {
      calls.push(`${method} ${path}`)
      if (path === `/api/v1/research/campaigns/${brief.campaign.id}/overview`) {
        return {
          campaign: completedCampaign,
          bestExperiment: null,
          latestExperiments: [],
          sessions: [completedSession],
          workers: [],
          hypotheses: [],
          summaries: [],
          knowledge: [],
          counts: {
            experiments: 50,
            hypothesisCount: 0,
            activeWorkers: 0,
          },
        }
      }
      if (path === `/api/v1/research/sessions/${SESSION_ID}/stop`) {
        expect(body).toMatchObject({
          campaignId: brief.campaign.id,
          status: "completed",
          finalizationStatus: "complete",
        })
        return completedSession
      }
      if (path === `/api/v1/research/campaigns/${brief.campaign.id}/complete`) {
        expect(body).toEqual({ sessionId: SESSION_ID })
        return { campaign: completedCampaign }
      }
      if (path === `/api/v1/research/campaigns/${brief.campaign.id}/reconcile`) {
        return {
          campaign: completedCampaign,
          hypotheses: [],
          workers: [],
          experiments: [],
          gitVerification: {
            checkedCount: 0,
            updatedCount: 0,
            remainingCount: 0,
            limit: 100,
            hasMore: false,
          },
        }
      }
      if (path === `/api/v1/research/sessions/${SESSION_ID}/live`) {
        return {
          session: completedSession,
          campaign: completedCampaign,
          progress: {
            experimentTarget: 100,
            acceptedExperimentCount: 50,
            remainingExperimentCount: 0,
            deadlineAt: null,
            terminalReason: "experiment_target_reached",
          },
          finalization: {
            status: "complete",
            reasons: [],
            terminalReason: "experiment_target_reached",
            unmeasuredSalvageCount: 0,
          },
          livenessCounts: {
            active: 0,
            stale: 0,
            lost: 0,
            unknown: 0,
            terminal: 0,
          },
          phaseCounts: {},
          workers: [],
          sites: [],
          unmatchedPresenceCount: 0,
          ignoredPresence: {},
          providerBackoff: null,
          recentExperiments: [],
          recentTerminalWorkers: [],
          liveWatermark: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      }
      if (path === `/api/v1/research/campaigns/${brief.campaign.id}/summaries`) {
        return {
          summary: {
            id: "77777777-7777-4777-8777-777777777777",
            campaignId: brief.campaign.id,
            sessionId: SESSION_ID,
            hypothesisId: null,
            authoredByWorkerId: null,
            experimentId: null,
            summaryKind: "campaign_brief",
            title: "final results",
            body: "done",
            isCurrent: true,
            metadata: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }
      }
      throw new Error(`unexpected API call: ${method} ${path}`)
    })
    try {
      await commandResearchFinish({
        positional: ["research", "finish"],
        options: { cwd: root, campaign: brief.campaign.name },
      })
      expect(logs.join("\n")).toContain(
        `Finalized campaign ${brief.campaign.name}.`
      )
      expect(calls.indexOf(`POST /api/v1/research/campaigns/${brief.campaign.id}/complete`)).toBeGreaterThan(
        calls.indexOf(`POST /api/v1/research/sessions/${SESSION_ID}/stop`)
      )
      expect(calls.indexOf(`POST /api/v1/research/campaigns/${brief.campaign.id}/summaries`)).toBeGreaterThan(
        calls.indexOf(`POST /api/v1/research/campaigns/${brief.campaign.id}/complete`)
      )
    } finally {
      console.log = originalLog
      await rm(root, { recursive: true, force: true })
    }
  })

  test("finish rejects removed offline and sync flags", async () => {
    const root = await tempRepo()
    try {
      await expect(
        commandResearchFinish({
          positional: ["research", "finish"],
          options: { cwd: root, offline: "true", campaign: "smoke" },
        })
      ).rejects.toThrow("removed")
      await expect(
        commandResearchFinish({
          positional: ["research", "finish"],
          options: { cwd: root, "final-sync-timeout": "1", campaign: "smoke" },
        })
      ).rejects.toThrow("removed")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
