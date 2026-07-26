import { watch, type FSWatcher } from "node:fs"
import { open } from "node:fs/promises"
import { basename } from "node:path"

import type { LocalResearchHistoryRecord } from "../protocol"

import { getCampaignOverview, listCampaignExperiments } from "../lib/api"
import type { Args } from "../lib/args"
import { gitResult, repoRoot } from "../lib/git"
import { apiExperimentToHistory } from "../lib/history"
import { onyxStateDir, readState } from "../lib/runtime-state"
import { campaignStateKey } from "../lib/project"
import {
  getActiveLocalCampaignName,
  getLocalSessionState,
  listLocalAttempts,
} from "../lib/research-runtime"
import {
  buildSlotRows,
  formatAge,
  renderFocusFrame,
  renderFrame,
  type ListenModel,
  type ListenWorkerRow,
} from "../lib/tui"
import { readWorkerLatestState } from "../lib/worker-activity"
import { readWorkerLaunchManifests } from "../lib/worker-launcher"

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
// Remote experiment poll cadence: logged experiments live in the Onyx API
// (local files only hold unlogged attempt manifests), so the table refreshes
// from authoritative remote reads — eagerly while live, gently while idle.
const REMOTE_POLL_ACTIVE_MS = 5_000
const REMOTE_POLL_IDLE_MS = 30_000
// Experiments shown are the table tail; cap the pages fetched per refresh.
const REMOTE_FETCH_LIMIT = 200
// A hung fetch must not stall the refresh loop for the default 120s API
// timeout; listen reads are best-effort and retried on the next cadence.
const REMOTE_FETCH_TIMEOUT_MS = 10_000

type RemoteExperimentCache = {
  campaignId: string | null
  rows: LocalResearchHistoryRecord[]
  /** Campaign best value from the overview — the fetched page window
   * can miss the best experiment on large campaigns. */
  bestValue: number | null
  fetchedAt: number
  stale: boolean
}

/**
 * Fetches the campaign's logged experiments and computed best value from the
 * Onyx API. Returns null on any failure (offline, expired key, missing
 * campaign) so the caller keeps rendering the previous rows — listen
 * degrades, it never crashes.
 */
async function fetchRemoteExperiments(
  campaignId: string,
  campaignName: string,
  args: Args
): Promise<{
  rows: LocalResearchHistoryRecord[]
  bestValue: number | null
} | null> {
  try {
    const rows: LocalResearchHistoryRecord[] = []
    const overviewPromise = getCampaignOverview(campaignId, args)
    // The rejection is consumed by the awaited copy below; without this
    // marker an experiments-fetch failure leaves it unhandled.
    overviewPromise.catch(() => {})
    let cursor: string | null = null
    do {
      const page = await listCampaignExperiments(campaignId, args, {
        limit: 100,
        cursor: cursor ?? undefined,
      })
      for (const experiment of page.items) {
        const row = apiExperimentToHistory(
          { id: campaignId, name: campaignName },
          experiment
        )
        if (row) rows.push(row)
      }
      cursor = page.page.nextCursor
    } while (cursor && rows.length < REMOTE_FETCH_LIMIT)
    const overview = await overviewPromise
    return {
      rows,
      bestValue: overview.bestExperiment?.primaryMetricValue ?? null,
    }
  } catch {
    return null
  }
}

// Tail sizes for activity-log reads: one line for slot rows, a screenful for
// the focus pane.
const TRACE_TAIL_BYTES = 4 * 1024
const FOCUS_TAIL_BYTES = 32 * 1024

/** Reads the trailing bytes of a file without loading the whole log. */
async function readFileTail(
  path: string,
  maxBytes: number
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, "r")
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    if (length === 0) return ""
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString("utf8")
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

// Activity-log lines look like `[iso] [stdout] text` (or `[harness iso] text`).
const ACTIVITY_LINE_PREFIX = /^\[[^\]]*\]\s*(?:\[(?:stdout|stderr)\]\s*)?/

/** Event-stream bookkeeping that is not what the model is thinking. */
function isTraceNoise(text: string) {
  return (
    text.startsWith("step: ") ||
    text.startsWith("system: ") ||
    text.startsWith("#") ||
    /^[a-z_.]+$/.test(text) // bare event names, e.g. "item.completed"
  )
}

/**
 * Latest reasoning line of a worker's activity log. Prefers `thought:` lines
 * (the model's own words) over tool/step bookkeeping, which only shows when
 * no thought exists in the tail yet.
 */
async function readTraceLine(path: string | null): Promise<string | null> {
  if (!path) return null
  const tail = await readFileTail(path, TRACE_TAIL_BYTES)
  if (!tail) return null
  const lines = tail.split("\n")
  let fallback: string | null = null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim()
    if (!line) continue
    const text = line.replace(ACTIVITY_LINE_PREFIX, "").trim()
    if (!text) continue
    if (text.startsWith("thought: ")) {
      return text.slice("thought: ".length)
    }
    if (!fallback && !isTraceNoise(text)) fallback = text
  }
  return fallback
}

/** Trailing lines of a worker's activity log for the focus pane. */
async function readFocusLines(path: string | null): Promise<string[]> {
  if (!path) return []
  const tail = await readFileTail(path, FOCUS_TAIL_BYTES)
  if (!tail) return []
  const lines = tail.split("\n").filter((line) => line.trim().length > 0)
  // Drop the first line when the tail window may have cut it mid-line.
  return tail.length >= FOCUS_TAIL_BYTES ? lines.slice(1) : lines
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

async function buildModel(
  root: string,
  remote: Pick<RemoteExperimentCache, "rows" | "bestValue" | "stale">
): Promise<ListenModel> {
  const remoteRows = remote.rows
  const state = await readState(root)
  const campaignName =
    state.activeCampaign ?? (await getActiveLocalCampaignName(root)) ?? null
  const meta = campaignName
    ? state.campaigns?.[campaignStateKey(state.projectPath ?? "", campaignName)]
    : undefined
  const activeSessionId = meta?.sessionId ?? null
  const localSession = activeSessionId
    ? await getLocalSessionState(root, activeSessionId).catch(() => null)
    : null
  const manifests = activeSessionId
    ? await readWorkerLaunchManifests(root, activeSessionId).catch(() => [])
    : []
  const latestByWorker = new Map(
    await Promise.all(
      manifests.map(
        async (manifest) =>
          [manifest.workerId, await readWorkerLatestState(manifest)] as const
      )
    )
  )

  // Logged experiments come from the Onyx API; ascending so the
  // most recent experiment renders at the bottom of the table. Copy before
  // sorting/pushing so the cached array stays untouched.
  const rows = (
    campaignName
      ? remoteRows.filter((record) => record.campaignName === campaignName)
      : [...remoteRows]
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
      sessionId: lastRun.sessionId ?? undefined,
      workerId: lastRun.workerId ?? undefined,
      hypothesisId: lastRun.hypothesisId ?? undefined,
      startedAt: lastRun.startedAt ?? null,
      completedAt: lastRun.completedAt ?? null,
      createdAt: lastRun.createdAt,
    })
  }

  const metricName = meta?.metricName ?? rows[0]?.primaryMetricName ?? null
  const metricDirection = meta?.metricDirection ?? "maximize"
  const measured = rows.filter(
    (row) => row.status === "succeeded" && row.primaryMetricValue !== null
  )
  const computedBest = measured.length
    ? measured.reduce(
        (best, row) =>
          metricDirection === "minimize"
            ? Math.min(best, row.primaryMetricValue as number)
            : Math.max(best, row.primaryMetricValue as number),
        metricDirection === "minimize" ? Infinity : -Infinity
      )
    : null
  // Combine the campaign's computed best (covers experiments beyond the
  // fetched page window) with the locally computed best (covers unlogged
  // attempts the remote read cannot know about).
  const bestCandidates = [computedBest, remote.bestValue].filter(
    (value): value is number => value !== null
  )
  const bestValue = bestCandidates.length
    ? metricDirection === "minimize"
      ? Math.min(...bestCandidates)
      : Math.max(...bestCandidates)
    : null

  // Activity: latest commit on HEAD; research activity comes from remote rows.
  const nowMs = Date.now()
  const head = await headCommitInfo(root)
  const activity = head
    ? `committed ${head.sha.slice(0, 7)} · ${head.subject} · ${formatAge(head.committedAt, nowMs)}`
    : null

  // Live while git HEAD activity happened in the last 2 minutes.
  const commitMs = head ? Date.parse(head.committedAt) : Number.NaN
  const active =
    Number.isFinite(commitMs) && nowMs - commitMs < ACTIVE_WINDOW_MS

  const manifestByWorker = new Map(
    manifests.map((manifest) => [manifest.workerId, manifest])
  )
  const workersById = new Map(
    (localSession?.workers ?? [])
      .filter((worker) => worker.sessionId === activeSessionId)
      .map((worker) => [worker.id, worker])
  )
  const hypothesesById = new Map(
    (localSession?.hypotheses ?? []).map((hypothesis) => [
      hypothesis.id,
      hypothesis,
    ])
  )
  const workerIds = new Set([...workersById.keys(), ...manifestByWorker.keys()])
  const sessionStatus =
    localSession?.session.status ??
    (activeSessionId
      ? (state.sessions?.[activeSessionId]?.status ?? null)
      : null)
  const sessionTerminal =
    sessionStatus !== null &&
    ["completed", "failed", "stopped"].includes(sessionStatus)
  const workers: ListenWorkerRow[] = await Promise.all(
    [...workerIds].map(async (workerId) => {
      const worker = workersById.get(workerId)
      const manifest = manifestByWorker.get(workerId)
      const latest = manifest ? latestByWorker.get(workerId) : null
      const hypothesisName =
        manifest?.hypothesisName ??
        (worker?.hypothesisId
          ? hypothesesById.get(worker.hypothesisId)?.name
          : null) ??
        null
      // A worker killed by the harness never writes a terminal latest-state
      // snapshot — it freezes at "running". The manifest records the real
      // exit, so a terminal manifest wins over stale snapshot status/phase.
      const manifestTerminal = Boolean(
        manifest &&
        (manifest.completedAt !== null ||
          ["completed", "failed", "stopped"].includes(manifest.status))
      )
      const activityLogPath = manifest?.activityLogPath ?? null
      const logPath = manifest?.logPath ?? null
      const trace =
        manifestTerminal || sessionTerminal
          ? null
          : await readTraceLine(activityLogPath ?? logPath)
      return {
        workerId,
        workerName: worker?.workerName ?? manifest?.workerName ?? null,
        hypothesisName,
        status: manifestTerminal
          ? manifest!.status
          : (latest?.status ?? worker?.status ?? manifest?.status ?? "running"),
        phase: manifestTerminal
          ? null
          : (latest?.phase ?? worker?.phase ?? null),
        progressMessage: manifestTerminal
          ? null
          : (latest?.progressMessage ?? worker?.progressMessage ?? null),
        trace,
        slotIndex: manifest?.slotIndex ?? null,
        latestAt: latest?.at ?? null,
        lastSeenAt: worker?.lastSeenAt ?? null,
        lastOutputAt: manifest?.lastOutputAt ?? null,
        startedAt: manifest?.startedAt ?? null,
        completedAt: manifest?.completedAt ?? null,
        attemptDelivery: manifest?.teardown?.attemptDelivery ?? null,
        resultRefPushStatus: manifest?.teardown?.resultRefPushStatus ?? null,
        terminalReasonCode: manifest?.teardown?.reasonCode ?? null,
        worktreeCleanup: manifest?.teardown?.worktreeCleanup ?? null,
        terminalError:
          manifest?.teardown?.error ??
          manifest?.teardown?.resultRefPushError ??
          manifest?.teardown?.providerError ??
          manifest?.error ??
          null,
        activityLogPath,
        logPath,
      }
    })
  )

  return {
    projectName: basename(root),
    campaignName,
    sessionId: activeSessionId,
    sessionStatus,
    metricName,
    metricUnit: meta?.metricUnit ?? null,
    metricDirection,
    bestValue,
    apiStale: remote.stale,
    activity,
    active:
      active ||
      workers.some((worker) =>
        ["registered", "running", "starting"].includes(worker.status)
      ),
    rows,
    providerBackoff: activeSessionId
      ? (state.sessions?.[activeSessionId]?.providerBackoff ?? null)
      : null,
    noProgressBreaker: activeSessionId
      ? (state.sessions?.[activeSessionId]?.supervisor?.noProgressBreaker ??
        null)
      : null,
    workers,
    workerTarget: localSession?.session.workerTarget ?? null,
  }
}

function frameText(lines: string[], live: boolean) {
  if (!live) return `${lines.join("\n")}\n`
  // Home the cursor, clear each line as it's rewritten, clear the remainder.
  return `${CSI}H${lines.map((line) => `${line}${CSI}K`).join("\n")}\n${CSI}J`
}

/**
 * Live, read-only view of the current repo's research session. With no TTY it
 * prints a single snapshot and exits.
 */
export async function commandListen(
  args: Args = { positional: [], options: {} }
) {
  const root = await repoRoot(args.options.cwd)
  await onyxStateDir(root) // ensure .git/onyx exists so fs.watch can attach

  // A user-passed --api-timeout still wins; listen just tightens the default.
  const apiArgs: Args = {
    ...args,
    options: {
      "api-timeout": String(REMOTE_FETCH_TIMEOUT_MS),
      ...args.options,
    },
  }
  const remote: RemoteExperimentCache = {
    campaignId: null,
    rows: [],
    bestValue: null,
    fetchedAt: 0,
    stale: false,
  }
  let remoteFetching = false

  // Refreshes the remote experiment cache when it is stale for the current
  // cadence; resolves once the fetch settles so callers can redraw.
  const refreshRemote = async (activeCadence: boolean) => {
    if (remoteFetching) return false
    const pollMs = activeCadence ? REMOTE_POLL_ACTIVE_MS : REMOTE_POLL_IDLE_MS
    const state = await readState(root)
    const campaignName =
      state.activeCampaign ?? (await getActiveLocalCampaignName(root)) ?? null
    const meta = campaignName
      ? state.campaigns?.[
          campaignStateKey(state.projectPath ?? "", campaignName)
        ]
      : undefined
    const campaignId = meta?.campaignId ?? null

    if (!campaignId || !campaignName) {
      const hadRows = remote.rows.length > 0
      remote.campaignId = null
      remote.rows = []
      remote.bestValue = null
      remote.stale = false
      return hadRows
    }

    if (
      campaignId === remote.campaignId &&
      Date.now() - remote.fetchedAt < pollMs
    ) {
      return false
    }

    remoteFetching = true
    try {
      const fetched = await fetchRemoteExperiments(
        campaignId,
        campaignName,
        apiArgs
      )
      remote.fetchedAt = Date.now()
      if (fetched) {
        remote.campaignId = campaignId
        remote.rows = fetched.rows
        remote.bestValue = fetched.bestValue
        remote.stale = false
        return true
      }
      const wasStale = remote.stale
      remote.stale = true
      return !wasStale
    } finally {
      remoteFetching = false
    }
  }

  const size = () => ({
    columns: process.stdout.columns ?? 100,
    rows: process.stdout.rows ?? 30,
    nowMs: Date.now(),
  })

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    await refreshRemote(true)
    const model = await buildModel(root, remote)
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
  // Slot selection + focus-mode UI state (table is the default view).
  let selectedSlot: number | null = null
  let focusMode = false
  let focusLines: string[] = []

  const slotCount = () => {
    if (!cachedModel) return 0
    return buildSlotRows(cachedModel).reduce(
      (max, row) => Math.max(max, row.slotIndex ?? 0),
      0
    )
  }

  const focusedWorker = () => {
    if (!cachedModel || selectedSlot === null) return null
    return (
      buildSlotRows(cachedModel).find((row) => row.slotIndex === selectedSlot)
        ?.worker ?? null
    )
  }

  const draw = () => {
    if (closed || !cachedModel) return
    const frame = frameText(
      focusMode && selectedSlot !== null
        ? renderFocusFrame(
            cachedModel,
            {
              slotIndex: selectedSlot,
              worker: focusedWorker(),
              logLines: focusLines,
            },
            size()
          )
        : renderFrame(cachedModel, { ...size(), selectedSlot }),
      true
    )
    // Identical frames (idle, no age changes) skip the terminal write.
    if (frame === lastFrame) return
    lastFrame = frame
    process.stdout.write(frame)
  }

  const render = async () => {
    if (closed || rebuilding) return
    rebuilding = true
    try {
      const model = await buildModel(root, remote)
      cachedModel = model
      if (focusMode && selectedSlot !== null) {
        const worker = focusedWorker()
        focusLines = await readFocusLines(
          worker ? (worker.activityLogPath ?? worker.logPath) : null
        )
      }
    } finally {
      rebuilding = false
    }
    draw()
    // Refresh remote experiments on their own cadence; a completed fetch
    // redraws with the new rows.
    void refreshRemote(cachedModel?.active ?? true)
      .then((changed) => {
        if (changed) requestRender()
      })
      .catch(() => {})
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

  const moveSelection = (delta: number) => {
    const count = slotCount()
    if (count === 0) return
    const current = selectedSlot ?? (delta > 0 ? 0 : count + 1)
    selectedSlot = Math.min(count, Math.max(1, current + delta))
    draw()
  }

  const enterFocus = () => {
    if (selectedSlot === null || focusMode) return
    focusMode = true
    focusLines = []
    requestRender()
  }

  const exitFocus = () => {
    if (!focusMode) return
    focusMode = false
    focusLines = []
    draw()
  }

  const onKey = (key: string) => {
    if (key === "q" || key === "Q" || key === "\x03") return quit()
    if (key >= "1" && key <= "8") {
      const slot = Number(key)
      if (slot <= slotCount()) {
        selectedSlot = slot
        if (focusMode) requestRender()
        else draw()
      }
      return
    }
    if (key === "\x1b[A") return moveSelection(-1) // up
    if (key === "\x1b[B") return moveSelection(1) // down
    if (key === "\x1b[C" || key === "\r") return enterFocus() // right / enter
    if (key === "\x1b[D" || key === "\x1b") return exitFocus() // left / esc
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
