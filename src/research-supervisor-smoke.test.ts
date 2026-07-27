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

import { commandResearchRun, commandResearchStatus } from "./commands/research"
import { setupHash, type ResearchSetupFile } from "./lib/contract"
import { currentCommit, git } from "./lib/git"
import { writeState } from "./lib/runtime-state"
import { campaignStateKey } from "./lib/project"

const PROJECT_ID = "10000000-0000-4000-8000-000000000001"
const CAMPAIGN_ID = "20000000-0000-4000-8000-000000000001"
const SESSION_ID = "30000000-0000-4000-8000-000000000001"
const HYPOTHESIS_ID = "40000000-0000-4000-8000-000000000001"
const SITE_ID = "50000000-0000-4000-8000-000000000001"
const ASSIGNMENT_ID = "55000000-0000-4000-8000-000000000001"
const EVALUATION_REVISION_ID = "56000000-0000-4000-8000-000000000001"

let previousApiUrl: string | undefined
let previousApiKey: string | undefined
let previousFetch: typeof fetch | null = null

type ApiCall = { method: string; path: string; body: unknown }

const FAKE_WORKER_COMMAND = [
  '"$ONYX_WORKER_BIN" exp run --campaign "$ONYX_CAMPAIGN_NAME" --auto',
  "printf 'result\\n' > src/result.txt",
  "git add src/result.txt",
  "git commit -m 'fake worker result'",
  '"$ONYX_WORKER_BIN" exp run --resume --auto',
  '"$ONYX_WORKER_BIN" exp log',
].join(" && ")

function nowIso() {
  return new Date().toISOString()
}

async function pathExists(path: string) {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

function requireExperimentReport(calls: ApiCall[]) {
  const report = calls.find(
    (call) =>
      call.method === "POST" &&
      call.path === "/api/v1/research/worker/experiments"
  )
  if (report) return report
  const diagnostics = calls.filter((call) => call.path.includes("heartbeat"))
  throw new Error(
    `Expected an experiment report. Worker diagnostics: ${JSON.stringify(diagnostics)}`
  )
}

async function withMutedConsole<T>(fn: () => Promise<T>) {
  if (process.env.ONYX_TEST_DEBUG === "1") return fn()
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

async function captureConsole(fn: () => Promise<void>) {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => lines.push(values.join(" "))
  try {
    await fn()
  } finally {
    console.log = originalLog
  }
  return lines.join("\n")
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
        fingerprintPaths: ["onyx/tools/evaluation"],
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
    outcome: {
      status,
      endedAt: status === "completed" ? nowIso() : null,
      endReason: status === "completed" ? "experiment_target_reached" : null,
    },
    cleanup: {
      status: status === "completed" ? "complete" : "running",
      startedAt: status === "completed" ? nowIso() : null,
      completedAt: status === "completed" ? nowIso() : null,
      summary: {},
    },
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
  terminalOnWorkerExit = true,
}: {
  baseCommitSha: string
  workerTarget: number
  reportDisposition?: "received" | "accepted" | "discarded"
  leaseMode?: "normal" | "no_slots"
  reportFailure?: boolean
  terminalOnWorkerExit?: boolean
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
  const workerIdsByCredential = new Map<string, string>()
  const currentCampaign = campaign(baseCommitSha)
  const currentHypothesis = hypothesis(baseCommitSha)
  const currentAssignment = {
    id: ASSIGNMENT_ID,
    sessionId: SESSION_ID,
    campaignId: CAMPAIGN_ID,
    hypothesisId: HYPOTHESIS_ID,
    startingCommitSha: baseCommitSha,
    sourceExperimentId: null,
    setupHash: "smoke-setup-hash",
    evaluationFingerprint: "smoke-evaluation-fingerprint",
    gitStatus: "local_reported",
    gitVerifiedAt: null,
    gitStatusReason: null,
    canceledAt: null,
    cancellationReason: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

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
    Object.assign(runningSession, {
      baseCommitSha,
      setupHash: currentAssignment.setupHash,
      evaluationRevisionId: EVALUATION_REVISION_ID,
      assignments: [currentAssignment],
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
        campaignStatus: "active",
        runtimeState: terminal ? "ended" : "active",
        status: runningSession.status,
        outcome: runningSession.outcome,
        progress: {
          experimentTarget: 1,
          acceptedExperimentCount,
          receivedExperimentCount,
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
        canceledAssignmentIds: [],
        cleanup: runningSession.cleanup,
        updatedAt: nowIso(),
      }
    } else if (
      method === "POST" &&
      url.pathname ===
        `/api/v1/research/sessions/${SESSION_ID}/settlement-tick`
    ) {
      if (receivedExperimentCount > 0) {
        acceptedExperimentCount = 1
        terminal = true
      }
      data = {
        sessionId: SESSION_ID,
        campaignStatus: "active",
        runtimeState: terminal ? "ended" : "active",
        status: terminal ? "completed" : "running",
        outcome: {
          status: terminal ? "completed" : "running",
          endedAt: terminal ? nowIso() : null,
          endReason: terminal ? "experiment_target_reached" : null,
        },
        progress: {
          experimentTarget: 1,
          acceptedExperimentCount,
          receivedExperimentCount,
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
        cleanup: runningSession.cleanup,
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
          context: {
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
          },
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
          (requested: {
            workerRef: string
            workerName: string
            leaseCredential: string
          }) => {
            workerSequence += 1
            const workerId = `60000000-0000-4000-8000-${String(workerSequence).padStart(12, "0")}`
            leasedWorkers.push(workerId)
            workerIdsByCredential.set(requested.leaseCredential, workerId)
            return {
              workerRef: requested.workerRef,
              worker: {
                ...worker(workerId, "registered"),
                workerName: requested.workerName,
                workerRef: requested.workerRef,
              },
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              assignment: currentAssignment,
              hypothesis: currentHypothesis,
              existing: false,
            }
          }
        )
        data = {
          context: {
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
          },
          grants,
          unavailable: [],
          capacity: {
            workerTarget,
            occupied: leasedWorkers.length,
            requested: body?.workers?.length ?? 0,
            granted: grants.length,
            existing: 0,
            openSlots: Math.max(0, workerTarget - leasedWorkers.length),
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
      workerIdsByCredential.set(body.leaseCredential, workerId)
      data = {
        worker: worker(workerId, "registered"),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        assignment: currentAssignment,
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
      url.pathname === "/api/v1/research/worker/heartbeat"
    ) {
      const headers = new Headers(init?.headers)
      const credential = headers.get("authorization")?.replace(/^Bearer /, "")
      const workerId =
        (credential && workerIdsByCredential.get(credential)) ??
        leasedWorkers[0]!
      if (
        body?.status === "completed" ||
        body?.status === "failed" ||
        body?.status === "stopped"
      ) {
        const index = leasedWorkers.indexOf(workerId)
        if (index >= 0) leasedWorkers.splice(index, 1)
        if (terminalOnWorkerExit) terminal = true
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
          evaluationRevisionId: EVALUATION_REVISION_ID,
          assignmentId: ASSIGNMENT_ID,
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
      for (const heartbeat of body?.heartbeats ?? []) {
        if (
          heartbeat.status === "completed" ||
          heartbeat.status === "failed" ||
          heartbeat.status === "stopped"
        ) {
          const index = leasedWorkers.indexOf(heartbeat.workerId)
          if (index >= 0) leasedWorkers.splice(index, 1)
          if (terminalOnWorkerExit) terminal = true
        }
      }
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
      url.pathname === "/api/v1/research/worker/experiments"
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
          evaluationRevisionId: EVALUATION_REVISION_ID,
          assignmentId: ASSIGNMENT_ID,
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
        cleanup: {
          status: "complete",
          reasons: [],
          terminalReason: "experiment_target_reached",
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
        requireExperimentReport(calls)
        const controlCalls = calls.filter(
          (call) =>
            call.path ===
              `/api/v1/research/sessions/${SESSION_ID}/control-state` ||
            call.path ===
              `/api/v1/research/sessions/${SESSION_ID}/settlement-tick`
        )
        expect(controlCalls.length).toBeLessThan(12)
        expect(
          await pathExists(
            join(
              root,
              ".git",
              "onyx",
              "worker-runtime",
              SESSION_ID,
              "supervisor-control-state.json"
            )
          )
        ).toBe(true)
        expect(
          (
            await git(
              ["for-each-ref", "--format=%(refname)", "refs/heads/onyx"],
              root
            )
          ).trim()
        ).toBe("")
        expect(
          await pathExists(join(root, ".git", "onyx", "worktrees", SESSION_ID))
        ).toBe(false)
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

  test(
    "renders a bounded summary status without full campaign detail",
    async () => {
      const { root, origin, baseCommitSha } = await createSmokeRepo()
      installSupervisorApi({ baseCommitSha, workerTarget: 1 })
      try {
        await withMutedConsole(() =>
          commandResearchRun({
            positional: ["research", "run"],
            options: {
              cwd: root,
              campaign: "smoke",
              workers: "1",
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
        const output = await captureConsole(() =>
          commandResearchStatus({
            positional: ["research", "status"],
            options: {
              cwd: root,
              campaign: "smoke",
              summary: "true",
              json: "true",
            },
          })
        )
        const summary = JSON.parse(output) as Record<string, unknown>
        expect(summary).toHaveProperty("campaign")
        expect(summary).toHaveProperty("session")
        expect(summary).toHaveProperty("campaign.status", "active")
        expect(summary).toHaveProperty("session.outcome")
        expect(summary).toHaveProperty("session.cleanup")
        expect(summary).not.toHaveProperty("hypotheses")
        expect(summary).not.toHaveProperty("workers")
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(origin, { recursive: true, force: true })
      }
    },
    60_000
  )

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
          },
        })
      )

      const manifestFiles = calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path === "/api/v1/research/worker/experiments"
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
                teardown?: {
                  attemptDelivery?: string
                  resultRefPushStatus?: string
                  error?: string | null
                }
              }
          )
      )
      expect(
        manifests.some(
          (manifest) => manifest.teardown?.attemptDelivery === "delivered"
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
              "/api/v1/research/worker/experiments"
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

  test("stops a session after a bounded streak of no-progress worker exits", async () => {
    const { root, origin, baseCommitSha } = await createSmokeRepo()
    const calls = installSupervisorApi({
      baseCommitSha,
      workerTarget: 1,
      terminalOnWorkerExit: false,
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
            "worker-command": "true",
            "presence-interval": "0.1",
            "launch-interval-seconds": "0.01",
            "startup-timeout": "5",
            "heartbeat-sample-interval": "0",
            "first-attempt-warning-seconds": "0",
          },
        })
      )

      const breakerStop = calls.find(
        (call) =>
          call.method === "POST" &&
          call.path === `/api/v1/research/sessions/${SESSION_ID}/stop` &&
          (call.body as { metadata?: { reasonCode?: string } }).metadata
            ?.reasonCode === "worker_no_progress_breaker"
      )
      expect(breakerStop?.body).toMatchObject({
        endReason: "failed",
        metadata: {
          threshold: 3,
          count: 3,
        },
      })
      expect(
        (
          await git(
            ["for-each-ref", "--format=%(refname)", "refs/heads/onyx"],
            root
          )
        ).trim()
      ).toBe("")
      expect(
        await pathExists(join(root, ".git", "onyx", "worktrees", SESSION_ID))
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
          },
        })
      )

      const reportCall = calls.find(
        (call) =>
          call.method === "POST" &&
          call.path === "/api/v1/research/worker/experiments"
      )
      expect(reportCall).toBeDefined()
      expect(reportCall?.body).toMatchObject({
        resultRefPushStatus: "failed",
      })
      expect(
        await pathExists(join(root, ".git", "onyx", "worktrees", SESSION_ID))
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("drops local delivery state when API report fails after push", async () => {
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
          },
        })
      )

      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.path ===
              "/api/v1/research/worker/experiments"
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
                teardown?: {
                  attemptDelivery?: string
                  error?: string | null
                }
              }
          )
      )
      expect(
        manifests.some(
          (manifest) =>
            manifest.teardown?.attemptDelivery === "failed" &&
            manifest.teardown.error?.includes("API reporting failed")
        )
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(origin, { recursive: true, force: true })
    }
  }, 60_000)
})
