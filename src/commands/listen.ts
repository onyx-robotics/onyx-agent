import { watch, type FSWatcher } from "node:fs"
import { stat } from "node:fs/promises"
import { basename } from "node:path"

import type {
  LocalResearchEvent,
  LocalResearchHistoryRecord,
} from "../protocol"

import { readEvents } from "../lib/events"
import { gitResult, repoRoot } from "../lib/git"
import { historyPath, readHistory } from "../lib/history"
import { onyxStateDir, readLastRun, readOutbox, readState } from "../lib/outbox"
import { campaignStateKey } from "../lib/project"
import { formatAge, renderFrame, type ListenModel } from "../lib/tui"

const CSI = "\x1b["
const RENDER_INTERVAL_MS = 500
const RENDER_MIN_GAP_MS = 100
// Matches the spinner's frame duration in lib/tui.ts.
const SPINNER_REDRAW_MS = 120
// The session counts as live for 2 minutes after the last event/commit, or
// for the whole eval window while a run is in flight (default timeout 600s).
const ACTIVE_WINDOW_MS = 2 * 60_000
const EVAL_ACTIVE_WINDOW_MS = 10 * 60_000
// While idle, rebuild the model every Nth interval tick (2s instead of 500ms)
// to keep git spawns and file reads minimal on constrained hardware.
const IDLE_REBUILD_EVERY = 4

// history.jsonl is re-read (and Zod-parsed) only when its mtime/size changes;
// the parse of a long history is the most expensive part of a rebuild.
let historyCache: {
  key: string
  records: LocalResearchHistoryRecord[]
} | null = null

async function readHistoryCached(
  root: string
): Promise<LocalResearchHistoryRecord[]> {
  let key: string
  try {
    const stats = await stat(await historyPath(root))
    key = `${stats.mtimeMs}:${stats.size}`
  } catch {
    historyCache = null
    return []
  }
  if (historyCache?.key === key) return historyCache.records
  const { records } = await readHistory(root)
  historyCache = { key, records }
  return records
}

function describeEvent(event: LocalResearchEvent, nowMs: number) {
  const sha = event.commitSha ? event.commitSha.slice(0, 7) : null
  const labels: Record<LocalResearchEvent["type"], string> = {
    campaign_created: "campaign created",
    campaign_deleted: "campaign deleted",
    setup_created: "setup created",
    setup_validated: "setup validated",
    setup_validation_failed: "setup validation failed",
    session_started: "session started",
    session_stopped: "session stopped",
    lane_created: "lane created",
    lane_claimed: "lane claimed",
    lane_heartbeat: "lane heartbeat",
    lane_completed: "lane completed",
    worker_started: "worker started",
    worker_heartbeat: "worker heartbeat",
    worker_stopped: "worker stopped",
    research_started: "research started",
    exp_run_started: "running eval",
    eval_finished: "eval finished",
    checks_finished: "checks",
    run_finished: "measured",
    exp_logged: "logged",
    flush_finished: "sync",
    pushed: "pushed",
  }
  const parts = [labels[event.type], sha, event.message].filter(Boolean)
  return `${parts.join(" · ")} · ${formatAge(event.ts, nowMs)}`
}

/** Latest commit on HEAD as a live-activity candidate. */
async function headCommitInfo(root: string) {
  const result = await gitResult(
    ["log", "-1", "--format=%H%x09%cI%x09%s"],
    root
  )
  if (result.code !== 0) return null
  const [sha, committedAt, subject] = result.stdout.trim().split("\t")
  if (!sha) return null
  return { sha, committedAt: committedAt ?? "", subject: subject ?? "" }
}

async function buildModel(root: string): Promise<ListenModel> {
  const state = await readState(root)
  const campaignName = state.activeCampaign ?? null

  const records = await readHistoryCached(root)
  // Ascending — the most recent experiment renders at the bottom of the
  // table. Copy before sorting/pushing so the cached array stays untouched.
  const rows = (
    campaignName
      ? records.filter((record) => record.campaignName === campaignName)
      : [...records]
  ).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  )

  // Surface a measured-but-unlogged run at the bottom of the table.
  const lastRun = await readLastRun(root)
  if (lastRun && !rows.some((row) => row.runRef === lastRun.runRef)) {
    rows.push({
      schemaVersion: 1,
      source: "local",
      campaignName: lastRun.campaignName,
      runRef: lastRun.runRef,
      baseCommitSha: lastRun.baseCommitSha,
      resultCommitSha: lastRun.resultCommitSha,
      resultRef: lastRun.resultRef,
      status: lastRun.status,
      name: `(unlogged) ${lastRun.resultCommitSha.slice(0, 7)}`,
      primaryMetricName: lastRun.primaryMetricName,
      primaryMetricValue: lastRun.primaryMetricValue,
      metrics: lastRun.metrics,
      agentNotes: lastRun.agentNotes,
      sessionId: lastRun.sessionId,
      workerId: lastRun.workerId,
      laneId: lastRun.laneId,
      startedAt: lastRun.startedAt ?? null,
      completedAt: lastRun.completedAt ?? null,
      createdAt: lastRun.createdAt,
    })
  }

  const meta = campaignName
    ? state.campaigns?.[campaignStateKey(state.projectPath ?? "", campaignName)]
    : undefined
  const metricName = meta?.metricName ?? rows[0]?.primaryMetricName ?? null
  const metricDirection = meta?.metricDirection ?? "maximize"
  const measured = rows.filter(
    (row) =>
      (row.status === "succeeded" || row.status === "accepted") &&
      row.primaryMetricValue !== null
  )
  const bestValue = measured.length
    ? measured.reduce(
        (best, row) =>
          metricDirection === "minimize"
            ? Math.min(best, row.primaryMetricValue as number)
            : Math.max(best, row.primaryMetricValue as number),
        metricDirection === "minimize" ? Infinity : -Infinity
      )
    : null

  // Activity: most recent of (latest CLI event, latest commit on HEAD).
  const nowMs = Date.now()
  const [latestEvent] = (await readEvents(root, { tail: 1 })).slice(-1)
  const head = await headCommitInfo(root)
  let activity: string | null = latestEvent
    ? describeEvent(latestEvent, nowMs)
    : null
  if (
    head &&
    (!latestEvent || Date.parse(head.committedAt) > Date.parse(latestEvent.ts))
  ) {
    activity = `committed ${head.sha.slice(0, 7)} · ${head.subject} · ${formatAge(head.committedAt, nowMs)}`
  }

  // Live while an eval is in flight (exp_run_started without a newer event,
  // bounded by the eval timeout) or anything happened in the last 2 minutes.
  const eventMs = latestEvent ? Date.parse(latestEvent.ts) : Number.NaN
  const commitMs = head ? Date.parse(head.committedAt) : Number.NaN
  const lastActivityMs = Math.max(
    Number.isFinite(eventMs) ? eventMs : 0,
    Number.isFinite(commitMs) ? commitMs : 0
  )
  const evalInFlight =
    latestEvent?.type === "exp_run_started" &&
    Number.isFinite(eventMs) &&
    nowMs - eventMs < EVAL_ACTIVE_WINDOW_MS
  const active =
    evalInFlight ||
    (lastActivityMs > 0 && nowMs - lastActivityMs < ACTIVE_WINDOW_MS)

  const { records: outboxRecords } = await readOutbox(root)

  return {
    projectName: basename(root),
    campaignName,
    metricName,
    metricUnit: meta?.metricUnit ?? null,
    metricDirection,
    bestValue,
    activity,
    active,
    rows,
    pendingOutbox: outboxRecords.length,
    syncedCount: records.filter((record) => record.source === "api").length,
  }
}

function frameText(lines: string[], live: boolean) {
  if (!live) return `${lines.join("\n")}\n`
  // Home the cursor, clear each line as it's rewritten, clear the remainder.
  return `${CSI}H${lines.map((line) => `${line}${CSI}K`).join("\n")}\n${CSI}J`
}

/**
 * Live, read-only view of the current repo's research session: tails
 * `.git/onyx/` (events, history, last-run, outbox) and polls git for new
 * commits. With no TTY it prints a single snapshot and exits.
 */
export async function commandListen() {
  const root = await repoRoot()
  await onyxStateDir(root) // ensure .git/onyx exists so fs.watch can attach

  const size = () => ({
    columns: process.stdout.columns ?? 100,
    rows: process.stdout.rows ?? 30,
    nowMs: Date.now(),
  })

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const model = await buildModel(root)
    process.stdout.write(
      frameText(renderFrame(model, { ...size(), color: false }), false)
    )
    return
  }

  let closed = false
  let renderTimer: ReturnType<typeof setTimeout> | null = null
  let lastRenderAt = 0
  let interval: ReturnType<typeof setInterval> | null = null
  let spinnerInterval: ReturnType<typeof setInterval> | null = null
  let watcher: FSWatcher | null = null
  let resolveQuit = () => {}
  let cachedModel: ListenModel | null = null
  let rebuilding = false
  let lastFrame = ""

  const draw = () => {
    if (closed || !cachedModel) return
    const frame = frameText(renderFrame(cachedModel, size()), true)
    // Identical frames (idle, no age changes) skip the terminal write.
    if (frame === lastFrame) return
    lastFrame = frame
    process.stdout.write(frame)
  }

  const render = async () => {
    if (closed || rebuilding) return
    rebuilding = true
    try {
      const model = await buildModel(root)
      cachedModel = model
    } finally {
      rebuilding = false
    }
    draw()
  }

  const requestRender = () => {
    if (closed || renderTimer) return
    const wait = Math.max(0, RENDER_MIN_GAP_MS - (Date.now() - lastRenderAt))
    renderTimer = setTimeout(() => {
      renderTimer = null
      lastRenderAt = Date.now()
      void render().catch(() => {})
    }, wait)
  }

  const onKey = (key: string) => {
    if (key === "q" || key === "Q" || key === "\x03") quit()
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    if (renderTimer) clearTimeout(renderTimer)
    if (interval) clearInterval(interval)
    if (spinnerInterval) clearInterval(spinnerInterval)
    watcher?.close()
    process.stdin.off("data", onKey)
    process.stdout.off("resize", requestRender)
    process.off("SIGINT", quit)
    process.off("SIGTERM", quit)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    // Show the cursor and leave the alternate screen buffer.
    process.stdout.write(`${CSI}?25h${CSI}?1049l`)
  }

  const quit = () => {
    cleanup()
    resolveQuit()
  }

  // Enter the alternate screen buffer and hide the cursor.
  process.stdout.write(`${CSI}?1049h${CSI}?25l${CSI}2J`)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", onKey)
  process.stdout.on("resize", requestRender)
  process.on("SIGINT", quit)
  process.on("SIGTERM", quit)
  process.on("exit", cleanup)

  try {
    watcher = watch(await onyxStateDir(root), requestRender)
  } catch {
    // Interval polling still keeps the view fresh.
  }
  // While idle, rebuild less often — fs.watch still wakes the loop the
  // moment an agent writes to .git/onyx/, so liveness returns instantly.
  let idleTicks = 0
  interval = setInterval(() => {
    if (cachedModel && !cachedModel.active) {
      idleTicks += 1
      if (idleTicks % IDLE_REBUILD_EVERY !== 0) return
    } else {
      idleTicks = 0
    }
    requestRender()
  }, RENDER_INTERVAL_MS)
  // Fast tick redraws the cached model so the activity spinner animates
  // without re-reading files or spawning git between data refreshes. Idle
  // sessions skip it entirely (the static frame can't change between ticks).
  spinnerInterval = setInterval(() => {
    if (cachedModel?.active) draw()
  }, SPINNER_REDRAW_MS)
  requestRender()

  await new Promise<void>((resolve) => {
    resolveQuit = resolve
  })
}
