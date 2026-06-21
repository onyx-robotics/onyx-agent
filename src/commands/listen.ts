import { watch, type FSWatcher } from "node:fs"
import { basename } from "node:path"

import { gitResult, repoRoot } from "../lib/git"
import { onyxStateDir, readState } from "../lib/outbox"
import { campaignStateKey } from "../lib/project"
import {
  getActiveLocalCampaignName,
  listLocalAttempts,
  listLocalExperimentHistory,
  pendingResearchSyncCount,
  researchSyncConflictCount,
} from "../lib/research-db"
import { formatAge, renderFrame, type ListenModel } from "../lib/tui"

const CSI = "\x1b["
const RENDER_INTERVAL_MS = 500
const RENDER_MIN_GAP_MS = 100
// Matches the spinner's frame duration in lib/tui.ts.
const SPINNER_REDRAW_MS = 120
// The session counts as live for 2 minutes after the latest git activity.
const ACTIVE_WINDOW_MS = 2 * 60_000
// While idle, rebuild the model every Nth interval tick (2s instead of 500ms)
// to keep git spawns and file reads minimal on constrained hardware.
const IDLE_REBUILD_EVERY = 4

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
  const campaignName =
    state.activeCampaign ?? (await getActiveLocalCampaignName(root)) ?? null

  const records = await listLocalExperimentHistory(root)
  // Ascending — the most recent experiment renders at the bottom of the
  // table. Copy before sorting/pushing so the cached array stays untouched.
  const rows = (
    campaignName
      ? records.filter((record) => record.campaignName === campaignName)
      : [...records]
  ).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  )

  // Surface measured-but-unlogged runs at the bottom of the table.
  for (const lastRun of await listLocalAttempts(root)) {
    if (
      rows.some((row) => row.runRef === lastRun.runRef) ||
      (campaignName && lastRun.campaignName !== campaignName)
    ) {
      continue
    }
    rows.push({
      schemaVersion: 1,
      source: "local",
      campaignName: lastRun.campaignName,
      runRef: lastRun.runRef,
      baseCommitSha: lastRun.baseCommitSha,
      resultCommitSha: lastRun.resultCommitSha,
      resultRef: lastRun.resultRef,
      gitStatus: undefined,
      status: lastRun.status,
      name: `(unlogged) ${lastRun.resultCommitSha.slice(0, 7)}`,
      description: null,
      primaryMetricName: lastRun.primaryMetricName,
      primaryMetricValue: lastRun.primaryMetricValue,
      metrics: lastRun.metrics,
      agentNotes: lastRun.agentNotes,
      checks: lastRun.checks
        ? {
            status: lastRun.checks.status,
            durationMs: lastRun.checks.durationMs ?? null,
            outputSummary: lastRun.checks.outputSummary ?? null,
          }
        : null,
      durationMs: lastRun.durationMs ?? null,
      outputSummary: lastRun.outputSummary ?? null,
      campaignId: "",
      experimentId: "",
      sessionId: lastRun.sessionId,
      workerId: lastRun.workerId,
      hypothesisId: lastRun.hypothesisId,
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

  // Activity: latest commit on HEAD; research activity comes from SQLite rows.
  const nowMs = Date.now()
  const head = await headCommitInfo(root)
  const activity = head
    ? `committed ${head.sha.slice(0, 7)} · ${head.subject} · ${formatAge(head.committedAt, nowMs)}`
    : null

  // Live while git HEAD activity happened in the last 2 minutes.
  const commitMs = head ? Date.parse(head.committedAt) : Number.NaN
  const active =
    Number.isFinite(commitMs) && nowMs - commitMs < ACTIVE_WINDOW_MS

  const [pendingOutbox, conflictCount] = await Promise.all([
    pendingResearchSyncCount(root),
    researchSyncConflictCount(root),
  ])

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
    pendingOutbox,
    conflictOutbox: conflictCount,
    syncedCount: 0,
  }
}

function frameText(lines: string[], live: boolean) {
  if (!live) return `${lines.join("\n")}\n`
  // Home the cursor, clear each line as it's rewritten, clear the remainder.
  return `${CSI}H${lines.map((line) => `${line}${CSI}K`).join("\n")}\n${CSI}J`
}

/**
 * Live, read-only view of the current repo's research session: tails
 * `.git/onyx/research.db` and polls git for new commits. With no TTY it
 * prints a single snapshot and exits.
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
