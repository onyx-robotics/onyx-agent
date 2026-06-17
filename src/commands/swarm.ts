import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { Args } from "../lib/args"
import {
  cancelCampaignTask,
  completeCampaignTask,
  createCampaignSession,
  createCampaignTask,
  getCampaignTimeline,
  heartbeatCampaignTask,
  heartbeatWorker,
  leaseCampaignTask,
  listProjectCampaigns,
  registerCampaignWorker,
  reportCampaignExperiment,
  resolveProject,
  type ApiCampaign,
  type ApiTask,
} from "../lib/api"
import { emitEvent } from "../lib/events"
import { currentCommit, git, gitDir, pushRef, repoRoot } from "../lib/git"
import {
  parseMetricLines,
  primaryMetric,
  summarizeOutput,
} from "../lib/metrics"
import { onyxStateDir, readState, writeState } from "../lib/outbox"
import {
  campaignStateKey,
  onyxPath,
  resolveProjectPath,
  scopedRoot,
} from "../lib/project"
import { pathExists, runProcess } from "../lib/process"
import { flushOutbox } from "../lib/sync"

const HEARTBEAT_INTERVAL_MS = 5_000
const TASK_LEASE_SECONDS = 60
const EMPTY_LEASE_SLEEP_MS = 5_000
const NO_COMMIT_RETRY_SLEEP_MS = (TASK_LEASE_SECONDS + 5) * 1_000

function positiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("worker count must be a positive integer")
  }
  return parsed
}

function requireWorkerCommand(args: Args) {
  const command = args.options["worker-command"] ?? process.env.ONYX_WORKER_COMMAND
  if (!command) {
    throw new Error(
      "Missing --worker-command (or ONYX_WORKER_COMMAND). Built-in agent adapters are not part of this v1 runner."
    )
  }
  return command
}

function safeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-")
}

async function swarmPath(root: string) {
  return join(await onyxStateDir(root), "swarm.json")
}

async function readSwarm(root: string): Promise<{
  sessions: Record<
    string,
    {
      campaignId: string
      campaignName: string
      startedAt: string
      workerCommand: string
      workers: Record<string, { workerId: string; pid?: number; workerName: string }>
    }
  >
}> {
  try {
    return JSON.parse(await readFile(await swarmPath(root), "utf8"))
  } catch {
    return { sessions: {} }
  }
}

async function writeSwarm(root: string, state: Awaited<ReturnType<typeof readSwarm>>) {
  const path = await swarmPath(root)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
}

async function resolveCampaign(
  root: string,
  args: Args,
  campaignName: string
): Promise<ApiCampaign> {
  const projectPath = await resolveProjectPath(root, args)
  await flushOutbox(root, args, { quiet: true }).catch(() => {})
  const state = await readState(root)
  const key = campaignStateKey(projectPath, campaignName)
  const cached = state.campaigns?.[key]
  if (cached?.campaignId && cached.metricName && cached.baseCommitSha) {
    return {
      id: cached.campaignId,
      projectId: state.projectId ?? "",
      name: campaignName,
      description: cached.description ?? null,
      baseCommitSha: cached.baseCommitSha,
      metricName: cached.metricName,
      metricUnit: cached.metricUnit ?? null,
      metricDirection: cached.metricDirection ?? "maximize",
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: cached.promotionRefName ?? null,
    }
  }

  const project = await resolveProject(root, args)
  const campaign = (await listProjectCampaigns(project.id, args)).find(
    (candidate) => candidate.name === campaignName
  )
  if (!campaign) {
    throw new Error(`Campaign ${campaignName} not found in Onyx.`)
  }
  state.projectId = project.id
  state.activeCampaign = campaignName
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
  return campaign
}

async function seedTasksIfNeeded({
  root,
  campaign,
  sessionId,
  workerCount,
  args,
}: {
  root: string
  campaign: ApiCampaign
  sessionId: string
  workerCount: number
  args: Args
}) {
  const timeline = await getCampaignTimeline(campaign.id, args)
  if (timeline.tasks.some((task) => task.status !== "completed")) return

  for (let index = 0; index < workerCount; index += 1) {
    await createCampaignTask(
      campaign.id,
      {
        sessionId,
        title: `${campaign.name} task ${index + 1}`,
        description:
          campaign.description ??
          `Improve ${campaign.metricName} for campaign ${campaign.name}.`,
        priority: workerCount - index,
        baseCommitSha: campaign.bestCommitSha ?? campaign.baseCommitSha,
        maxAttempts: 3,
        metadata: { seededBy: "onyx-swarm", index },
      },
      args
    )
    await emitEvent(root, {
      type: "task_created",
      campaignName: campaign.name,
      campaignId: campaign.id,
      message: `task ${index + 1}`,
    }).catch(() => {})
  }
}

function currentCliEntrypoint() {
  return process.argv[1] ?? "onyx"
}

export async function commandSwarmStart(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const campaignName =
    args.options.campaign ?? state.activeCampaign ?? args.options.name
  if (!campaignName) {
    throw new Error("Missing --campaign (or active campaign).")
  }
  const workerCommand = requireWorkerCommand(args)
  const workerCount = positiveInt(args.options.workers, 1)
  const campaign = await resolveCampaign(root, args, campaignName)
  const session = await createCampaignSession(
    campaign.id,
    {
      name: args.options.name ?? `local-${new Date().toISOString()}`,
      workerTarget: workerCount,
      metadata: { supervisor: "onyx-cli", workerCommand },
    },
    args
  )
  await seedTasksIfNeeded({
    root,
    campaign,
    sessionId: session.id,
    workerCount,
    args,
  })

  const key = campaignStateKey(projectPath, campaignName)
  const next = await readState(root)
  next.activeCampaign = campaignName
  next.campaigns = next.campaigns ?? {}
  next.campaigns[key] = {
    ...next.campaigns[key],
    campaignId: campaign.id,
    projectPath,
    baseCommitSha: campaign.baseCommitSha,
    description: campaign.description,
    metricName: campaign.metricName,
    metricUnit: campaign.metricUnit,
    metricDirection: campaign.metricDirection,
    promotionRefName: campaign.promotionRefName,
    sessionId: session.id,
    workers: next.campaigns[key]?.workers ?? {},
  }

  const swarm = await readSwarm(root)
  swarm.sessions[session.id] = {
    campaignId: campaign.id,
    campaignName,
    startedAt: new Date().toISOString(),
    workerCommand,
    workers: {},
  }

  for (let index = 0; index < workerCount; index += 1) {
    const workerName = `${campaignName}-${index + 1}`
    const worker = await registerCampaignWorker(
      campaign.id,
      {
        sessionId: session.id,
        workerName,
        agentKind: args.options.agent ?? "generic",
        runtime: "local",
        metadata: { supervisor: "onyx-cli", index, workerCommand },
      },
      args
    )
    await heartbeatWorker(
      worker.id,
      {
        sessionId: session.id,
        status: "idle",
        phase: "registered",
        event: "swarm_start",
        progressMessage: "worker process starting",
      },
      args
    ).catch(() => {})
    const childArgs = [
      currentCliEntrypoint(),
      "worker",
      "run",
      "--campaign",
      campaignName,
      "--campaign-id",
      campaign.id,
      "--session",
      session.id,
      "--worker-id",
      worker.id,
      "--worker-name",
      workerName,
      "--worker-command",
      workerCommand,
      "--project-path",
      projectPath,
    ]
    if (args.options.profile) childArgs.push("--profile", args.options.profile)
    if (args.options["api-url"])
      childArgs.push("--api-url", args.options["api-url"])
    const child = spawn(
      process.execPath,
      childArgs,
      {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: process.env,
      }
    )
    child.unref()
    next.campaigns[key]!.workers = {
      ...(next.campaigns[key]!.workers ?? {}),
      [workerName]: {
        workerId: worker.id,
        status: worker.status,
        lastSeenAt: worker.lastSeenAt,
      },
    }
    swarm.sessions[session.id]!.workers[workerName] = {
      workerId: worker.id,
      pid: child.pid,
      workerName,
    }
  }

  await writeState(root, next)
  await writeSwarm(root, swarm)
  await emitEvent(root, {
    type: "swarm_started",
    campaignName,
    campaignId: campaign.id,
    sessionId: session.id,
    message: `${workerCount} worker(s)`,
  })
  console.log(
    `Started swarm session ${session.id} for ${campaignName} with ${workerCount} worker(s)`
  )
}

async function workerDirs({
  root,
  campaignId,
  sessionId,
  workerName,
  workerId,
}: {
  root: string
  campaignId: string
  sessionId: string
  workerName: string
  workerId: string
}) {
  const base = join(await gitDir(root), "onyx")
  return {
    worktree: join(
      base,
      "worktrees",
      campaignId,
      sessionId,
      safeSegment(workerName)
    ),
    stateDir: join(base, "worker-state", workerId),
  }
}

async function prepareWorktree(root: string, worktree: string, baseCommitSha: string) {
  await mkdir(dirname(worktree), { recursive: true })
  if (!(await pathExists(worktree))) {
    await git(["worktree", "add", "--detach", worktree, baseCommitSha], root)
  }
  await git(["fetch", "--all", "--prune"], worktree).catch(() => {})
  await git(["reset", "--hard", baseCommitSha], worktree)
  await git(["clean", "-ffd"], worktree)
}

async function writeTaskFiles({
  task,
  campaign,
  runRef,
  resultRef,
  stateDir,
}: {
  task: ApiTask
  campaign: ApiCampaign
  runRef: string
  resultRef: string
  stateDir: string
}) {
  await mkdir(stateDir, { recursive: true })
  const taskJsonPath = join(stateDir, "task.json")
  const taskMdPath = join(stateDir, "task.md")
  const resultPath = join(stateDir, "result.json")
  const taskJson = {
    task,
    campaign,
    runRef,
    resultRef,
    resultPath,
  }
  const taskMd = [
    `# ${task.title}`,
    "",
    task.description ?? campaign.description ?? "",
    "",
    `Campaign: ${campaign.name}`,
    `Metric: ${campaign.metricName} (${campaign.metricDirection})`,
    `Base commit: ${task.baseCommitSha ?? campaign.baseCommitSha}`,
    `Result ref: ${resultRef}`,
  ].join("\n")
  await writeFile(taskJsonPath, `${JSON.stringify(taskJson, null, 2)}\n`, "utf8")
  await writeFile(taskMdPath, `${taskMd}\n`, "utf8")
  await writeFile(resultPath, "{}\n", "utf8")
  return { taskJsonPath, taskMdPath, resultPath }
}

async function runEvalAndChecks({
  worktree,
  projectPath,
  metricName,
}: {
  worktree: string
  projectPath: string
  metricName: string
}) {
  const evalSh = onyxPath(worktree, projectPath, "eval.sh")
  if (!(await pathExists(evalSh))) {
    return {
      status: "failed" as const,
      metrics: {},
      primary: { name: metricName, value: null },
      checks: null,
      durationMs: null,
      outputSummary: `Missing ${evalSh}.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }
  }

  const started = new Date()
  const result = await runProcess("bash", [evalSh], {
    cwd: scopedRoot(worktree, projectPath),
    timeoutMs: 600_000,
  })
  const completed = new Date()
  const metrics = parseMetricLines(result.stdout, metricName)
  const primary = primaryMetric(metrics, metricName)
  const evalSucceeded =
    result.code === 0 && !result.timedOut && primary.value !== null
  let checks: {
    status: "passed" | "failed" | "timed_out"
    durationMs: number | null
    outputSummary: string | null
  } | null = null
  if (evalSucceeded) {
    const checksSh = onyxPath(worktree, projectPath, "checks.sh")
    if (await pathExists(checksSh)) {
      const checksStarted = Date.now()
      const checksResult = await runProcess("bash", [checksSh], {
        cwd: scopedRoot(worktree, projectPath),
        timeoutMs: 300_000,
      })
      checks = {
        status: checksResult.timedOut
          ? "timed_out"
          : checksResult.code === 0
            ? "passed"
            : "failed",
        durationMs: Date.now() - checksStarted,
        outputSummary:
          summarizeOutput(checksResult.stdout, checksResult.stderr) || null,
      }
    }
  }
  const status: "failed" | "checks_failed" | "succeeded" = !evalSucceeded
    ? "failed"
    : checks && checks.status !== "passed"
      ? "checks_failed"
      : "succeeded"
  const outputSummary = [
    result.timedOut ? "Eval timed out after 600s." : "",
    result.code === 0 && primary.value === null
      ? `No METRIC line found for ${metricName}.`
      : "",
    summarizeOutput(result.stdout, result.stderr),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000)

  return {
    status,
    metrics,
    primary,
    checks,
    durationMs: completed.getTime() - started.getTime(),
    outputSummary: outputSummary || null,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
  }
}

async function runOneTask({
  root,
  args,
  campaign,
  task,
  workerId,
  workerName,
  sessionId,
  workerCommand,
  projectPath,
}: {
  root: string
  args: Args
  campaign: ApiCampaign
  task: ApiTask
  workerId: string
  workerName: string
  sessionId: string
  workerCommand: string
  projectPath: string
}) {
  const baseCommitSha = task.baseCommitSha ?? campaign.bestCommitSha ?? campaign.baseCommitSha
  const runRef = `local/${campaign.name}/${randomUUID()}`
  const resultRef = `refs/onyx/experiments/${campaign.id}/${safeSegment(runRef)}`
  const { worktree, stateDir } = await workerDirs({
    root,
    campaignId: campaign.id,
    sessionId,
    workerName,
    workerId,
  })
  await heartbeatWorker(workerId, {
    sessionId,
    taskId: task.id,
    status: "running",
    phase: "worktree",
    event: "task_leased",
    progressMessage: `preparing ${baseCommitSha.slice(0, 7)}`,
    gitLabel: workerName,
  }, args).catch(() => {})
  await emitEvent(root, {
    type: "task_leased",
    campaignName: campaign.name,
    campaignId: campaign.id,
    sessionId,
    workerId,
    taskId: task.id,
    runRef,
    message: task.title,
  })
  await prepareWorktree(root, worktree, baseCommitSha)
  const files = await writeTaskFiles({
    task,
    campaign,
    runRef,
    resultRef,
    stateDir,
  })

  let stopped = false
  const pulse = setInterval(() => {
    void heartbeatWorker(workerId, {
      sessionId,
      taskId: task.id,
      status: "running",
      phase: "command",
      event: "heartbeat",
      progressMessage: "worker command running",
      gitLabel: workerName,
    }, args).catch(() => {})
    void heartbeatCampaignTask(task.id, {
      campaignId: campaign.id,
      workerId,
      leaseSeconds: TASK_LEASE_SECONDS,
      status: "running",
      progressMessage: "worker command running",
    }, args).catch(() => {})
  }, HEARTBEAT_INTERVAL_MS)

  const env = {
    ...process.env,
    ONYX_CAMPAIGN_ID: campaign.id,
    ONYX_CAMPAIGN_NAME: campaign.name,
    ONYX_SESSION_ID: sessionId,
    ONYX_WORKER_ID: workerId,
    ONYX_WORKER_NAME: workerName,
    ONYX_TASK_ID: task.id,
    ONYX_TASK_FILE: files.taskMdPath,
    ONYX_TASK_JSON: files.taskJsonPath,
    ONYX_RESULT_FILE: files.resultPath,
    ONYX_BASE_COMMIT_SHA: baseCommitSha,
    ONYX_RUN_REF: runRef,
    ONYX_RESULT_REF: resultRef,
    ONYX_API_URL: process.env.ONYX_API_URL ?? "",
    ONYX_WORKER_STATE_DIR: stateDir,
  }

  try {
    const commandResult = await runProcess("sh", ["-lc", workerCommand], {
      cwd: worktree,
      env,
    })
    const resultCommitSha = await currentCommit(worktree)
    if (resultCommitSha === baseCommitSha) {
      await heartbeatWorker(workerId, {
        sessionId,
        taskId: task.id,
        status: "idle",
        phase: "no_commit",
        event: "no_commit",
        progressMessage: "worker command exited without a commit",
        gitLabel: workerName,
      }, args).catch(() => {})
      if (task.attemptCount + 1 >= task.maxAttempts) {
        await cancelCampaignTask(
          task.id,
          {
            campaignId: campaign.id,
            workerId,
            reason: "worker command exited without creating a commit",
            metadata: {
              stdout: summarizeOutput(commandResult.stdout, commandResult.stderr),
            },
          },
          args
        ).catch(() => {})
      } else {
        await new Promise((resolve) => setTimeout(resolve, NO_COMMIT_RETRY_SLEEP_MS))
      }
      return
    }

    await heartbeatWorker(workerId, {
      sessionId,
      taskId: task.id,
      status: "running",
      phase: "eval",
      event: "eval_started",
      progressMessage: `evaluating ${resultCommitSha.slice(0, 7)}`,
      gitLabel: workerName,
    }, args).catch(() => {})
    const measured = await runEvalAndChecks({
      worktree,
      projectPath,
      metricName: campaign.metricName,
    })
    await emitEvent(root, {
      type: "eval_finished",
      campaignName: campaign.name,
      campaignId: campaign.id,
      sessionId,
      workerId,
      taskId: task.id,
      runRef,
      commitSha: resultCommitSha,
      resultRef,
      message: `${measured.primary.name}=${measured.primary.value ?? "null"} (${measured.status})`,
    })

    await heartbeatWorker(workerId, {
      sessionId,
      taskId: task.id,
      status: "running",
      phase: "push",
      event: "push_ref",
      progressMessage: resultRef,
      gitLabel: workerName,
    }, args).catch(() => {})
    await pushRef(worktree, resultCommitSha, resultRef)
    const experiment = await reportCampaignExperiment(
      campaign.id,
      {
        sessionId,
        taskId: task.id,
        workerId,
        name: `task-${task.id.slice(0, 8)}-${resultCommitSha.slice(0, 7)}`,
        description: task.title,
        runRef,
        baseCommitSha,
        resultCommitSha,
        resultRef,
        status: measured.status,
        primaryMetricName: measured.primary.name,
        primaryMetricValue: measured.primary.value ?? undefined,
        secondaryMetrics: measured.metrics,
        artifactRefs: {},
        agentNotes: {
          workerName,
          taskTitle: task.title,
          commandOutput: summarizeOutput(commandResult.stdout, commandResult.stderr),
        },
        checks: measured.checks ?? undefined,
        durationMs: measured.durationMs ?? undefined,
        outputSummary: measured.outputSummary ?? undefined,
        startedAt: measured.startedAt,
        completedAt: measured.completedAt,
        provenance: [],
      },
      args
    )
    await completeCampaignTask(
      task.id,
      {
        campaignId: campaign.id,
        workerId,
        experimentId: experiment.id,
        status: "completed",
      },
      args
    )
    await emitEvent(root, {
      type: "task_completed",
      campaignName: campaign.name,
      campaignId: campaign.id,
      sessionId,
      workerId,
      taskId: task.id,
      runRef,
      commitSha: resultCommitSha,
      resultRef,
      message: measured.status,
    })
  } finally {
    stopped = true
    clearInterval(pulse)
    if (!stopped) clearInterval(pulse)
  }
}

export async function commandWorkerRun(args: Args) {
  const root = await repoRoot()
  const campaignName = args.options.campaign
  const campaignId = args.options["campaign-id"]
  const sessionId = args.options.session
  const workerId = args.options["worker-id"]
  const workerName = args.options["worker-name"]
  const workerCommand = requireWorkerCommand(args)
  const projectPath = await resolveProjectPath(root, args)
  if (!campaignName || !campaignId || !sessionId || !workerId || !workerName) {
    throw new Error(
      "worker run requires --campaign, --campaign-id, --session, --worker-id, and --worker-name"
    )
  }
  const campaign = await resolveCampaign(root, args, campaignName)
  let quitting = false
  const stop = () => {
    quitting = true
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  await emitEvent(root, {
    type: "worker_started",
    campaignName,
    campaignId,
    sessionId,
    workerId,
    message: workerName,
  })

  while (!quitting) {
    await heartbeatWorker(
      workerId,
      {
        sessionId,
        status: "idle",
        phase: "lease",
        event: "lease_poll",
        progressMessage: "looking for queued task",
        gitLabel: workerName,
      },
      args
    ).catch(() => {})
    const lease = await leaseCampaignTask(
      { campaignId, workerId, leaseSeconds: TASK_LEASE_SECONDS },
      args
    )
    if (!lease.task) {
      await new Promise((resolve) => setTimeout(resolve, EMPTY_LEASE_SLEEP_MS))
      continue
    }
    await runOneTask({
      root,
      args,
      campaign,
      task: lease.task,
      workerId,
      workerName,
      sessionId,
      workerCommand,
      projectPath,
    }).catch(async (error) => {
      await heartbeatWorker(workerId, {
        sessionId,
        taskId: lease.task?.id,
        status: "running",
        phase: "error",
        event: "task_error",
        progressMessage: error instanceof Error ? error.message : String(error),
        gitLabel: workerName,
      }, args).catch(() => {})
      if (lease.task && lease.task.attemptCount + 1 >= lease.task.maxAttempts) {
        await cancelCampaignTask(
          lease.task.id,
          {
            campaignId,
            workerId,
            reason: error instanceof Error ? error.message : String(error),
          },
          args
        ).catch(() => {})
      }
    })
  }

  await heartbeatWorker(
    workerId,
    {
      sessionId,
      status: "stopped",
      phase: "stopped",
      event: "worker_stopped",
      progressMessage: "worker stopped",
      gitLabel: workerName,
    },
    args
  ).catch(() => {})
  await emitEvent(root, {
    type: "worker_stopped",
    campaignName,
    campaignId,
    sessionId,
    workerId,
    message: workerName,
  })
}

export async function commandSwarmStatus(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const state = await readState(root)
  const campaignName = args.options.campaign ?? state.activeCampaign
  if (!campaignName) {
    console.log("campaign: none")
    return
  }
  const campaign =
    state.campaigns?.[campaignStateKey(projectPath, campaignName)]
  console.log(`campaign: ${campaignName}`)
  console.log(`session: ${campaign?.sessionId ?? "(none)"}`)
  const swarm = await readSwarm(root)
  const session = campaign?.sessionId ? swarm.sessions[campaign.sessionId] : null
  if (session) {
    for (const [name, worker] of Object.entries(session.workers)) {
      console.log(
        `local ${name}: pid ${worker.pid ?? "?"} worker ${worker.workerId}`
      )
    }
  }
  if (!campaign?.campaignId) return
  const timeline = await getCampaignTimeline(campaign.campaignId, args).catch(
    () => null
  )
  if (!timeline) return
  for (const worker of timeline.workers) {
    console.log(
      `api ${worker.workerName}: ${worker.status} phase=${worker.phase ?? "-"} task=${worker.currentTaskId ?? "-"} seen=${worker.lastSeenAt}`
    )
  }
  const tasks = timeline.tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1
    return counts
  }, {})
  console.log(
    `tasks: ${Object.entries(tasks)
      .map(([status, count]) => `${status}=${count}`)
      .join(" ") || "none"}`
  )
}
