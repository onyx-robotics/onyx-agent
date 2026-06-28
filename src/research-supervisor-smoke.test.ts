import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { commandResearchRun } from "./commands/research"
import { setupHash, type ResearchSetupFile } from "./lib/contract"
import { currentCommit, git } from "./lib/git"
import { writeState } from "./lib/outbox"
import { campaignStateKey } from "./lib/project"

const PROJECT_ID = "10000000-0000-4000-8000-000000000001"
const CAMPAIGN_ID = "20000000-0000-4000-8000-000000000001"
const SESSION_ID = "30000000-0000-4000-8000-000000000001"
const HYPOTHESIS_ID = "40000000-0000-4000-8000-000000000001"
const SITE_ID = "50000000-0000-4000-8000-000000000001"

let previousApiUrl: string | undefined
let previousApiKey: string | undefined
let previousFetch: typeof fetch | null = null

type ApiCall = { method: string; path: string; body: unknown }

function nowIso() {
  return new Date().toISOString()
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function pathExists(path: string) {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

async function withMutedConsole<T>(fn: () => Promise<T>) {
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
  }
}

function setupFile(): ResearchSetupFile {
  return {
    schemaVersion: 2,
    goal: "Improve smoke score",
    projectPath: "",
    scope: {
      editable: ["src"],
      protected: [
        "onyx/setup.json",
        "onyx/validation.json",
        "onyx/onyx.md",
        "onyx/tools/",
      ],
    },
    metric: { name: "score", unit: null, direction: "maximize" },
    resources: {},
    tools: {
      "evaluation.run": {
        description: "Emit a deterministic smoke metric.",
        command: "bash",
        args: ["onyx/tools/evaluation/run.sh"],
        shell: false,
        cwd: "project",
        env: {},
        resources: [],
        timeoutSeconds: 30,
        leaseTimeoutSeconds: 30,
        outputLimitBytes: 4000,
      },
    },
    workflow: [
      {
        id: "edit",
        agent: "Make one scoped code change and commit it.",
        optional: false,
      },
      {
        id: "evaluate",
        run: "evaluation.run",
        metric: true,
        optional: false,
      },
    ],
  }
}

async function createSmokeRepo() {
  const root = await mkdtemp(join(tmpdir(), "onyx-supervisor-smoke-"))
  const origin = await mkdtemp(join(tmpdir(), "onyx-supervisor-origin-"))
  const workerScriptDir = await mkdtemp(join(tmpdir(), "onyx-supervisor-worker-"))
  await git(["init", "--bare"], origin)
  await git(["init"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Onyx Test"], root)
  await git(["remote", "add", "origin", origin], root)

  const setup = setupFile()
  await mkdir(join(root, "onyx", "tools", "evaluation"), { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src", "smoke.txt"), "base\n", "utf8")
  await writeFile(join(root, "onyx", "setup.json"), `${JSON.stringify(setup, null, 2)}\n`, "utf8")
  await writeFile(
    join(root, "onyx", "onyx.md"),
    [
      "# Smoke research spec",
      "",
      "Evaluation improves the score metric. The editable scope is src.",
      "Workers should make one small committed change before reporting.",
    ].join("\n"),
    "utf8"
  )
  const evalScript = join(root, "onyx", "tools", "evaluation", "run.sh")
  await writeFile(evalScript, "#!/bin/sh\nprintf 'METRIC score=1\\n'\n", "utf8")
  await chmod(evalScript, 0o755)
  await writeFile(
    join(root, "onyx", "validation.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "passed",
        setupHash: setupHash(setup),
        generatedAt: nowIso(),
        checks: [
          {
            id: "metric_tool_readiness",
            status: "passed",
            message: "Metric tool emitted METRIC score=1.",
            evidence: { toolId: "evaluation.run" },
          },
        ],
        summary: null,
      },
      null,
      2
    )}\n`,
    "utf8"
  )
  await git(["add", "."], root)
  await git(["commit", "-m", "Add smoke setup"], root)
  await git(["push", "-u", "origin", "HEAD"], root)
  const baseCommitSha = await currentCommit(root)

  await writeState(root, {
    projectId: PROJECT_ID,
    projectPath: "",
    activeCampaign: "smoke",
    campaigns: {
      [campaignStateKey("", "smoke")]: {
        campaignId: CAMPAIGN_ID,
        projectPath: "",
        baseCommitSha,
        metricName: "score",
        metricUnit: null,
        metricDirection: "maximize",
      },
    },
  })

  const workerScript = join(workerScriptDir, "fake-worker.sh")
  await writeFile(
    workerScript,
    [
      "#!/bin/sh",
      "set -eu",
      "echo \"fake worker ${ONYX_WORKER_ID}\"",
      "printf \"result ${ONYX_WORKER_ID}\\n\" > src/result.txt",
      "git add src/result.txt",
      "git commit -m \"fake worker result ${ONYX_WORKER_ID}\"",
    ].join("\n"),
    "utf8"
  )
  await chmod(workerScript, 0o755)

  return { root, origin, workerScriptDir, baseCommitSha, workerScript }
}

function campaign(baseCommitSha: string) {
  return {
    id: CAMPAIGN_ID,
    projectId: PROJECT_ID,
    name: "smoke",
    description: "Smoke campaign",
    baseCommitSha,
    status: "active",
    metricName: "score",
    metricUnit: null,
    metricDirection: "maximize",
    bestExperimentId: null,
    bestMetricValue: null,
    bestCommitSha: null,
    experimentCount: 0,
    promotionRefName: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function session({
  workerTarget,
  status,
  acceptedExperimentCount,
}: {
  workerTarget: number
  status: "running" | "completed"
  acceptedExperimentCount: number
}) {
  return {
    id: SESSION_ID,
    campaignId: CAMPAIGN_ID,
    name: "smoke-session",
    status,
    workerTarget,
    experimentTarget: 1,
    acceptedExperimentCount,
    remainingExperimentCount: Math.max(0, 1 - acceptedExperimentCount),
    deadlineAt: null,
    terminalReason:
      status === "completed" ? "experiment_target_reached" : null,
    schedulerSiteId: SITE_ID,
    finalizationStatus: status === "completed" ? "complete" : "running",
    metadata: {},
    startedAt: nowIso(),
    completedAt: status === "completed" ? nowIso() : null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function hypothesis(baseCommitSha: string) {
  return {
    id: HYPOTHESIS_ID,
    campaignId: CAMPAIGN_ID,
    createdBySessionId: SESSION_ID,
    name: "smoke-hypothesis",
    description: null,
    status: "active",
    baseCommitSha,
    bestExperimentId: null,
    bestMetricValue: null,
    lastWorkedAt: null,
    plan: {
      focus: "Smoke",
      statement: "A fake worker can produce a measured result.",
      startingPoints: ["src/smoke.txt"],
      avoidList: [],
      successSignals: ["score is recorded"],
      giveUpSignals: ["worker cannot launch"],
    },
    metadata: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function worker(workerId: string, status: "registered" | "running" | "completed") {
  return {
    id: workerId,
    campaignId: CAMPAIGN_ID,
    sessionId: SESSION_ID,
    hypothesisId: HYPOTHESIS_ID,
    workerName: "smoke-hypothesis-custom",
    agentKind: "custom",
    runtime: "local",
    status,
    currentExperimentId: null,
    phase: status,
    progressMessage: null,
    gitLabel: null,
    siteId: SITE_ID,
    supervisorRunId: "supervisor-smoke",
    leaseExpiresAt: status === "completed" ? null : new Date(Date.now() + 60_000).toISOString(),
    leaseReleasedAt: status === "completed" ? nowIso() : null,
    lastSeenAt: nowIso(),
    startedAt: nowIso(),
    metadata: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}

function installSupervisorApi({
  baseCommitSha,
  workerTarget,
  reportOutcome = "accepted",
}: {
  baseCommitSha: string
  workerTarget: number
  reportOutcome?: "accepted" | "rejected"
}) {
  previousApiUrl = process.env.ONYX_API_URL
  previousApiKey = process.env.ONYX_API_KEY
  previousFetch = globalThis.fetch
  process.env.ONYX_API_URL = "https://api.onyx.test"
  process.env.ONYX_API_KEY = "test-key"

  const calls: ApiCall[] = []
  let acceptedExperimentCount = 0
  let terminal = false
  let workerSequence = 0
  const leasedWorkers: string[] = []
  const currentCampaign = campaign(baseCommitSha)
  const currentHypothesis = hypothesis(baseCommitSha)

  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    const method = init?.method ?? "GET"
    const bodyText =
      typeof init?.body === "string" && init.body.length > 0
        ? init.body
        : null
    const body = bodyText ? JSON.parse(bodyText) : null
    calls.push({ method, path: url.pathname, body })

    const runningSession = session({
      workerTarget,
      status: terminal ? "completed" : "running",
      acceptedExperimentCount,
    })

    let data: unknown
    if (
      method === "GET" &&
      url.pathname === `/api/v1/research/campaigns/${CAMPAIGN_ID}/overview`
    ) {
      data = {
        campaign: currentCampaign,
        bestExperiment: null,
        latestExperiments: [],
        workers: [],
        hypotheses: [currentHypothesis],
        summaries: [],
        knowledge: [],
        sessions: [],
        counts: { experiments: 0, hypothesisCount: 1, activeWorkers: 0 },
      }
    } else if (
      method === "POST" &&
      url.pathname === `/api/v1/research/campaigns/${CAMPAIGN_ID}/sessions`
    ) {
      data = { session: runningSession, hypotheses: [currentHypothesis] }
    } else if (
      method === "GET" &&
      url.pathname === `/api/v1/research/sessions/${SESSION_ID}/control-state`
    ) {
      data = {
        sessionId: SESSION_ID,
        status: runningSession.status,
        finalizationStatus: runningSession.finalizationStatus,
        progress: {
          experimentTarget: 1,
          acceptedExperimentCount,
          remainingExperimentCount: Math.max(0, 1 - acceptedExperimentCount),
          deadlineAt: null,
          terminalReason: runningSession.terminalReason,
        },
        finalization: {
          status: runningSession.finalizationStatus,
          reasons: [],
          terminalReason: runningSession.terminalReason,
          unmeasuredSalvageCount: 0,
        },
        updatedAt: nowIso(),
      }
    } else if (
      method === "POST" &&
      url.pathname === `/api/v1/research/sessions/${SESSION_ID}/worker-leases`
    ) {
      workerSequence += 1
      const workerId = `60000000-0000-4000-8000-${String(workerSequence).padStart(12, "0")}`
      leasedWorkers.push(workerId)
      data = {
        worker: worker(workerId, "registered"),
        leaseToken: `lease-token-${workerSequence}`.padEnd(16, "x"),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        hypothesis: currentHypothesis,
        session: runningSession,
        campaign: currentCampaign,
        project: {
          id: PROJECT_ID,
          name: "Smoke project",
          repositoryUrl: "https://github.com/onyx/smoke",
          repositoryFullName: "onyx/smoke",
          defaultBranch: "main",
          projectPath: "",
        },
      }
    } else if (
      method === "POST" &&
      /^\/api\/v1\/research\/workers\/[^/]+\/heartbeat$/.test(url.pathname)
    ) {
      const workerId = url.pathname.split("/").at(-2)!
      data = {
        worker: worker(
          workerId,
          body?.status === "completed" ? "completed" : "running"
        ),
        heartbeat: {
          id: `70000000-0000-4000-8000-${String(calls.length).padStart(12, "0")}`,
          campaignId: CAMPAIGN_ID,
          sessionId: SESSION_ID,
          hypothesisId: HYPOTHESIS_ID,
          workerId,
          experimentId: null,
          status: body?.status ?? "running",
          event: body?.event ?? null,
          phase: body?.phase ?? null,
          progressMessage: body?.progressMessage ?? null,
          gitLabel: body?.gitLabel ?? null,
          resourceStats: {},
          metadata: body?.metadata ?? {},
          recordedAt: nowIso(),
          createdAt: nowIso(),
        },
      }
    } else if (
      method === "POST" &&
      url.pathname === `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
    ) {
      terminal = true
      acceptedExperimentCount = 1
      const rejected = reportOutcome === "rejected"
      data = {
        outcome: reportOutcome,
        experiment: {
          id: "80000000-0000-4000-8000-000000000001",
          campaignId: CAMPAIGN_ID,
          sessionId: SESSION_ID,
          hypothesisId: HYPOTHESIS_ID,
          workerId: body?.workerId ?? leasedWorkers[0] ?? null,
          acceptedIndex: rejected ? null : 1,
          runRef: body?.runRef ?? "run",
          name: body?.name ?? "experiment",
          description: body?.description ?? null,
          baseCommitSha: body?.baseCommitSha,
          resultCommitSha: body?.resultCommitSha,
          resultRef: body?.resultRef,
          status: rejected ? "rejected" : "succeeded",
          setupCompliance: body?.setupCompliance ?? null,
          gitStatus: "pending",
          gitVerifiedAt: null,
          gitStatusReason: null,
          primaryMetricName: body?.primaryMetricName ?? "score",
          primaryMetricValue: body?.primaryMetricValue ?? null,
          secondaryMetrics: body?.secondaryMetrics ?? {},
          artifactRefs: body?.artifactRefs ?? {},
          agentNotes: body?.agentNotes ?? {},
          checks: body?.checks ?? null,
          durationMs: body?.durationMs ?? null,
          outputSummary: body?.outputSummary ?? null,
          startedAt: body?.startedAt ?? null,
          completedAt: body?.completedAt ?? nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        session: session({
          workerTarget,
          status: "completed",
          acceptedExperimentCount,
        }),
      }
    } else if (
      method === "POST" &&
      url.pathname === `/api/v1/research/campaigns/${CAMPAIGN_ID}/summaries`
    ) {
      data = {
        id: "90000000-0000-4000-8000-000000000001",
        campaignId: CAMPAIGN_ID,
        sessionId: body?.sessionId ?? null,
        hypothesisId: body?.hypothesisId ?? null,
        authoredByWorkerId: body?.authoredByWorkerId ?? null,
        summaryKind: body?.summaryKind ?? "hypothesis_summary",
        title: body?.title ?? "summary",
        body: body?.body ?? "",
        isCurrent: body?.isCurrent ?? false,
        metadata: body?.metadata ?? {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
    } else if (
      method === "POST" &&
      url.pathname === "/api/v1/research/presence"
    ) {
      data = {
        ignoredWorkers: [],
        ignoredByReason: {
          notFound: 0,
          sessionMismatch: 0,
          staleSequence: 0,
          unmatchedCap: 0,
          updateFailed: 0,
          sessionNotFound: 0,
        },
        acceptedCount: Array.isArray(body?.workers) ? body.workers.length : 0,
        ignoredCount: 0,
        unmatchedCount: 0,
        uploadedWorkerCount: Array.isArray(body?.workers)
          ? body.workers.length
          : 0,
        unchangedWorkerCount: body?.site?.unchangedWorkerCount ?? 0,
        droppedOrDeferredWorkerCount:
          body?.site?.droppedOrDeferredWorkerCount ?? 0,
      }
    } else if (
      method === "POST" &&
      url.pathname === `/api/v1/research/sessions/${SESSION_ID}/stop`
    ) {
      terminal = true
      data = session({
        workerTarget,
        status: "completed",
        acceptedExperimentCount,
      })
    } else if (
      method === "GET" &&
      url.pathname === `/api/v1/research/sessions/${SESSION_ID}/live`
    ) {
      data = {
        session: session({
          workerTarget,
          status: "completed",
          acceptedExperimentCount,
        }),
        campaign: currentCampaign,
        progress: {
          experimentTarget: 1,
          acceptedExperimentCount,
          remainingExperimentCount: Math.max(0, 1 - acceptedExperimentCount),
          deadlineAt: null,
          terminalReason: "experiment_target_reached",
        },
        finalization: {
          status: "complete",
          reasons: [],
          terminalReason: "experiment_target_reached",
          unmeasuredSalvageCount: 0,
        },
        livenessCounts: {},
        phaseCounts: {},
        workers: [],
        sites: [],
        unmatchedPresenceCount: 0,
        ignoredPresence: {},
        providerBackoff: null,
        recentExperiments: [],
        recentTerminalWorkers: [],
        liveWatermark: nowIso(),
        updatedAt: nowIso(),
      }
    } else {
      return new Response(
        JSON.stringify({
          error: {
            code: "not_found",
            message: `${method} ${url.pathname} was not mocked`,
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    }

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  return calls
}

afterEach(() => {
  if (previousFetch) globalThis.fetch = previousFetch
  previousFetch = null
  if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
  else process.env.ONYX_API_URL = previousApiUrl
  if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
  else process.env.ONYX_API_KEY = previousApiKey
})

describe("remote-first research supervisor smoke", () => {
  for (const workerTarget of [1, 10, 100]) {
    test(
      `acquires server leases and reports directly at worker target ${workerTarget}`,
      async () => {
        const { root, origin, workerScriptDir, baseCommitSha, workerScript } =
          await createSmokeRepo()
        const calls = installSupervisorApi({ baseCommitSha, workerTarget })
        try {
          await withMutedConsole(() =>
            commandResearchRun({
              positional: ["research", "run"],
              options: {
                cwd: root,
                campaign: "smoke",
                workers: String(workerTarget),
                "max-concurrency": "1",
                experiments: "1",
                foreground: "true",
                quiet: "true",
                "worker-command": shellQuote(workerScript),
                "presence-interval": "0.1",
                "launch-interval-seconds": "0.01",
                "startup-timeout": "5",
                "heartbeat-sample-interval": "0",
                "first-attempt-warning-seconds": "0",
                "final-ref-push-timeout": "5",
              },
            })
          )

          const leaseCalls = calls.filter((call) =>
            call.path.endsWith(`/sessions/${SESSION_ID}/worker-leases`)
          )
          expect(leaseCalls).toHaveLength(1)
          expect(leaseCalls[0]!.body).toMatchObject({
            workerName: "smoke-hypothesis-custom",
            agentKind: "custom",
            runtime: "local",
          })
          const sessionCreate = calls.find((call) =>
            call.path.endsWith(`/campaigns/${CAMPAIGN_ID}/sessions`)
          )
          expect(sessionCreate?.body).toMatchObject({
            workerTarget,
            experimentTarget: 1,
          })
          const presenceCalls = calls.filter(
            (call) => call.path === "/api/v1/research/presence"
          )
          expect(presenceCalls.length).toBeGreaterThan(0)
          for (const call of presenceCalls) {
            expect(call.body).not.toHaveProperty("syncLagMs")
            expect(call.body).not.toHaveProperty("pendingSyncCount")
            expect(call.body).not.toHaveProperty("pushQueueDepth")
          }
          expect(
            calls.some(
              (call) =>
                call.method === "POST" &&
                call.path ===
                  `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
            )
          ).toBe(true)
          expect(await pathExists(join(root, ".git", "onyx", "research.db"))).toBe(
            false
          )
          expect(
            await pathExists(join(root, ".git", "onyx", "outbox.d", "pending"))
          ).toBe(false)
        } finally {
          await rm(root, { recursive: true, force: true })
          await rm(origin, { recursive: true, force: true })
          await rm(workerScriptDir, { recursive: true, force: true })
        }
      },
      60_000
    )
  }

  test("records late rejected experiment reports as clean finalization outcomes", async () => {
    const { root, origin, workerScriptDir, baseCommitSha, workerScript } =
      await createSmokeRepo()
    const calls = installSupervisorApi({
      baseCommitSha,
      workerTarget: 1,
      reportOutcome: "rejected",
    })
    try {
      await withMutedConsole(() =>
        commandResearchRun({
          positional: ["research", "run"],
          options: {
            cwd: root,
            campaign: "smoke",
            workers: "1",
            "max-concurrency": "1",
            experiments: "1",
            foreground: "true",
            quiet: "true",
            "worker-command": shellQuote(workerScript),
            "presence-interval": "0.1",
            "launch-interval-seconds": "0.01",
            "startup-timeout": "5",
            "heartbeat-sample-interval": "0",
            "first-attempt-warning-seconds": "0",
            "final-ref-push-timeout": "5",
          },
        })
      )

      const manifestFiles = calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path === `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
      )
      expect(manifestFiles).toHaveLength(1)
      const workerLogRoot = join(root, ".git", "onyx", "worker-logs", SESSION_ID)
      const manifests = await Promise.all(
        (await readdir(workerLogRoot))
          .filter((file) => file.endsWith(".manifest.json"))
          .map(async (file) =>
            JSON.parse(await readFile(join(workerLogRoot, file), "utf8")) as {
              finalization?: {
                finalizationStatus?: string
                error?: string | null
              }
            }
          )
      )
      expect(
        manifests.some(
          (manifest) =>
            manifest.finalization?.finalizationStatus ===
              "discarded_after_completion" &&
            manifest.finalization.error ===
              "experiment report rejected by server acceptance state"
        )
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(origin, { recursive: true, force: true })
      await rm(workerScriptDir, { recursive: true, force: true })
    }
  }, 60_000)
})
