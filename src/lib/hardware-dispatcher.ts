import { mkdir, rm, rmdir } from "node:fs/promises"
import { join } from "node:path"

import { git } from "./git"
import {
  isHardwareQueueRun,
  listWorkflowRuns,
  readWorkflowRun,
  upsertWorkflowRun,
  type LocalHardwareJob,
  type LocalWorkflowRun,
} from "./research-runtime"
import { onyxStateDir, withOnyxLock } from "./runtime-state"

/** What the dispatcher needs to report a worker's hardware result. */
export type HardwareQueueWorker = {
  workerId: string
  hypothesisId: string
  assignmentId: string
  workerCredential: string
  /** Worker runtime context file; tool processes are tracked beside it. */
  contextPath: string | null
}

export type HardwareJobOutcome = {
  delivery: NonNullable<LocalHardwareJob["delivery"]>
  deliveryError?: string | null
  /** A tool could not be proven stopped; keep the worktree and lease. */
  uncertain?: boolean
}

export type HardwareDispatcherDeps = {
  /** Runs the queued run's workflow in `worktree` and writes its attempt. */
  runJob(input: {
    worktree: string
    run: LocalWorkflowRun
    worker: HardwareQueueWorker
    sandboxPolicyPath: string | null
  }): Promise<void>
  /** Delivers the job's terminal attempt with the worker's identity. */
  deliver(input: {
    worktree: string
    run: LocalWorkflowRun
    worker: HardwareQueueWorker
  }): Promise<"delivered" | "duplicate">
  /** Optional per-job tool sandbox policy; returns its path. */
  preparePolicy?(input: {
    worktree: string
    jobDir: string
  }): Promise<string | null>
  /** Distinguishes "processes may still be running" failures. */
  isUncertain?(error: unknown): boolean
  log?(message: string): void
}

const TERMINAL_ATTEMPT_STATUSES = new Set([
  "succeeded",
  "failed",
  "checks_failed",
  "setup_violation",
])

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function bounded(text: string, limit = 1000) {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`
}

/**
 * The supervisor's hardware queue. Workers queue sim-passed runs; this runs
 * them first come, first served, at most `concurrency` at a time, each in a
 * disposable worktree checked out at the run's result commit, and reports
 * each result with the queuing worker's identity. Results reach the worker
 * through its run records (`onyx-worker exp queue`).
 */
export function createHardwareDispatcher({
  root,
  sessionId,
  concurrency,
  deps,
}: {
  root: string
  sessionId: string
  concurrency: number
  deps: HardwareDispatcherDeps
}) {
  const workers = new Map<string, HardwareQueueWorker>()
  const draining = new Set<string>()
  const running = new Map<string, { workerId: string; done: Promise<void> }>()
  let closed = false
  const log = deps.log ?? (() => {})

  const jobsRoot = async () => join(await onyxStateDir(root), "hardware-jobs")

  const updateRun = async (
    runId: string,
    change: (run: LocalWorkflowRun) => LocalWorkflowRun | null
  ) =>
    withOnyxLock(root, "hardware-queue", async () => {
      const current = await readWorkflowRun(root, runId)
      if (!current) return null
      const next = change(current)
      if (next) await upsertWorkflowRun({ root, run: next })
      return next
    })

  const cancelQueued = async (
    runs: LocalWorkflowRun[],
    reason: string
  ) => {
    for (const run of runs) {
      await updateRun(run.id, (current) =>
        current.status === "queued" && !current.hardware?.startedAt
          ? {
              ...current,
              status: "abandoned",
              completedAt: new Date().toISOString(),
              blockReason: reason,
              hardware: {
                ...current.hardware!,
                finishedAt: new Date().toISOString(),
                delivery: "canceled",
                cancelReason: reason,
              },
            }
          : null
      )
    }
  }

  const worktreeFor = async (run: LocalWorkflowRun) =>
    join(await onyxStateDir(root), "worktrees", sessionId, `hw-${run.id}`)

  const addWorktree = async (dir: string, commitSha: string) => {
    await withOnyxLock(root, "git-worktree", async () => {
      await mkdir(join(await onyxStateDir(root), "worktrees", sessionId), {
        recursive: true,
      })
      await git(["worktree", "add", "--detach", dir, commitSha], root)
    })
  }

  const removeWorktree = async (dir: string) => {
    await withOnyxLock(root, "git-worktree", async () => {
      await git(["worktree", "remove", "--force", dir], root).catch(() => {})
      await git(["worktree", "prune"], root).catch(() => {})
      await rmdir(join(dir, "..")).catch(() => {})
    })
  }

  const runJob = async (run: LocalWorkflowRun, worker: HardwareQueueWorker) => {
    const worktree = await worktreeFor(run)
    const jobDir = join(await jobsRoot(), sessionId, run.id)
    let outcome: HardwareJobOutcome = { delivery: "failed" }
    let blockReason: string | null = null
    try {
      await mkdir(jobDir, { recursive: true })
      await addWorktree(worktree, run.resultCommitSha!)
      const sandboxPolicyPath =
        (await deps.preparePolicy?.({ worktree, jobDir })) ?? null
      log(
        `Hardware job ${run.id}: ${run.resultCommitSha?.slice(0, 7)} from worker ${worker.workerId}`
      )
      await deps.runJob({ worktree, run, worker, sandboxPolicyPath })
      const finished = await readWorkflowRun(root, run.id)
      if (finished && TERMINAL_ATTEMPT_STATUSES.has(finished.status)) {
        try {
          outcome = { delivery: await deps.deliver({ worktree, run: finished, worker }) }
        } catch (error) {
          // The attempt stays in the pending outbox for report recovery.
          outcome = { delivery: "failed", deliveryError: bounded(errorMessage(error)) }
        }
      } else {
        blockReason = bounded(
          finished?.blockReason ??
            `Hardware workflow ended as ${finished?.status ?? "missing"} without a measured result.`
        )
        outcome = { delivery: "failed", deliveryError: blockReason }
      }
    } catch (error) {
      blockReason = bounded(`Hardware job failed: ${errorMessage(error)}`)
      outcome = {
        delivery: "failed",
        deliveryError: blockReason,
        uncertain: deps.isUncertain?.(error) ?? false,
      }
    }
    await updateRun(run.id, (current) => {
      const terminal = TERMINAL_ATTEMPT_STATUSES.has(current.status)
      return {
        ...current,
        ...(terminal
          ? {}
          : {
              status: "abandoned" as const,
              blockReason: blockReason ?? current.blockReason,
              completedAt: new Date().toISOString(),
            }),
        hardware: {
          ...current.hardware!,
          finishedAt: new Date().toISOString(),
          delivery: outcome.delivery,
          deliveryError: outcome.deliveryError ?? null,
        },
      }
    }).catch(() => {})
    if (outcome.uncertain) {
      log(
        `Hardware job ${run.id}: tool processes may still be running; keeping ${worktree} and its resource lease for inspection.`
      )
      return
    }
    await removeWorktree(worktree).catch((error) =>
      log(`Hardware job ${run.id}: worktree cleanup failed: ${errorMessage(error)}`)
    )
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
    log(
      `Hardware job ${run.id}: ${outcome.delivery}${outcome.deliveryError ? ` (${outcome.deliveryError})` : ""}`
    )
  }

  /** Claims the oldest eligible queued run, under the queue lock. */
  const claimNext = async () =>
    withOnyxLock(root, "hardware-queue", async () => {
      const queued = (
        await listWorkflowRuns(root, { sessionId, statuses: ["queued"] })
      )
        .filter((run) => run.hardware && !run.hardware.startedAt)
        .sort(
          (left, right) =>
            left.hardware!.queuedAt.localeCompare(right.hardware!.queuedAt) ||
            left.id.localeCompare(right.id)
        )
      for (const run of queued) {
        const worker = run.workerId ? workers.get(run.workerId) : undefined
        if (!worker || draining.has(worker.workerId)) continue
        const started: LocalWorkflowRun = {
          ...run,
          status: "running",
          hardware: { ...run.hardware!, startedAt: new Date().toISOString() },
        }
        await upsertWorkflowRun({ root, run: started })
        return { run: started, worker }
      }
      return null
    })

  return {
    registerWorker(worker: HardwareQueueWorker) {
      workers.set(worker.workerId, worker)
    },

    /** Starts queued jobs while there is capacity. Never throws. */
    async tick() {
      if (closed) return
      try {
        while (running.size < concurrency) {
          const next = await claimNext()
          if (!next) return
          const done = runJob(next.run, next.worker)
            .catch((error) =>
              log(`Hardware job ${next.run.id} crashed: ${errorMessage(error)}`)
            )
            .finally(() => {
              running.delete(next.run.id)
            })
          running.set(next.run.id, { workerId: next.worker.workerId, done })
        }
      } catch (error) {
        log(`Hardware queue tick failed: ${errorMessage(error)}`)
      }
    },

    /**
     * Before a worker is torn down: cancel its experiments still waiting in
     * line and wait for the one on hardware, so its result is reported while
     * the worker's credential is still valid.
     */
    async drainWorker(workerId: string) {
      draining.add(workerId)
      const runs = await listWorkflowRuns(root, {
        sessionId,
        workerId,
        statuses: ["queued"],
      }).catch(() => [])
      await cancelQueued(
        runs,
        "Worker stopped before its hardware turn; this experiment was not run on hardware."
      ).catch(() => {})
      await Promise.all(
        [...running.values()]
          .filter((job) => job.workerId === workerId)
          .map((job) => job.done)
      )
      workers.delete(workerId)
    },

    /**
     * Stops starting jobs and cancels the line, without waiting for the jobs
     * already on hardware. Workers waiting on canceled experiments see that
     * right away instead of waiting for a turn that will never come.
     */
    async stopAccepting(
      reason = "Session is stopping; this experiment was not run on hardware."
    ) {
      closed = true
      const runs = await listWorkflowRuns(root, {
        sessionId,
        statuses: ["queued"],
      }).catch(() => [])
      await cancelQueued(runs, reason).catch(() => {})
    },

    /** Stops starting jobs, cancels the line, waits for running jobs. */
    async close(reason = "Session ended before this experiment's hardware turn.") {
      await this.stopAccepting(reason)
      await Promise.all([...running.values()].map((job) => job.done))
    },

    async status() {
      const runs = await listWorkflowRuns(root, {
        sessionId,
        statuses: ["queued", "running"],
      }).catch(() => [] as LocalWorkflowRun[])
      const active = runs.filter(isHardwareQueueRun)
      return {
        waiting: active.filter((run) => run.status === "queued").length,
        running: active.filter((run) => run.status === "running").length,
      }
    },

    get runningCount() {
      return running.size
    },
  }
}

export type HardwareDispatcher = ReturnType<typeof createHardwareDispatcher>
