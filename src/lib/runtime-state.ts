import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { gitCommonDir } from "./git"

export type CliState = {
  projectId?: string
  projectCache?: {
    id: string
    name: string
    repositoryUrl: string
    repositoryFullName: string | null
    defaultBranch: string
    projectPath: string
    resolvedAt: string
    lastDeletionFetchAt?: string
  }
  projectPath?: string
  activeCampaign?: string
  campaigns?: Record<
    string,
    {
      campaignId?: string
      projectPath?: string
      baseCommitSha?: string | null
      description?: string | null
      metricName?: string
      metricUnit?: string | null
      metricDirection?: "maximize" | "minimize"
      setup?: Record<string, unknown>
      humanFeedback?: string | null
      promotionRefName?: string | null
      sessionId?: string
      hypothesisId?: string
      hypothesisName?: string
      workerBranch?: string
      workers?: Record<
        string,
        {
          workerId: string
          status?: string
          lastSeenAt?: string
        }
      >
    }
  >
  sessions?: Record<
    string,
    {
      campaignName?: string
      campaignId?: string
      deadlineAt?: string | null
      experimentTarget?: number | null
      acceptedExperimentCount?: number
      remainingExperimentCount?: number | null
      schedulerSiteId?: string | null
      stopRequested?: boolean
      status?: string
      terminalReason?: string | null
      finalizationStatus?:
        | "not_started"
        | "running"
        | "complete"
        | "incomplete"
        | "failed"
      ignoredPresence?: {
        total: number
        byReason: Record<string, number>
        lastAt: string | null
        recent: Array<{
          id: string
          reason: string
          message?: string
          at: string
        }>
      }
      providerBackoff?: {
        reason: string
        until: string
        attempt?: number
        delayMs?: number
        recentFailures?: Array<{
          at: string
          reason: string
          workerId: string | null
          hypothesisId: string
          error?: string | null
          errorSummary?: string | null
        }>
      } | null
      supervisor?: {
        pid?: number | null
        logPath?: string | null
        activeProcessCount?: number
        launchRate?: {
          batchSize: number | null
          intervalSeconds: number | null
        } | null
        providerBackoff?: {
          reason: string
          until: string
          attempt?: number
          delayMs?: number
          recentFailures?: Array<{
            at: string
            reason: string
            workerId: string | null
            hypothesisId: string
            error?: string | null
            errorSummary?: string | null
          }>
        } | null
        recentFailedLaunches?: Array<{
          at: string
          reason: string
          workerId: string | null
          hypothesisId: string
          error?: string | null
          errorSummary?: string | null
        }>
        status?: string
        updatedAt?: string
      }
    }
  >
}

export async function onyxStateDir(root: string) {
  const dir = join(await gitCommonDir(root), "onyx")
  await mkdir(dir, { recursive: true })
  return dir
}

export async function statePath(root: string) {
  return join(await onyxStateDir(root), "state.json")
}

async function locksDir(root: string) {
  const dir = join(await onyxStateDir(root), "locks")
  await mkdir(dir, { recursive: true })
  return dir
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uniqueTempPath(path: string) {
  return `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
}

export async function withOnyxLock<T>(
  root: string,
  name: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const staleMs = options.staleMs ?? 120_000
  const path = join(await locksDir(root), `${name}.lock`)
  const deadline = Date.now() + timeoutMs

  while (true) {
    try {
      await mkdir(path)
      await writeFile(
        join(path, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            createdAt: new Date().toISOString(),
          },
          null,
          2
        )}\n`,
        "utf8"
      )
      break
    } catch {
      const ageMs = await stat(path)
        .then((entry) => Date.now() - entry.mtimeMs)
        .catch(() => 0)
      if (ageMs > staleMs) {
        await rm(path, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for local Onyx ${name} lock.`)
      }
      await sleep(50 + Math.floor(Math.random() * 100))
    }
  }

  try {
    return await fn()
  } finally {
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

export async function readState(root: string): Promise<CliState> {
  try {
    const parsed = JSON.parse(
      await readFile(await statePath(root), "utf8")
    ) as Partial<CliState>
    return {
      projectId: parsed.projectId,
      projectCache: parsed.projectCache,
      projectPath: parsed.projectPath,
      activeCampaign: parsed.activeCampaign,
      campaigns: parsed.campaigns ?? {},
      sessions: parsed.sessions ?? {},
    }
  } catch {
    return { campaigns: {}, sessions: {} }
  }
}

export async function writeState(root: string, state: CliState) {
  await withOnyxLock(root, "state", async () => {
    await writeStateUnlocked(root, state)
  })
}

async function writeStateUnlocked(root: string, state: CliState) {
  const path = await statePath(root)
  const tmp = uniqueTempPath(path)
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export async function updateState(
  root: string,
  updater: (state: CliState) => Promise<void> | void
): Promise<CliState> {
  return withOnyxLock(root, "state", async () => {
    const state = await readState(root)
    await updater(state)
    await writeStateUnlocked(root, state)
    return state
  })
}
