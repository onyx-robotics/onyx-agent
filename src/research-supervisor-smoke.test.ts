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
import { writeState } from "./lib/runtime-state"
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

const FAKE_WORKER_COMMAND = [
  "printf 'result\\n' > src/result.txt",
  "git add src/result.txt",
  "git commit -m 'fake worker result'",
].join(" && ")

function nowIso() {
  return new Date().toISOString()
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
  await git(["init", "--bare"], origin)
  await git(["init"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Onyx Test"], root)
  await git(["remote", "add", "origin", origin], root)

  const setup = setupFile()
  await mkdir(join(root, "onyx", "tools", "evaluation"), { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src", "smoke.txt"), "base\n", "utf8")
  await writeFile(
    join(root, "onyx", "setup.json"),
    `${JSON.stringify(setup, null, 2)}\n`,
    "utf8"
  )
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

  return { root, origin, baseCommitSha }
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
    terminalReason: status === "completed" ? "experiment_target_reached" : null,
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

function worker(
  workerId: string,
  status: "registered" | "running" | "completed"
) {
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
    leaseExpiresAt:
      status === "completed"
        ? null
        : new Date(Date.now() + 60_000).toISOString(),
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
  reportDisposition = "received",
  leaseMode = "normal",
  reportFailure = false,
}: {
  baseCommitSha: string
  workerTarget: number
  reportDisposition?: "received" | "accepted" | "discarded"
  leaseMode?: "normal" | "no_slots"
  reportFailure?: boolean
}) {
  previousApiUrl = process.env.ONYX_API_URL
  previousApiKey = process.env.ONYX_API_KEY
  previousFetch = globalThis.fetch
  process.env.ONYX_API_URL = "https://api.onyx.test"
  process.env.ONYX_API_KEY = "test-key"

  const calls: ApiCall[] = []
  let acceptedExperimentCount = 0
  let receivedExperimentCount = 0
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
      typeof init?.body === "string" && init.body.length > 0 ? init.body : null
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
        launch: {
          activeWorkerCount: leasedWorkers.length,
          workerTarget,
          openWorkerSlotCount: Math.max(0, workerTarget - leasedWorkers.length),
          activeHypothesisCount: 1,
          acceptingExperiments:
            runningSession.status === "running" && acceptedExperimentCount < 1,
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
      url.pathname === `/api/v1/research/sessions/${SESSION_ID}/settle`
    ) {
      if (receivedExperimentCount > 0) {
        acceptedExperimentCount = 1
        terminal = true
      }
      data = {
        sessionId: SESSION_ID,
        status: terminal ? "completed" : "running",
        finalizationStatus: runningSession.finalizationStatus,
        progress: {
          experimentTarget: 1,
          acceptedExperimentCount,
          remainingExperimentCount: Math.max(0, 1 - acceptedExperimentCount),
          deadlineAt: null,
          terminalReason: terminal ? "experiment_target_reached" : null,
        },
        launch: {
          activeWorkerCount: leasedWorkers.length,
          workerTarget,
          openWorkerSlotCount: Math.max(0, workerTarget - leasedWorkers.length),
          activeHypothesisCount: 1,
          acceptingExperiments: !terminal && acceptedExperimentCount < 1,
        },
        finalization: {
          status: runningSession.finalizationStatus,
          reasons: [],
          terminalReason: terminal ? "experiment_target_reached" : null,
          unmeasuredSalvageCount: 0,
        },
        updatedAt: nowIso(),
      }
    } else if (
      method === "POST" &&
      url.pathname ===
        `/api/v1/research/sessions/${SESSION_ID}/worker-leases/batch`
    ) {
      if (leaseMode === "no_slots") {
        terminal = true
        data = {
          grants: [],
          unavailable: (body?.workers ?? []).map(
            (requested: { workerRef: string; workerName: string }) => ({
              workerRef: requested.workerRef,
              workerName: requested.workerName,
              code: "no_worker_slots",
              message: "Research session has no open worker slots",
            })
          ),
          capacity: {
            workerTarget,
            occupied: workerTarget,
            requested: body?.workers?.length ?? 0,
            granted: 0,
            existing: 0,
            openSlots: 0,
          },
        }
      } else {
        const grants = (body?.workers ?? []).map(
          (requested: { workerRef: string; workerName: string }) => {
            workerSequence += 1
            const workerId = `60000000-0000-4000-8000-${String(workerSequence).padStart(12, "0")}`
            leasedWorkers.push(workerId)
            return {
              workerRef: requested.workerRef,
              worker: {
                ...worker(workerId, "registered"),
                workerName: requested.workerName,
                workerRef: requested.workerRef,
              },
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
              existing: false,
            }
          }
        )
        data = {
          grants,
          unavailable: [],
          capacity: {
            workerTarget,
            occupied: 0,
            requested: body?.workers?.length ?? 0,
            granted: grants.length,
            existing: 0,
            openSlots: workerTarget,
          },
        }
      }
    } else if (
      method === "POST" &&
      url.pathname === `/api/v1/research/sessions/${SESSION_ID}/worker-leases`
    ) {
      if (leaseMode === "no_slots") {
        terminal = true
        return new Response(
          JSON.stringify({
            error: {
              code: "conflict",
              message: "Research session has no open worker slots",
              details: {
                code: "no_worker_slots",
                workerTarget,
                occupied: workerTarget,
              },
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } }
        )
      }
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
      if (
        body?.status === "completed" ||
        body?.status === "failed" ||
        body?.status === "stopped"
      ) {
        terminal = true
      }
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
      url.pathname === "/api/v1/research/worker-heartbeats/batch"
    ) {
      data = {
        results: (body?.heartbeats ?? []).map(
          (heartbeat: {
            workerId: string
            status?: string
            event?: string
          }) => ({
            workerId: heartbeat.workerId,
            ok: true,
            worker: worker(
              heartbeat.workerId,
              heartbeat.status === "completed" ? "completed" : "running"
            ),
            heartbeat: {
              id: `70000000-0000-4000-8000-${String(calls.length).padStart(12, "0")}`,
              campaignId: CAMPAIGN_ID,
              sessionId: SESSION_ID,
              hypothesisId: HYPOTHESIS_ID,
              workerId: heartbeat.workerId,
              experimentId: null,
              status: heartbeat.status ?? "running",
              event: heartbeat.event ?? null,
              phase: "running",
              progressMessage: null,
              gitLabel: null,
              resourceStats: {},
              metadata: {},
              createdAt: nowIso(),
            },
          })
        ),
      }
    } else if (
      method === "POST" &&
      url.pathname === `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
    ) {
      if (reportFailure) {
        return new Response(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "simulated report failure",
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        )
      }
      receivedExperimentCount += 1
      data = {
        outcome: "recorded",
        experiment: {
          id: "80000000-0000-4000-8000-000000000001",
          campaignId: CAMPAIGN_ID,
          sessionId: SESSION_ID,
          hypothesisId: HYPOTHESIS_ID,
          workerId: body?.workerId ?? leasedWorkers[0] ?? null,
          acceptedIndex: reportDisposition === "accepted" ? 1 : null,
          runRef: body?.runRef ?? "run",
          name: body?.name ?? "experiment",
          description: body?.description ?? null,
          baseCommitSha: body?.baseCommitSha,
          resultCommitSha: body?.resultCommitSha,
          resultRef: body?.resultRef,
          status: "succeeded",
          disposition: reportDisposition,
          dispositionReason:
            reportDisposition === "discarded"
              ? "experiment_target_reached"
              : reportDisposition === "accepted"
                ? "accepted"
                : null,
          settledAt: reportDisposition === "received" ? null : nowIso(),
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
      url.pathname === `/api/v1/research/campaigns/${CAMPAIGN_ID}/verify-git`
    ) {
      data = {
        checkedCount: 0,
        updatedCount: 0,
        remainingCount: 0,
        limit: Number(url.searchParams.get("gitVerifyLimit") ?? 50),
        hasMore: false,
        base: {
          checked: true,
          updated: false,
          previousStatus: "verified",
          status: "verified",
          verifiedAt: null,
          statusReason: null,
        },
        summary: {
          repositoryAccessMode: "github_app",
          baseGitStatus: "verified",
          baseGitVerifiedAt: null,
          baseGitStatusReason: null,
          acceptedExperimentGitStatusCounts: {
            local_reported: 0,
            pending: 0,
            verified: 0,
            missing: 0,
            mismatch: 0,
            unreachable: 0,
          },
          needsVerificationCount: 0,
          hardFailureCount: 0,
          lastVerifiedAt: null,
          recommendedAction: "none",
          message: "No accepted experiment refs need Git verification yet.",
        },
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
    test(`acquires server leases and reports directly at worker target ${workerTarget}`, async () => {
      const { root, origin, baseCommitSha } = await createSmokeRepo()
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
              "worker-command": FAKE_WORKER_COMMAND,
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
          call.path.endsWith(`/sessions/${SESSION_ID}/worker-leases/batch`)
        )
        expect(leaseCalls).toHaveLength(1)
        expect(leaseCalls[0]!.body).toMatchObject({
          workers: [
            {
              workerRef: expect.any(String),
              workerName: "custom-1",
              agentKind: "custom",
              runtime: "local",
            },
          ],
        })
        expect(
          calls.some(
            (call) =>
              call.method === "POST" &&
              call.path === "/api/v1/research/worker-heartbeats/batch"
          )
        ).toBe(true)
        expect(
          calls.some(
            (call) =>
              call.method === "GET" &&
              call.path === `/api/v1/research/sessions/${SESSION_ID}/state`
          )
        ).toBe(false)
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
        expect(
          new Set([
            (leaseCalls[0]!.body as { supervisorRunId?: string })
              .supervisorRunId,
            ...presenceCalls.map(
              (call) =>
                (call.body as { supervisorRunId?: string }).supervisorRunId
            ),
          ]).size
        ).toBe(1)
        expect(
          presenceCalls.some(
            (call) =>
              ((call.body as { site?: { launchedWorkerCount?: number } }).site
                ?.launchedWorkerCount ?? 0) >= 1
          )
        ).toBe(true)
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
        expect(
          await pathExists(join(root, ".git", "onyx", "research.db"))
        ).toBe(false)
        expect(
          await pathExists(join(root, ".git", "onyx", "outbox.d", "pending"))
        ).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(origin, { recursive: true, force: true })
      }
    }, 60_000)
  }

  test("treats settled discarded experiment reports as clean logged outcomes", async () => {
    const { root, origin, baseCommitSha } = await createSmokeRepo()
    const calls = installSupervisorApi({
      baseCommitSha,
      workerTarget: 1,
      reportDisposition: "discarded",
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
            "worker-command": FAKE_WORKER_COMMAND,
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
      const workerLogRoot = join(
        root,
        ".git",
        "onyx",
        "worker-logs",
        SESSION_ID
      )
      const manifests = await Promise.all(
        (await readdir(workerLogRoot))
          .filter((file) => file.endsWith(".manifest.json"))
          .map(
            async (file) =>
              JSON.parse(await readFile(join(workerLogRoot, file), "utf8")) as {
                finalization?: {
                  finalizationStatus?: string
                  workerBranchPushStatus?: string
                  error?: string | null
                }
              }
          )
      )
      expect(
        manifests.some(
          (manifest) =>
            manifest.finalization?.finalizationStatus === "measured_and_logged"
        )
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(origin, { recursive: true, force: true })
    }
  }, 60_000)

  test("pauses launches when the server reports no worker slots", async () => {
    const { root, origin, baseCommitSha } = await createSmokeRepo()
    const calls = installSupervisorApi({
      baseCommitSha,
      workerTarget: 1,
      leaseMode: "no_slots",
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
            "worker-command": FAKE_WORKER_COMMAND,
            "presence-interval": "0.1",
            "launch-interval-seconds": "0.01",
            "startup-timeout": "5",
            "heartbeat-sample-interval": "0",
            "first-attempt-warning-seconds": "0",
          },
        })
      )

      const leaseCalls = calls.filter((call) =>
        call.path.endsWith(`/sessions/${SESSION_ID}/worker-leases/batch`)
      )
      expect(leaseCalls).toHaveLength(1)
      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.path ===
              `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
        )
      ).toBe(false)
      expect(await pathExists(join(root, ".git", "onyx", "research.db"))).toBe(
        false
      )
      expect(
        await pathExists(join(root, ".git", "onyx", "outbox.d", "pending"))
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(origin, { recursive: true, force: true })
    }
  }, 60_000)

  test("records failed immutable ref pushes in the worker manifest", async () => {
    const { root, origin, baseCommitSha } = await createSmokeRepo()
    await rm(origin, { recursive: true, force: true })
    const calls = installSupervisorApi({ baseCommitSha, workerTarget: 1 })
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
            "worker-command": FAKE_WORKER_COMMAND,
            "presence-interval": "0.1",
            "launch-interval-seconds": "0.01",
            "startup-timeout": "5",
            "heartbeat-sample-interval": "0",
            "first-attempt-warning-seconds": "0",
            "final-ref-push-timeout": "5",
          },
        })
      )

      const reportCall = calls.find(
        (call) =>
          call.method === "POST" &&
          call.path ===
            `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
      )
      expect(reportCall).toBeDefined()
      expect(reportCall?.body).toMatchObject({
        resultRefPushStatus: "failed",
      })
      const workerLogRoot = join(
        root,
        ".git",
        "onyx",
        "worker-logs",
        SESSION_ID
      )
      const manifests = await Promise.all(
        (await readdir(workerLogRoot))
          .filter((file) => file.endsWith(".manifest.json"))
          .map(
            async (file) =>
              JSON.parse(await readFile(join(workerLogRoot, file), "utf8")) as {
                finalization?: {
                  finalizationStatus?: string
                  error?: string | null
                  workerBranchPushStatus?: string | null
                }
              }
          )
      )
      expect(
        manifests.some(
          (manifest) =>
            manifest.finalization?.finalizationStatus ===
              "measured_and_logged" &&
            manifest.finalization.workerBranchPushStatus === "failed"
        )
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("keeps pushed refs recoverable when API report fails after push", async () => {
    const { root, origin, baseCommitSha } = await createSmokeRepo()
    const calls = installSupervisorApi({
      baseCommitSha,
      workerTarget: 1,
      reportFailure: true,
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
            "worker-command": FAKE_WORKER_COMMAND,
            "presence-interval": "0.1",
            "launch-interval-seconds": "0.01",
            "startup-timeout": "5",
            "heartbeat-sample-interval": "0",
            "first-attempt-warning-seconds": "0",
            "final-ref-push-timeout": "5",
          },
        })
      )

      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.path ===
              `/api/v1/research/campaigns/${CAMPAIGN_ID}/experiments`
        )
      ).toBe(true)
      const refs = await git(
        ["ls-remote", origin, `refs/onyx/experiments/${CAMPAIGN_ID}/*`],
        root
      )
      expect(refs.trim()).not.toBe("")
      const workerLogRoot = join(
        root,
        ".git",
        "onyx",
        "worker-logs",
        SESSION_ID
      )
      const manifests = await Promise.all(
        (await readdir(workerLogRoot))
          .filter((file) => file.endsWith(".manifest.json"))
          .map(
            async (file) =>
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
            manifest.finalization?.finalizationStatus === "failed" &&
            manifest.finalization.error?.includes("experiment log failed")
        )
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(origin, { recursive: true, force: true })
    }
  }, 60_000)
})
