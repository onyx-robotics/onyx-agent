import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { ApiSessionStateBrief } from "./api"
import { onyxStateDir } from "./runtime-state"
import type { WorkerRuntimeContext } from "./worker-context"

export type SessionStateBriefSnapshot = {
  schemaVersion: 1
  sequence: number
  refreshStatus: "initializing" | "ok" | "failed"
  generatedAt: string
  fetchedAt: string | null
  lastRefreshAttemptAt: string | null
  lastError?: string | null
  message?: string | null
  brief: ApiSessionStateBrief | null
}

export type WorkerSessionStateBrief = {
  schemaVersion: 1
  worker: {
    id: string
    sessionId: string
    campaignId: string
    campaignName: string
    hypothesisId: string
    hypothesisName: string
    assignment: WorkerRuntimeContext["assignment"]
  }
  sequence: number
  refreshStatus: SessionStateBriefSnapshot["refreshStatus"]
  generatedAt: string
  fetchedAt: string | null
  lastRefreshAttemptAt: string | null
  lastError: string | null
  message: string | null
  warnings: string[]
  session: ApiSessionStateBrief["session"] | null
  campaign:
    | ApiSessionStateBrief["campaign"]
    | {
        id: string
        name: string
      }
  progress: ApiSessionStateBrief["progress"] | null
  currentHypothesis: WorkerRuntimeContext["hypothesis"]
  peerHypothesisCount: number
  peerHypotheses: ApiSessionStateBrief["peerHypotheses"]
  results: ApiSessionStateBrief["results"]
  knowledge: ApiSessionStateBrief["knowledge"] & { moreCommand: string | null }
  updatedAt: string | null
  stop: WorkerSessionStopGuidance
}

export type WorkerSessionStopGuidance = {
  shouldStopStartingNewWork: boolean
  reasonCodes: Array<
    | "stop_requested"
    | "session_terminal"
    | "deadline_reached"
    | "experiment_target_reached"
  >
  reasons: string[]
  recommendedAction: "continue" | "finish_current_attempt_then_exit" | "exit"
  activeWorkflowCount: number
  unloggedAttemptCount: number
}

function safeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "unknown"
}

export async function sessionStateBriefPath(root: string, sessionId: string) {
  return join(
    await onyxStateDir(root),
    "worker-runtime",
    safeSegment(sessionId),
    "session-state-brief.json"
  )
}

export async function writeSessionStateBriefSnapshot({
  root,
  sessionId,
  snapshot,
}: {
  root: string
  sessionId: string
  snapshot: SessionStateBriefSnapshot
}) {
  const path = await sessionStateBriefPath(root, sessionId)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export async function readSessionStateBriefSnapshot({
  root,
  sessionId,
}: {
  root: string
  sessionId: string
}) {
  const path = await sessionStateBriefPath(root, sessionId)
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid session state brief at ${path}: expected object`)
  }
  const record = parsed as Partial<SessionStateBriefSnapshot>
  if (
    record.schemaVersion !== 1 ||
    typeof record.sequence !== "number" ||
    (record.refreshStatus !== "initializing" &&
      record.refreshStatus !== "ok" &&
      record.refreshStatus !== "failed") ||
    typeof record.generatedAt !== "string"
  ) {
    throw new Error(
      `Invalid session state brief at ${path}: unsupported schema`
    )
  }
  return record as SessionStateBriefSnapshot
}

export function placeholderSessionStateBrief({
  sequence = 0,
  now = new Date().toISOString(),
}: {
  sequence?: number
  now?: string
} = {}): SessionStateBriefSnapshot {
  return {
    schemaVersion: 1,
    sequence,
    refreshStatus: "initializing",
    generatedAt: now,
    fetchedAt: null,
    lastRefreshAttemptAt: null,
    lastError: null,
    message:
      "Research session started; supervisor has not fetched remote state yet.",
    brief: null,
  }
}

export function workerSessionStateBriefFromSnapshot({
  context,
  snapshot,
  stop,
  warnings = [],
}: {
  context: WorkerRuntimeContext
  snapshot: SessionStateBriefSnapshot | null
  stop?: WorkerSessionStopGuidance
  warnings?: string[]
}): WorkerSessionStateBrief {
  const fallbackGeneratedAt = new Date().toISOString()
  const brief = snapshot?.brief ?? null
  const outputWarnings = [...warnings]
  if (!snapshot) {
    outputWarnings.push("Supervisor session state brief is not available yet.")
  } else if (!brief) {
    outputWarnings.push(
      snapshot.message ?? "Supervisor session state brief is initializing."
    )
  } else if (snapshot.refreshStatus === "failed" && snapshot.lastError) {
    outputWarnings.push(
      `Supervisor session state brief refresh failed: ${snapshot.lastError}`
    )
  }
  return {
    schemaVersion: 1,
    worker: {
      id: context.workerId,
      sessionId: context.sessionId,
      campaignId: context.campaignId,
      campaignName: context.campaignName,
      hypothesisId: context.hypothesisId,
      hypothesisName: context.hypothesisName,
      assignment: context.assignment,
    },
    sequence: snapshot?.sequence ?? 0,
    refreshStatus: snapshot?.refreshStatus ?? "initializing",
    generatedAt: snapshot?.generatedAt ?? fallbackGeneratedAt,
    fetchedAt: snapshot?.fetchedAt ?? null,
    lastRefreshAttemptAt: snapshot?.lastRefreshAttemptAt ?? null,
    lastError: snapshot?.lastError ?? null,
    message:
      snapshot?.message ??
      (snapshot
        ? null
        : "Supervisor session state brief is not available yet."),
    warnings: outputWarnings,
    session: brief?.session ?? null,
    campaign: brief?.campaign ?? {
      id: context.campaignId,
      name: context.campaignName,
    },
    progress: brief?.progress ?? null,
    currentHypothesis: context.hypothesis,
    peerHypothesisCount: brief?.peerHypothesisCount ?? 0,
    peerHypotheses:
      brief?.peerHypotheses.filter(
        (hypothesis) => hypothesis.id !== context.hypothesisId
      ) ?? [],
    results: brief?.results ?? { latest: [], best: null },
    knowledge: {
      items: brief?.knowledge.items ?? [],
      hasMore: brief?.knowledge.hasMore ?? false,
      moreCommand: brief?.knowledge.hasMore
        ? `onyx-worker knowledge list --campaign ${JSON.stringify(context.campaignName)} --limit 50`
        : null,
    },
    updatedAt: brief?.updatedAt ?? null,
    stop:
      stop ??
      ({
        shouldStopStartingNewWork: false,
        reasonCodes: [],
        reasons: [],
        recommendedAction: "continue",
        activeWorkflowCount: 0,
        unloggedAttemptCount: 0,
      } satisfies WorkerSessionStopGuidance),
  }
}
