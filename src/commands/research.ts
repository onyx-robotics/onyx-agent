import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { commandExpLog, commandExpRun } from "./exp"
import { requireOption, type Args } from "../lib/args"
import {
  claimCampaignLane,
  createCampaignSession,
  getCampaignBrief,
  getCampaignOverview,
  getResearchSessionState,
  heartbeatCampaignLane,
  heartbeatWorker,
  listProjectCampaigns,
  registerCampaignWorker,
  stopCampaignSession,
  resolveProject,
  upsertCampaignSummary,
  validateCampaignSetup,
  type ApiCampaign,
  type ApiLane,
  type ApiSetup,
} from "../lib/api"
import { emitEvent } from "../lib/events"
import { currentCommit, git, gitResult, repoRoot } from "../lib/git"
import { readHistory } from "../lib/history"
import {
  onyxStateDir,
  readLastRun,
  readOutbox,
  readState,
  writeState,
} from "../lib/outbox"
import { campaignStateKey, resolveProjectPath } from "../lib/project"
import { pathExists, runProcess, type ProcessResult } from "../lib/process"
import { flushOutbox } from "../lib/sync"

function branchName(ref: string) {
  return ref.replace(/^refs\/heads\//, "")
}

function positiveIntegerOption(args: Args, name: string, fallback: number) {
  const raw = args.options[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return value
}

function positiveNumberOption(args: Args, name: string, fallback: number) {
  const raw = args.options[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`)
  }
  return value
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createSyncSupervisor({
  root,
  args,
  intervalMs,
}: {
  root: string
  args: Args
  intervalMs: number
}) {
  let running: Promise<void> | null = null
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const run = () => {
    if (running) return running
    running = flushOutbox(root, args, { quiet: true })
      .then(() => undefined)
      .catch((error) => {
        console.warn(
          `Background sync skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
      .finally(() => {
        running = null
      })
    return running
  }

  timer = setInterval(() => {
    if (!stopped) void run()
  }, intervalMs)

  return {
    request() {
      if (!stopped) void run()
    },
    async drain(timeoutMs: number) {
      stopped = true
      if (timer) clearInterval(timer)
      const deadline = Date.now() + timeoutMs
      do {
        await run()
        const { records } = await readOutbox(root)
        if (records.length === 0) return 0
        await sleep(Math.min(1000, Math.max(0, deadline - Date.now())))
      } while (Date.now() < deadline)
      const { records } = await readOutbox(root)
      return records.length
    },
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}

async function campaignForName(root: string, args: Args) {
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const campaignName =
    args.options.campaign ?? state.activeCampaign ?? args.options.name
  if (!campaignName) {
    throw new Error(
      "Pass --campaign <name> or run `onyx campaign use --name <name>`."
    )
  }

  const project = await resolveProject(root, args)
  const campaigns = await listProjectCampaigns(project.id, args)
  const campaign = campaigns.find(
    (candidate) => candidate.name === campaignName
  )
  if (!campaign) {
    throw new Error(`Campaign ${campaignName} was not found.`)
  }

  const overview = await getCampaignOverview(campaign.id, args)
  const setup = overview.activeSetup
  const key = campaignStateKey(projectPath, campaign.name)
  state.projectId = project.id
  state.projectPath = projectPath
  state.activeCampaign = campaign.name
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    setupId: setup?.id,
    projectPath,
    baseCommitSha: campaign.baseCommitSha,
    description: campaign.description,
    metricName: campaign.metricName,
    metricUnit: campaign.metricUnit,
    metricDirection: campaign.metricDirection,
    promotionRefName: campaign.promotionRefName,
  }
  await writeState(root, state)

  return { projectPath, campaign: overview.campaign, setup, overview }
}

function assertResearchReady(campaign: ApiCampaign, setup: ApiSetup | null) {
  if (
    campaign.phase !== "research" ||
    !setup ||
    setup.status !== "validated" ||
    !setup.baselineExperimentId
  ) {
    throw new Error(
      "Research requires a validated setup with a baseline. Run `onyx setup validate` first."
    )
  }
}

async function writeBrief({
  root,
  campaignId,
  sessionId,
  lane,
  args,
}: {
  root: string
  campaignId: string
  sessionId: string
  lane: ApiLane
  args: Args
}) {
  const brief = await getCampaignBrief(campaignId, args)
  const dir = join(await onyxStateDir(root), "briefs", sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${lane.name}.md`)
  await writeFile(path, `${brief.markdown}\n`, "utf8")
  return path
}

async function writeSessionState({
  root,
  sessionId,
  lane,
  args,
}: {
  root: string
  sessionId: string
  lane: ApiLane
  args: Args
}) {
  const dir = join(await onyxStateDir(root), "session-state", sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${lane.id}.json`)
  const state = await getResearchSessionState(sessionId, args)
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  return path
}

async function ensureWorktree({
  root,
  lane,
  sessionId,
}: {
  root: string
  lane: ApiLane
  sessionId: string
}) {
  const dir = join(
    await onyxStateDir(root),
    "worktrees",
    `${sessionId}-${lane.name}`
  )
  if (!(await pathExists(dir))) {
    await mkdir(join(await onyxStateDir(root), "worktrees"), {
      recursive: true,
    })
    await git(
      [
        "worktree",
        "add",
        "-B",
        branchName(lane.branchRef),
        dir,
        lane.currentCommitSha ?? lane.baseCommitSha,
      ],
      root
    )
  }
  return dir
}

async function commitIfNeeded(worktree: string, lane: ApiLane) {
  const status = await git(["status", "--porcelain"], worktree)
  if (!status.trim()) {
    return { commitSha: await currentCommit(worktree), changed: false }
  }
  await git(["add", "-A"], worktree)
  await git(["commit", "-m", `onyx: ${lane.name} research attempt`], worktree)
  return { commitSha: await currentCommit(worktree), changed: true }
}

function processFailure(result: ProcessResult, label: string) {
  if (result.timedOut) return `${label} timed out`
  if (result.code === 0) return null
  return `${label} failed (${result.code ?? "signal"}): ${
    result.stderr.trim() || result.stdout.trim() || "no output"
  }`
}

function assertProcessSucceeded(result: ProcessResult, label: string) {
  const failure = processFailure(result, label)
  if (failure) throw new Error(failure)
}

async function withWorkerHeartbeat<T>({
  workerId,
  sessionId,
  laneId,
  args,
  phase,
  progressMessage,
  run,
}: {
  workerId: string
  sessionId: string
  laneId: string
  args: Args
  phase: string
  progressMessage: string
  run: () => Promise<T>
}): Promise<T> {
  const timer = setInterval(() => {
    void heartbeatWorker(
      workerId,
      {
        status: "running",
        sessionId,
        laneId,
        phase,
        event: "heartbeat",
        progressMessage,
      },
      args
    ).catch(() => {})
  }, 10_000)

  try {
    return await run()
  } finally {
    clearInterval(timer)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type LaneRunResult = {
  lane: ApiLane
  workerId?: string
  resultCommitSha?: string
  status: "completed" | "failed"
  error?: string
}

async function runLaneOnce({
  root,
  projectPath,
  campaign,
  setup,
  sessionId,
  lane,
  workerCommand,
  agentKind,
  maxIterations,
  endTimeMs,
  workerTimeoutMs,
  syncSupervisor,
  args,
}: {
  root: string
  projectPath: string
  campaign: ApiCampaign
  setup: ApiSetup
  sessionId: string
  lane: ApiLane
  workerCommand: string
  agentKind: string
  maxIterations: number
  endTimeMs: number
  workerTimeoutMs: number
  syncSupervisor: ReturnType<typeof createSyncSupervisor>
  args: Args
}): Promise<LaneRunResult> {
  let workerId: string | undefined
  let claimed: ApiLane | null = null
  let resultCommitSha: string | undefined

  try {
    const worker = await registerCampaignWorker(
      campaign.id,
      {
        sessionId,
        laneId: lane.id,
        workerName: `${lane.name}-${agentKind}`,
        agentKind,
        runtime: "local",
      },
      args
    )
    workerId = worker.id
    claimed = (await claimCampaignLane(lane.id, { workerId: worker.id }, args))
      .lane
    await heartbeatWorker(
      worker.id,
      {
        status: "running",
        sessionId,
        laneId: claimed.id,
        phase: "research",
        event: "lane_claimed",
        progressMessage: `Running ${claimed.name}`,
      },
      args
    )

    const worktree = await ensureWorktree({ root, lane: claimed, sessionId })
    await emitEvent(root, {
      type: "lane_claimed",
      campaignName: campaign.name,
      campaignId: campaign.id,
      setupId: setup.id,
      sessionId,
      workerId: worker.id,
      laneId: lane.id,
      message: lane.name,
    })

    const laneOptions = {
      ...args.options,
      campaign: campaign.name,
      setup: setup.id,
      session: sessionId,
      lane: lane.id,
      worker: worker.id,
      cwd: worktree,
      "project-path": projectPath,
    }
    let noOpAttempts = 0
    let completedAttempts = 0

    for (
      let attempt = 1;
      attempt <= maxIterations && Date.now() < endTimeMs;
      attempt += 1
    ) {
      const [briefPath, sessionStatePath] = await Promise.all([
        writeBrief({
          root,
          campaignId: campaign.id,
          sessionId,
          lane: claimed,
          args,
        }),
        writeSessionState({ root, sessionId, lane: claimed, args }).catch(
          () => null
        ),
      ])

      const workerResult = await withWorkerHeartbeat({
        workerId: worker.id,
        sessionId,
        laneId: lane.id,
        args,
        phase: "research",
        progressMessage: `${claimed.name} attempt ${attempt}`,
        run: () =>
          runProcess("sh", ["-lc", workerCommand], {
            cwd: worktree,
            timeoutMs: workerTimeoutMs,
            env: {
              ...process.env,
              ONYX_CAMPAIGN_ID: campaign.id,
              ONYX_CAMPAIGN_NAME: campaign.name,
              ONYX_SETUP_ID: setup.id,
              ONYX_SESSION_ID: sessionId,
              ONYX_LANE_ID: lane.id,
              ONYX_LANE_NAME: lane.name,
              ONYX_LANE_BRANCH: lane.branchRef,
              ONYX_WORKER_ID: worker.id,
              ONYX_BRIEF_FILE: briefPath,
              ...(sessionStatePath
                ? { ONYX_SESSION_STATE_FILE: sessionStatePath }
                : {}),
            },
          }),
      })
      assertProcessSucceeded(
        workerResult,
        `Worker command for ${lane.name} attempt ${attempt}`
      )

      const commit = await commitIfNeeded(worktree, lane)
      resultCommitSha = commit.commitSha
      if (!commit.changed) {
        noOpAttempts += 1
        await heartbeatWorker(
          worker.id,
          {
            status: "running",
            sessionId,
            laneId: claimed.id,
            phase: "research",
            event: "no_op_attempt",
            progressMessage: `${claimed.name} produced no changes (${noOpAttempts}/2)`,
            gitLabel: resultCommitSha,
          },
          args
        )
        if (noOpAttempts >= 2) break
        continue
      }

      noOpAttempts = 0
      completedAttempts += 1
      await heartbeatCampaignLane(
        lane.id,
        {
          workerId: worker.id,
          currentCommitSha: resultCommitSha,
          status: "claimed",
        },
        args
      )

      const lanePush = await gitResult(
        ["push", "origin", `HEAD:${lane.branchRef}`],
        worktree
      )
      assertProcessSucceeded(lanePush, `Lane branch push for ${lane.name}`)

      await withWorkerHeartbeat({
        workerId: worker.id,
        sessionId,
        laneId: lane.id,
        args,
        phase: "eval",
        progressMessage: `${claimed.name} evaluating attempt ${attempt}`,
        run: async () => {
          await commandExpRun({
            positional: ["exp", "run"],
            options: laneOptions,
          })
          await commandExpLog({
            positional: ["exp", "log"],
            options: {
              ...laneOptions,
              name: `${lane.name}-${resultCommitSha!.slice(0, 7)}`,
              description: `Result from ${lane.name} attempt ${attempt}`,
            },
          })
        },
      })
      process.exitCode = undefined
      syncSupervisor.request()
    }

    await heartbeatCampaignLane(
      lane.id,
      {
        workerId: worker.id,
        currentCommitSha: resultCommitSha,
        status: "completed",
      },
      args
    )
    await heartbeatWorker(
      worker.id,
      {
        status: "stopped",
        sessionId,
        laneId: null,
        phase: "completed",
        event: "lane_completed",
        progressMessage: `${lane.name} completed`,
        gitLabel: resultCommitSha,
      },
      args
    )
    await upsertCampaignSummary(
      campaign.id,
      {
        sessionId,
        laneId: lane.id,
        setupId: setup.id,
        authoredByWorkerId: worker.id,
        summaryKind: "lane_summary",
        title: `${lane.name} latest attempt`,
        body: `Completed attempts: ${completedAttempts}\nLatest commit: ${resultCommitSha ?? "n/a"}`,
      },
      args
    )
    return { lane, workerId: worker.id, resultCommitSha, status: "completed" }
  } catch (error) {
    const message = errorMessage(error)
    if (workerId) {
      await heartbeatWorker(
        workerId,
        {
          status: "stopped",
          sessionId,
          laneId: null,
          phase: "failed",
          event: "lane_failed",
          progressMessage: message.slice(0, 1000),
          gitLabel: resultCommitSha ?? null,
        },
        args
      ).catch(() => {})
    }
    if (workerId && claimed) {
      await heartbeatCampaignLane(
        lane.id,
        {
          workerId,
          status: "lost",
          currentCommitSha: resultCommitSha,
          metadata: { error: message },
        },
        args
      ).catch(() => {})
    }
    await upsertCampaignSummary(
      campaign.id,
      {
        sessionId,
        laneId: lane.id,
        setupId: setup.id,
        authoredByWorkerId: workerId,
        summaryKind: "lane_summary",
        title: `${lane.name} failed`,
        body: message,
      },
      args
    ).catch(() => {})
    return { lane, workerId, resultCommitSha, status: "failed", error: message }
  }
}

export async function commandSetupValidate(args: Args) {
  const root = await repoRoot()
  const { campaign, setup } = await campaignForName(root, args)
  if (!setup) throw new Error("Campaign has no active setup.")
  if (setup.status === "validated" && setup.baselineExperimentId) {
    console.log(`Setup ${setup.id} is already validated.`)
    return
  }

  await commandExpRun({
    positional: ["exp", "run"],
    options: {
      ...args.options,
      campaign: campaign.name,
      setup: setup.id,
    },
  })
  const lastRun = await readLastRun(root)
  await commandExpLog({
    positional: ["exp", "log"],
    options: {
      ...args.options,
      campaign: campaign.name,
      setup: setup.id,
      name: `baseline-${setup.version}`,
      description: `Baseline for setup v${setup.version}`,
    },
  })
  await flushOutbox(root, args)
  const { records } = await readHistory(root)
  const history = records.find((record) => record.runRef === lastRun?.runRef)
  if (!history?.experimentId) {
    throw new Error(
      "Baseline logged locally but was not synced; setup validation requires API sync."
    )
  }
  const result = await validateCampaignSetup(
    setup.id,
    {
      baselineExperimentId: history.experimentId,
    },
    args
  )
  await emitEvent(root, {
    type: "setup_validated",
    campaignName: campaign.name,
    campaignId: campaign.id,
    setupId: setup.id,
    message: `baseline ${history.experimentId}`,
  })
  console.log(`Validated setup v${result.setup.version} for ${campaign.name}`)
}

export async function commandResearchStart(args: Args) {
  const root = await repoRoot()
  const { campaign, setup } = await campaignForName(root, args)
  assertResearchReady(campaign, setup)

  const workerCommand = requireOption(args, "worker-command")
  const agentKind = args.options.agent ?? "codex"
  const workerTarget = positiveIntegerOption(
    args,
    "agents",
    Number(args.options.workers ?? 1)
  )
  const maxIterations = positiveIntegerOption(args, "max-iterations", 10)
  const maxMinutes = positiveNumberOption(args, "max-minutes", 120)
  const workerTimeoutMs =
    positiveNumberOption(args, "worker-timeout", 1800) * 1000
  const syncIntervalMs = positiveNumberOption(args, "sync-interval", 5) * 1000
  const finalSyncTimeoutMs =
    positiveNumberOption(args, "final-sync-timeout", 120) * 1000
  const endTimeMs = Date.now() + maxMinutes * 60_000
  const syncSupervisor = createSyncSupervisor({
    root,
    args,
    intervalMs: syncIntervalMs,
  })
  const result = await createCampaignSession(
    campaign.id,
    {
      name: args.options.name ?? `research-${new Date().toISOString()}`,
      workerTarget,
      metadata: { startedBy: "onyx-research" },
    },
    args
  )
  const state = await readState(root)
  const projectPath = await resolveProjectPath(root, args)
  const key = campaignStateKey(projectPath, campaign.name)
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    setupId: setup!.id,
    sessionId: result.session.id,
  }
  await writeState(root, state)
  await emitEvent(root, {
    type: "research_started",
    campaignName: campaign.name,
    campaignId: campaign.id,
    setupId: setup!.id,
    sessionId: result.session.id,
    message: `${result.lanes.length} lane(s)`,
  })

  const laneResults = await Promise.all(
    result.lanes.map((lane) =>
      runLaneOnce({
        root,
        projectPath,
        campaign,
        setup: setup!,
        sessionId: result.session.id,
        lane,
        workerCommand,
        agentKind,
        maxIterations,
        endTimeMs,
        workerTimeoutMs,
        syncSupervisor,
        args,
      })
    )
  )
  const pendingAfterDrain = await syncSupervisor.drain(finalSyncTimeoutMs)

  const completed = laneResults.filter((lane) => lane.status === "completed")
  const failed = laneResults.filter((lane) => lane.status === "failed")
  const resultLines = laneResults.map((lane) =>
    lane.status === "completed"
      ? `- ${lane.lane.name}: completed at ${lane.resultCommitSha ?? "unknown"}`
      : `- ${lane.lane.name}: failed - ${lane.error ?? "unknown error"}`
  )
  const summaryBody = [
    `Session ${result.session.id}`,
    `Completed lanes: ${completed.length}`,
    `Failed lanes: ${failed.length}`,
    `Pending sync records: ${pendingAfterDrain}`,
    "",
    ...resultLines,
  ].join("\n")

  await upsertCampaignSummary(
    campaign.id,
    {
      sessionId: result.session.id,
      setupId: setup!.id,
      summaryKind: "session_brief",
      title: `${result.session.name} results`,
      body: summaryBody,
    },
    args
  )

  const latestOverview = await getCampaignOverview(campaign.id, args).catch(
    () => null
  )
  const bestLine = latestOverview
    ? `Best metric: ${latestOverview.campaign.bestMetricValue ?? "n/a"} at ${
        latestOverview.campaign.bestCommitSha ?? "n/a"
      }`
    : "Best metric: n/a"
  await upsertCampaignSummary(
    campaign.id,
    {
      setupId: setup!.id,
      summaryKind: "campaign_brief",
      title: `${campaign.name} latest research`,
      body: `${bestLine}\n\n${summaryBody}`,
    },
    args
  )

  await stopCampaignSession(
    result.session.id,
    {
      campaignId: campaign.id,
      reason:
        failed.length > 0 ? `${failed.length} lane(s) failed` : "completed",
      metadata: {
        completed: completed.length,
        failed: failed.length,
        pendingSyncRecords: pendingAfterDrain,
      },
    },
    args
  )

  if (failed.length > 0) {
    throw new Error(
      `Research session ${result.session.id} completed with ${failed.length} failed lane(s).`
    )
  }
  console.log(
    `Research session ${result.session.id} completed ${result.lanes.length} lane(s)`
  )
}

export async function commandResearchStatus(args: Args) {
  const root = await repoRoot()
  const { campaign, setup, overview } = await campaignForName(root, args)
  console.log(`campaign: ${campaign.name}`)
  console.log(`phase: ${campaign.phase}`)
  console.log(
    `setup: ${setup ? `v${setup.version} ${setup.status}` : "(none)"}`
  )
  console.log(`lanes: ${overview.lanes.length}`)
  for (const lane of overview.lanes) {
    console.log(
      `  ${lane.name}: ${lane.status} branch=${lane.branchRef} best=${lane.bestMetricValue ?? "-"}`
    )
  }
  console.log(`workers: ${overview.workers.length}`)
}

export async function commandWorkerRun(args: Args) {
  return commandResearchStart(args)
}
