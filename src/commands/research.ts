import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { researchLanePlanSchema } from "../protocol"
import type { Args } from "../lib/args"
import {
  claimCampaignLane,
  createCampaignSession,
  getCampaignBrief,
  getCampaignOverview,
  getResearchSessionState,
  heartbeatCampaignLane,
  heartbeatWorker,
  createCampaignKnowledge,
  listProjectCampaigns,
  registerCampaignWorker,
  stopCampaignSession,
  resolveProject,
  upsertCampaignSummary,
  type ApiCampaign,
  type ApiLane,
} from "../lib/api"
import {
  readSetupFile,
  readValidationFile,
  requiredSetupModules,
  setupPath,
  validationPath,
  type ResearchSetupFile,
} from "../lib/contract"
import { emitEvent } from "../lib/events"
import { currentCommit, git, gitResult, repoRoot } from "../lib/git"
import {
  onyxStateDir,
  readOutbox,
  readState,
  writeState,
} from "../lib/outbox"
import { campaignStateKey, onyxPath, resolveProjectPath } from "../lib/project"
import { pathExists, runProcess, type ProcessResult } from "../lib/process"
import { flushOutbox } from "../lib/sync"
import { protectedToolPaths } from "../lib/tools"
import { renderLaneWorkerPrompt } from "../lib/worker-prompt"

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

async function lanePlansOption(args: Args) {
  const path = args.options["lane-plans"]
  if (!path) return undefined
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!Array.isArray(parsed)) {
    throw new Error("--lane-plans must point to a JSON array")
  }
  return parsed.map((plan) => researchLanePlanSchema.parse(plan))
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
  const key = campaignStateKey(projectPath, campaign.name)
  state.projectId = project.id
  state.projectPath = projectPath
  state.activeCampaign = campaign.name
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    projectPath,
    baseCommitSha: campaign.baseCommitSha,
    description: campaign.description,
    metricName: campaign.metricName,
    metricUnit: campaign.metricUnit,
    metricDirection: campaign.metricDirection,
    promotionRefName: campaign.promotionRefName,
  }
  await writeState(root, state)

  return { projectPath, campaign: overview.campaign, overview }
}

async function assertLocalSetupReady(root: string, projectPath: string) {
  const setup = await readSetupFile(root, projectPath)
  const cheapFailures = await recheckCheapRequiredSetupModules({
    root,
    projectPath,
    setup,
  })
  if (cheapFailures.length > 0) {
    throw new Error(
      `Required setup module(s) failed local preflight: ${cheapFailures.join("; ")}. Run \`onyx setup validate --required\`.`
    )
  }

  const validation = await readValidationFile(root, projectPath)
  if (!validation) {
    throw new Error(
      "Missing onyx/validation.json. Run `onyx setup validate` before starting research."
    )
  }
  const byModule = new Map(
    validation.modules.map((module) => [module.moduleId, module])
  )
  const failing = requiredSetupModules(setup).filter(
    (moduleId) => byModule.get(moduleId)?.status !== "passed"
  )
  if (failing.length > 0) {
    throw new Error(
      `Required setup module(s) are not passing: ${failing.join(", ")}. Run \`onyx setup validate --required\`.`
    )
  }
  return { setup, validation }
}

async function recheckCheapRequiredSetupModules({
  root,
  projectPath,
  setup,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
}) {
  const required = new Set(requiredSetupModules(setup))
  const failures: string[] = []

  if (required.has("project_scope") && setup.projectPath !== projectPath) {
    failures.push(
      `project_scope expected projectPath "${projectPath}" but setup has "${setup.projectPath}"`
    )
  }

  if (required.has("metric") && setup.metric.name.trim().length === 0) {
    failures.push("metric is missing")
  }

  if (
    required.has("evaluation_definition") &&
    setup.commands.evaluate.command.trim().length === 0
  ) {
    failures.push("evaluation_definition is missing")
  }

  if (required.has("agent_handoff")) {
    const instructionsPath = onyxPath(root, projectPath, "onyx.md")
    if (!(await pathExists(instructionsPath))) {
      failures.push("agent_handoff is missing onyx/onyx.md")
    } else {
      const instructions = await readFile(instructionsPath, "utf8")
      if (instructions.trim().length < 20) {
        failures.push("agent_handoff has too little guidance in onyx/onyx.md")
      }
    }
  }

  return failures
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

async function writeWorkerPrompt({
  root,
  projectPath,
  campaign,
  setup,
  sessionId,
  lane,
  briefPath,
  sessionStatePath,
  maxIterations,
  endTimeMs,
}: {
  root: string
  projectPath: string
  campaign: ApiCampaign
  setup: ResearchSetupFile
  sessionId: string
  lane: ApiLane
  briefPath: string
  sessionStatePath: string | null
  maxIterations: number
  endTimeMs: number
}) {
  const dir = join(await onyxStateDir(root), "worker-prompts", sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${lane.name}.md`)
  const protectedPaths = await protectedToolPaths(root, projectPath)
  const minutesRemaining = Math.max(
    0,
    Math.ceil((endTimeMs - Date.now()) / 60_000)
  )
  const markdown = renderLaneWorkerPrompt({
    briefPath,
    campaignName: campaign.name,
    goal: setup.goal ?? campaign.description ?? "not specified",
    laneBranch: lane.branchRef,
    laneId: lane.id,
    laneName: lane.name,
    lanePlan: lane.plan,
    maxIterations,
    metricLabel: `${campaign.metricName}${campaign.metricUnit ? ` (${campaign.metricUnit})` : ""}, ${campaign.metricDirection}`,
    minutesRemaining,
    protectedPaths,
    setupFilePath: setupPath(root, projectPath),
    validationFilePath: validationPath(root, projectPath),
    researchSpecPath: projectPath
      ? `${projectPath}/onyx/onyx.md`
      : "onyx/onyx.md",
    sessionId,
    sessionStatePath,
  })

  await writeFile(path, `${markdown}\n`, "utf8")
  return { path, markdown }
}

function buildWorkerInvocation({
  agentKind,
  workerCommand,
  worktree,
  prompt,
}: {
  agentKind: string
  workerCommand?: string
  worktree: string
  prompt: string
}): {
  command: string
  args: string[]
  stdin?: string
} {
  if (workerCommand) {
    return { command: "sh", args: ["-lc", workerCommand] }
  }

  if (agentKind === "claude") {
    return {
      command: "claude",
      args: ["-p", "--permission-mode", "auto", "--add-dir", worktree, prompt],
    }
  }

  if (agentKind !== "codex") {
    throw new Error(
      `Unknown --agent ${agentKind}. Use codex, claude, or pass --worker-command.`
    )
  }

  return {
    command: "codex",
    args: [
      "exec",
      "--cd",
      worktree,
      "--search",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "-",
    ],
    stdin: prompt,
  }
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
  setup: ResearchSetupFile
  sessionId: string
  lane: ApiLane
  workerCommand?: string
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
      sessionId,
      workerId: worker.id,
      laneId: lane.id,
      message: lane.name,
    })

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
    const prompt = await writeWorkerPrompt({
      root,
      projectPath,
      campaign,
      setup,
      sessionId,
      lane: claimed,
      briefPath,
      sessionStatePath,
      maxIterations,
      endTimeMs,
    })
    const invocation = buildWorkerInvocation({
      agentKind,
      workerCommand,
      worktree,
      prompt: prompt.markdown,
    })
    const workerResult = await withWorkerHeartbeat({
      workerId: worker.id,
      sessionId,
      laneId: lane.id,
      args,
      phase: "research",
      progressMessage: `${claimed.name} worker running`,
      run: () =>
        runProcess(invocation.command, invocation.args, {
          cwd: worktree,
          timeoutMs: Math.max(
            1,
            Math.min(workerTimeoutMs, endTimeMs - Date.now())
          ),
          stdin: invocation.stdin,
          env: {
            ...process.env,
            ONYX_CAMPAIGN_ID: campaign.id,
            ONYX_CAMPAIGN_NAME: campaign.name,
            ONYX_SESSION_ID: sessionId,
            ONYX_LANE_ID: lane.id,
            ONYX_LANE_NAME: lane.name,
            ONYX_LANE_BRANCH: lane.branchRef,
            ONYX_WORKER_ID: worker.id,
            ONYX_BRIEF_FILE: briefPath,
            ONYX_WORKER_PROMPT_FILE: prompt.path,
            ONYX_SETUP_FILE: setupPath(root, projectPath),
            ONYX_VALIDATION_FILE: validationPath(root, projectPath),
            ...(sessionStatePath
              ? { ONYX_SESSION_STATE_FILE: sessionStatePath }
              : {}),
          },
        }),
    })
    assertProcessSucceeded(workerResult, `Worker process for ${lane.name}`)

    const commit = await commitIfNeeded(worktree, lane)
    resultCommitSha = commit.commitSha
    await heartbeatCampaignLane(
      lane.id,
      {
        workerId: worker.id,
        currentCommitSha: resultCommitSha,
        status: "completed",
      },
      args
    )

    const lanePush = await gitResult(
      ["push", "origin", `HEAD:${lane.branchRef}`],
      worktree
    )
    assertProcessSucceeded(lanePush, `Lane branch push for ${lane.name}`)
    syncSupervisor.request()

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
        authoredByWorkerId: worker.id,
        summaryKind: "lane_summary",
        title: `${lane.name} completed`,
        body: [
          `Worker process exited successfully.`,
          `Latest commit: ${resultCommitSha ?? "n/a"}`,
          workerResult.stdout.trim()
            ? `\nWorker output:\n${workerResult.stdout.trim().slice(-4000)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
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

export async function commandResearchStart(args: Args) {
  const root = await repoRoot()
  const { campaign, projectPath } = await campaignForName(root, args)
  const { setup } = await assertLocalSetupReady(root, projectPath)

  const workerTarget = positiveIntegerOption(
    args,
    "agents",
    Number(args.options.workers ?? 1)
  )
  const maxIterations = positiveIntegerOption(args, "max-iterations", 10)
  const maxMinutes = positiveNumberOption(args, "max-minutes", 120)
  const endTimeMs = Date.now() + maxMinutes * 60_000
  const lanePlans = await lanePlansOption(args)
  const result = await createCampaignSession(
    campaign.id,
    {
      name: args.options.name ?? `research-${new Date().toISOString()}`,
      workerTarget: lanePlans?.length ?? workerTarget,
      lanePlans,
      metadata: {
        startedBy: "onyx-research",
        maxIterations,
        maxMinutes,
      },
    },
    args
  )
  const state = await readState(root)
  const key = campaignStateKey(projectPath, campaign.name)
  state.campaigns = state.campaigns ?? {}
  state.campaigns[key] = {
    ...state.campaigns[key],
    campaignId: campaign.id,
    sessionId: result.session.id,
  }
  state.sessions = state.sessions ?? {}
  state.sessions[result.session.id] = {
    campaignName: campaign.name,
    campaignId: campaign.id,
    endTimeMs,
    maxIterations,
    status: "running",
  }
  await writeState(root, state)
  await emitEvent(root, {
    type: "research_started",
    campaignName: campaign.name,
    campaignId: campaign.id,
    sessionId: result.session.id,
    message: `${result.lanes.length} lane(s)`,
  })

  await Promise.all(
    result.lanes.map(async (lane) => {
      const [briefPath, sessionStatePath] = await Promise.all([
        writeBrief({
          root,
          campaignId: campaign.id,
          sessionId: result.session.id,
          lane,
          args,
        }),
        writeSessionState({
          root,
          sessionId: result.session.id,
          lane,
          args,
        }).catch(() => null),
      ])
      await writeWorkerPrompt({
        root,
        projectPath,
        campaign,
        setup,
        sessionId: result.session.id,
        lane,
        briefPath,
        sessionStatePath,
        maxIterations,
        endTimeMs,
      })
    })
  )

  console.log(`Research session: ${result.session.id}`)
  console.log(`Campaign: ${campaign.name}`)
  console.log(`Lanes: ${result.lanes.length}`)
  for (const lane of result.lanes) {
    console.log(
      `- ${lane.name}: ${lane.plan.focus}\n  onyx worker run --session ${result.session.id} --lane ${lane.id}`
    )
  }
  console.log("Use `onyx listen` or `onyx research status` to supervise.")
}

export async function commandResearchStatus(args: Args) {
  const root = await repoRoot()
  const { campaign, overview } = await campaignForName(root, args)
  const state = await readState(root)
  console.log(`campaign: ${campaign.name}`)
  console.log(`setup: local onyx/setup.json`)
  const activeSessionId =
    state.campaigns?.[
      campaignStateKey(await resolveProjectPath(root, args), campaign.name)
    ]?.sessionId
  if (activeSessionId) {
    console.log(
      `session: ${activeSessionId} ${state.sessions?.[activeSessionId]?.status ?? ""}`.trim()
    )
  }
  console.log(`lanes: ${overview.lanes.length}`)
  for (const lane of overview.lanes) {
    console.log(
      `  ${lane.name}: ${lane.status} branch=${lane.branchRef} best=${lane.bestMetricValue ?? "-"}`
    )
  }
  console.log(`workers: ${overview.workers.length}`)
}

function activeSessionIdFromState({
  state,
  projectPath,
  campaignName,
}: {
  state: Awaited<ReturnType<typeof readState>>
  projectPath: string
  campaignName?: string
}) {
  if (campaignName) {
    return state.campaigns?.[campaignStateKey(projectPath, campaignName)]
      ?.sessionId
  }
  if (state.activeCampaign) {
    return state.campaigns?.[
      campaignStateKey(projectPath, state.activeCampaign)
    ]?.sessionId
  }
  return undefined
}

export async function commandResearchShouldStop(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    process.env.ONYX_SESSION_ID ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: args.options.campaign,
    })
  if (!sessionId) {
    console.log("continue: no active session")
    process.exitCode = 1
    return
  }

  const localSession = state.sessions?.[sessionId]
  const iteration =
    args.options.iteration === undefined ? null : Number(args.options.iteration)
  const reasons: string[] = []
  if (localSession?.stopRequested) reasons.push("stop requested")
  if (localSession?.endTimeMs && Date.now() >= localSession.endTimeMs) {
    reasons.push("time budget reached")
  }
  if (
    iteration !== null &&
    Number.isFinite(iteration) &&
    localSession?.maxIterations &&
    iteration > localSession.maxIterations
  ) {
    reasons.push("iteration budget reached")
  }

  try {
    const remote = await getResearchSessionState(sessionId, args)
    if (
      remote.session.status === "stop_requested" ||
      remote.session.status === "stopped" ||
      remote.session.status === "completed" ||
      remote.session.status === "failed"
    ) {
      reasons.push(`remote session ${remote.session.status}`)
    }
  } catch {
    // Local state is enough for offline stop checks.
  }

  const shouldStop = reasons.length > 0
  if (args.options.json === "true") {
    console.log(JSON.stringify({ shouldStop, sessionId, reasons }, null, 2))
  } else {
    console.log(
      shouldStop
        ? `stop: ${reasons.join(", ")}`
        : `continue: session ${sessionId}`
    )
  }
  process.exitCode = shouldStop ? 0 : 1
}

export async function commandResearchStop(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: args.options.campaign,
    })
  if (!sessionId) {
    throw new Error("Pass --session <id> or start a research session first.")
  }

  const campaignId =
    state.sessions?.[sessionId]?.campaignId ??
    (args.options.campaign
      ? (await campaignForName(root, args)).campaign.id
      : undefined)
  state.sessions = state.sessions ?? {}
  state.sessions[sessionId] = {
    ...(state.sessions[sessionId] ?? {}),
    campaignId,
    stopRequested: true,
    status: "stop_requested",
  }
  await writeState(root, state)

  if (campaignId) {
    await stopCampaignSession(
      sessionId,
      {
        campaignId,
        status: "stop_requested",
        reason: args.options.reason ?? "stop requested",
      },
      args
    ).catch((error) => {
      console.warn(
        `Remote stop request skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  }
  await emitEvent(root, {
    type: "session_stopped",
    campaignId,
    sessionId,
    message: "stop requested",
  })
  console.log(`Stop requested for research session ${sessionId}`)
}

function safeBranchSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^\/+|\/+$/g, "")
}

export async function commandResearchFinish(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign, overview } = await campaignForName(root, args)
  await flushOutbox(root, args, { quiet: true }).catch(() => {})

  const branches: string[] = []
  const campaignSegment = safeBranchSegment(campaign.name)
  if (overview.campaign.bestCommitSha) {
    const bestBranch = `onyx/${campaignSegment}/best`
    await git(
      ["branch", "-f", bestBranch, overview.campaign.bestCommitSha],
      root
    )
    branches.push(`${bestBranch} -> ${overview.campaign.bestCommitSha}`)
  }

  const state = await readState(root)
  const projectPath = await resolveProjectPath(root, args)
  const sessionId =
    args.options.session ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: campaign.name,
    })
  const body = [
    `Finalized campaign ${campaign.name}.`,
    `Best metric: ${overview.campaign.bestMetricValue ?? "n/a"}`,
    `Best commit: ${overview.campaign.bestCommitSha ?? "n/a"}`,
    "Lane refs are not promoted from mutable lane heads; use verified experiment best projections for curated outputs.",
    "",
    "Local branches:",
    ...(branches.length > 0
      ? branches.map((branch) => `- ${branch}`)
      : ["- none"]),
  ].join("\n")
  await upsertCampaignSummary(
    campaign.id,
    {
      sessionId,
      summaryKind: "campaign_brief",
      title: `${campaign.name} final results`,
      body,
    },
    args
  ).catch(() => {})
  if (sessionId) {
    await stopCampaignSession(
      sessionId,
      {
        campaignId: campaign.id,
        status: "completed",
        reason: "finalized",
      },
      args
    ).catch(() => {})
  }
  console.log(body)
}

export async function commandSummaryUpsert(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const kind = args.options.kind ?? "lane_summary"
  if (
    kind !== "campaign_brief" &&
    kind !== "session_brief" &&
    kind !== "lane_summary" &&
    kind !== "transfer_brief" &&
    kind !== "setup_notes"
  ) {
    throw new Error(
      "--kind must be campaign_brief, session_brief, lane_summary, transfer_brief, or setup_notes"
    )
  }
  const title = args.options.title ?? `${kind} ${new Date().toISOString()}`
  const body = args.options.body
  if (!body) throw new Error("Pass --body <text>.")
  await upsertCampaignSummary(
    campaign.id,
    {
      sessionId: args.options.session ?? process.env.ONYX_SESSION_ID,
      laneId: args.options.lane ?? process.env.ONYX_LANE_ID,
      authoredByWorkerId:
        args.options.worker ?? process.env.ONYX_WORKER_ID ?? undefined,
      summaryKind: kind,
      title,
      body,
    },
    args
  )
  console.log(`Updated ${kind} for ${campaign.name}`)
}

export async function commandKnowledgeAdd(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const { campaign } = await campaignForName(root, args)
  const kind = args.options.kind ?? "insight"
  if (
    kind !== "insight" &&
    kind !== "dead_end" &&
    kind !== "promising_direction" &&
    kind !== "risk" &&
    kind !== "transfer_note"
  ) {
    throw new Error(
      "--kind must be insight, dead_end, promising_direction, risk, or transfer_note"
    )
  }
  const title = args.options.title
  const body = args.options.body
  if (!title) throw new Error("Pass --title <text>.")
  if (!body) throw new Error("Pass --body <text>.")

  await createCampaignKnowledge(
    campaign.id,
    {
      sessionId: args.options.session ?? process.env.ONYX_SESSION_ID,
      laneId: args.options.lane ?? process.env.ONYX_LANE_ID,
      authoredByWorkerId:
        args.options.worker ?? process.env.ONYX_WORKER_ID ?? undefined,
      kind,
      title,
      body,
      confidence:
        args.options.confidence === undefined
          ? undefined
          : Number(args.options.confidence),
    },
    args
  )
  console.log(`Added ${kind} knowledge for ${campaign.name}`)
}

export async function commandWorkerRun(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const sessionId =
    args.options.session ??
    process.env.ONYX_SESSION_ID ??
    activeSessionIdFromState({
      state,
      projectPath,
      campaignName: args.options.campaign,
    })
  if (!sessionId) {
    throw new Error("Pass --session <id> or start a research session first.")
  }

  const sessionState = await getResearchSessionState(sessionId, args)
  const campaign = sessionState.campaign
  const { setup } = await assertLocalSetupReady(root, projectPath)

  const requestedLaneId = args.options.lane ?? process.env.ONYX_LANE_ID
  const lane =
    (requestedLaneId
      ? sessionState.lanes.find((item) => item.id === requestedLaneId)
      : sessionState.lanes.find((item) =>
          ["active", "stale", "lost"].includes(item.status)
        )) ?? null
  if (!lane) {
    throw new Error(
      requestedLaneId
        ? `Lane ${requestedLaneId} was not found in session ${sessionId}.`
        : `No available lane found in session ${sessionId}.`
    )
  }

  const sessionMetadata = sessionState.session.metadata
  const maxIterations = positiveIntegerOption(
    args,
    "max-iterations",
    typeof sessionMetadata.maxIterations === "number"
      ? sessionMetadata.maxIterations
      : 10
  )
  const maxMinutes = positiveNumberOption(
    args,
    "max-minutes",
    typeof sessionMetadata.maxMinutes === "number"
      ? sessionMetadata.maxMinutes
      : 120
  )
  const workerTimeoutMs =
    positiveNumberOption(args, "worker-timeout", 1800) * 1000
  const syncIntervalMs = positiveNumberOption(args, "sync-interval", 5) * 1000
  const finalSyncTimeoutMs =
    positiveNumberOption(args, "final-sync-timeout", 120) * 1000
  const syncSupervisor = createSyncSupervisor({
    root,
    args,
    intervalMs: syncIntervalMs,
  })

  const result = await runLaneOnce({
    root,
    projectPath,
    campaign,
    setup,
    sessionId,
    lane,
    workerCommand: args.options["worker-command"],
    agentKind: args.options.agent ?? "codex",
    maxIterations,
    endTimeMs: Date.now() + maxMinutes * 60_000,
    workerTimeoutMs,
    syncSupervisor,
    args,
  })
  const pending = await syncSupervisor.drain(finalSyncTimeoutMs)
  if (result.status === "failed") {
    throw new Error(
      `Worker failed for ${lane.name}: ${result.error ?? "unknown error"}`
    )
  }
  console.log(
    `Worker completed ${lane.name} at ${result.resultCommitSha ?? "unknown"}; ${pending} sync record(s) pending.`
  )
}
