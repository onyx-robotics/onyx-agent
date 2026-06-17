import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { commandExpLog, commandExpRun } from "./exp"
import { requireOption, type Args } from "../lib/args"
import {
  claimCampaignLane,
  createCampaignSession,
  getCampaignBrief,
  getCampaignTimeline,
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
import { onyxStateDir, readLastRun, readState, writeState } from "../lib/outbox"
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

async function campaignForName(root: string, args: Args) {
  await flushOutbox(root, args, { quiet: true }).catch(() => {})
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

  const timeline = await getCampaignTimeline(campaign.id, args)
  const setup = timeline.activeSetup
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

  return { projectPath, campaign, setup, timeline }
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
  if (!status.trim()) return await currentCommit(worktree)
  await git(["add", "-A"], worktree)
  await git(["commit", "-m", `onyx: ${lane.name} research attempt`], worktree)
  return currentCommit(worktree)
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

    const briefPath = await writeBrief({
      root,
      campaignId: campaign.id,
      sessionId,
      lane: claimed,
      args,
    })
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

    const workerResult = await runProcess("sh", ["-lc", workerCommand], {
      cwd: worktree,
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
      },
    })
    assertProcessSucceeded(workerResult, `Worker command for ${lane.name}`)

    resultCommitSha = await commitIfNeeded(worktree, lane)
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
    await commandExpRun({
      positional: ["exp", "run"],
      options: laneOptions,
    })
    await commandExpLog({
      positional: ["exp", "log"],
      options: {
        ...laneOptions,
        name: `${lane.name}-${resultCommitSha.slice(0, 7)}`,
        description: `Result from ${lane.name}`,
      },
    })
    process.exitCode = undefined

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
        body: `Latest commit: ${resultCommitSha}`,
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
        args,
      })
    )
  )

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

  const latestTimeline = await getCampaignTimeline(campaign.id, args).catch(
    () => null
  )
  const bestLine = latestTimeline
    ? `Best metric: ${latestTimeline.campaign.bestMetricValue ?? "n/a"} at ${
        latestTimeline.campaign.bestCommitSha ?? "n/a"
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
  const { campaign, setup, timeline } = await campaignForName(root, args)
  console.log(`campaign: ${campaign.name}`)
  console.log(`phase: ${campaign.phase}`)
  console.log(
    `setup: ${setup ? `v${setup.version} ${setup.status}` : "(none)"}`
  )
  console.log(`lanes: ${timeline.lanes.length}`)
  for (const lane of timeline.lanes) {
    console.log(
      `  ${lane.name}: ${lane.status} branch=${lane.branchRef} best=${lane.bestMetricValue ?? "-"}`
    )
  }
  console.log(`workers: ${timeline.workers.length}`)
}

export async function commandWorkerRun(args: Args) {
  return commandResearchStart(args)
}
