// Pure rendering helpers shared by `onyx exp list` and `onyx listen`.
// Everything is string-in/string-out (no I/O, no terminal state) so layout
// stays unit-testable; commands/listen.ts owns the actual terminal lifecycle.
// Column set and status vocabulary mirror the web app's tree view
// (apps/web/components/views/tree-view.tsx) so both surfaces read the same.

import type { LocalResearchHistoryRecord } from "../protocol"

const CSI = "\x1b["

function paint(code: string, text: string, color: boolean) {
  return color ? `${CSI}${code}m${text}${CSI}0m` : text
}

export const dim = (text: string, color: boolean) => paint("2", text, color)
export const bold = (text: string, color: boolean) => paint("1", text, color)
export const green = (text: string, color: boolean) => paint("32", text, color)
export const red = (text: string, color: boolean) => paint("31", text, color)
export const yellow = (text: string, color: boolean) => paint("33", text, color)
export const cyan = (text: string, color: boolean) => paint("36", text, color)

/** Strips ANSI color/style sequences (for length math and tests). */
export function stripAnsi(text: string) {
  // eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
  return text.replaceAll(/\x1b\[\d+m/g, "")
}

/** Truncates by visible length, passing ANSI sequences through untouched. */
export function truncateAnsi(line: string, width: number) {
  if (stripAnsi(line).length <= width) return line
  let visible = 0
  let out = ""
  let i = 0
  while (i < line.length && visible < width - 1) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i)
      if (end === -1) break
      out += line.slice(i, end + 1)
      i = end + 1
      continue
    }
    out += line[i]
    visible += 1
    i += 1
  }
  return `${out}…${CSI}0m`
}

/** Truncates to width, appending an ellipsis when text was cut. */
export function truncate(text: string, width: number) {
  if (width <= 0) return ""
  if (text.length <= width) return text
  if (width === 1) return "…"
  return `${text.slice(0, width - 1)}…`
}

/** Pads (and truncates) to an exact width. */
export function pad(
  text: string,
  width: number,
  align: "left" | "right" = "left"
) {
  const cut = truncate(text, width)
  const fill = " ".repeat(width - cut.length)
  return align === "left" ? `${cut}${fill}` : `${fill}${cut}`
}

/** Compact relative age: now, 42s, 5m, 2h, 3d. */
export function formatAge(iso: string | null | undefined, nowMs: number) {
  if (!iso) return "—"
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return "—"
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000))
  if (seconds < 5) return "now"
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function formatMetricValue(value: number | null | undefined) {
  if (value === null || value === undefined) return "—"
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

/** `name=value`, truncating the name (never the value) to fit the width. */
export function formatMetricCell(
  name: string,
  value: number | null | undefined,
  width: number
) {
  if (value === null || value === undefined) return "—"
  const formatted = formatMetricValue(value)
  const full = `${name}=${formatted}`
  if (full.length <= width) return full
  return `${truncate(name, Math.max(1, width - formatted.length - 1))}=${formatted}`
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** `MM-DD HH:mm:ss` — the web tree view's created column, plus seconds. */
export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Duration formatting matching the web tree view. */
export function formatDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  nowMs: number
) {
  if (!startedAt) return "—"
  const start = Date.parse(startedAt)
  if (!Number.isFinite(start)) return "—"
  const end = completedAt ? Date.parse(completedAt) : nowMs
  const totalSec = Math.max(0, (end - start) / 1000)
  if (totalSec < 60) return `${totalSec.toFixed(4)}s`
  const totalMin = Math.floor(totalSec / 60)
  const s = (totalSec - totalMin * 60).toFixed(4)
  if (totalMin < 60) return `${totalMin}m ${s}s`
  const h = Math.floor(totalMin / 60)
  const remM = totalMin % 60
  return `${h}h ${remM}m ${s}s`
}

// Status glyphs and labels mirror glyphFor() in the web tree view.
type StatusGlyph = {
  char: string
  label: string
  colorize: (text: string, color: boolean) => string
}

export function glyphFor(status: string): StatusGlyph {
  if (status === "running")
    return { char: "◦", label: "running", colorize: dim }
  if (status === "queued") return { char: "·", label: "queued", colorize: dim }
  if (status === "failed") return { char: "✗", label: "failed", colorize: red }
  if (status === "checks_failed")
    return { char: "!", label: "checks", colorize: yellow }
  if (status === "rejected")
    return { char: "!", label: "rejected", colorize: yellow }
  return { char: "•", label: "ok", colorize: green }
}

export type ExperimentRow = Pick<
  LocalResearchHistoryRecord,
  | "campaignName"
  | "name"
  | "status"
  | "resultCommitSha"
  | "primaryMetricName"
  | "primaryMetricValue"
  | "createdAt"
> & {
  source?: "local" | "api"
  description?: string | null
  startedAt?: string | null
  completedAt?: string | null
}

const GLYPH_W = 1
const COMMIT_W = 8
const CAMPAIGN_W = 18
const METRIC_W = 10
const CREATED_W = 14
const DURATION_W = 14
const STATUS_W = 8
// Extra breathing room between the metric and created columns.
const METRIC_GAP = "  "

/**
 * Renders the tree-view experiment table as aligned plain lines:
 * glyph · commit · campaign · name · description · metric · created · duration · status.
 * Description and duration columns drop out on narrow widths. Cells are
 * padded before color is applied so ANSI codes never skew alignment.
 */
export function renderExperimentTable(
  rows: ExperimentRow[],
  options: {
    columns: number
    color: boolean
    nowMs: number
    showCampaign?: boolean
  }
): string[] {
  const { columns, color, nowMs } = options
  const showCampaign = options.showCampaign ?? false
  const showDescription = columns >= 90
  const showDuration = columns >= 110

  let fixed =
    GLYPH_W + COMMIT_W + METRIC_W + METRIC_GAP.length + CREATED_W + STATUS_W + 5 // gaps for base cols
  if (showCampaign) fixed += CAMPAIGN_W + 1
  if (showDuration) fixed += DURATION_W + 1
  const flex = Math.max(showDescription ? 24 : 12, columns - fixed)
  const nameWidth = showDescription ? Math.ceil(flex / 2) : flex
  const descWidth = showDescription ? flex - nameWidth - 1 : 0

  const cells = (parts: (string | null)[]) =>
    parts.filter((part): part is string => part !== null).join(" ")

  const header = cells([
    " ".repeat(GLYPH_W),
    pad("COMMIT", COMMIT_W),
    showCampaign ? pad("CAMPAIGN", CAMPAIGN_W) : null,
    pad("NAME", nameWidth),
    showDescription ? pad("DESCRIPTION", descWidth) : null,
    `${pad("METRIC", METRIC_W, "right")}${METRIC_GAP}`,
    pad("CREATED", CREATED_W, "right"),
    showDuration ? pad("DURATION", DURATION_W, "right") : null,
    pad("STATUS", STATUS_W, "right"),
  ])

  const lines = [dim(truncate(header, columns), color)]
  for (const row of rows) {
    const glyph = glyphFor(row.status)
    const commit =
      "resultCommitSha" in row ? String(row.resultCommitSha).slice(0, 7) : "·"
    const statusPadded = pad(glyph.label, STATUS_W, "right")
    lines.push(
      truncateAnsi(
        cells([
          glyph.colorize(glyph.char, color),
          dim(pad(commit, COMMIT_W), color),
          showCampaign ? pad(row.campaignName, CAMPAIGN_W) : null,
          pad(row.name, nameWidth),
          showDescription
            ? dim(pad(row.description?.trim() || "—", descWidth), color)
            : null,
          `${pad(formatMetricValue(row.primaryMetricValue), METRIC_W, "right")}${METRIC_GAP}`,
          dim(pad(formatDateTime(row.createdAt), CREATED_W, "right"), color),
          showDuration
            ? dim(
                pad(
                  formatDuration(row.startedAt, row.completedAt, nowMs),
                  DURATION_W,
                  "right"
                ),
                color
              )
            : null,
          statusPadded.replace(glyph.label, glyph.colorize(glyph.label, color)),
        ]),
        columns
      )
    )
  }
  return lines
}

// Braille square (⣿) with one border dot removed per frame; the gap orbits
// the square clockwise (top-left → top-right → down the right side → bottom
// → up the left side). A terminal cell renders in a single color, so the
// "lit" element is the moving notch in the otherwise-grey square.
const SPINNER_FRAMES = ["⣾", "⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽"]
const SPINNER_TICK_MS = 120

/** Deterministic spinner frame for a timestamp (pure — testable). */
export function spinnerChar(nowMs: number) {
  return SPINNER_FRAMES[
    Math.floor(nowMs / SPINNER_TICK_MS) % SPINNER_FRAMES.length
  ]!
}

export type ListenModel = {
  projectName: string | null
  campaignName: string | null
  sessionId?: string | null
  sessionStatus?: string | null
  metricName: string | null
  metricUnit: string | null
  metricDirection: "maximize" | "minimize" | null
  bestValue: number | null
  activity: string | null
  /** True while an agent session is live — animates the activity spinner. */
  active: boolean
  /** Ascending by recency — the most recent experiment renders at the bottom. */
  rows: ExperimentRow[]
  pendingOutbox: number
  conflictOutbox: number
  syncedCount: number
  providerBackoff?: {
    reason: string
    until: string
    attempt?: number
    delayMs?: number
  } | null
  workers?: ListenWorkerRow[]
}

export type ListenWorkerRow = {
  workerId: string
  workerName: string | null
  hypothesisName: string | null
  status: string
  phase: string | null
  progressMessage: string | null
  latestAt: string | null
  lastSeenAt: string | null
  lastOutputAt: string | null
  startedAt: string | null
  completedAt: string | null
  finalizationStatus: string | null
  activityLogPath: string | null
  logPath: string | null
}

function workerIsTerminal(status: string) {
  return status === "completed" || status === "failed" || status === "stopped"
}

function renderWorkerPanel(
  model: ListenModel,
  options: { columns: number; color: boolean; nowMs: number }
) {
  const workers = model.workers ?? []
  if (!model.sessionId && workers.length === 0 && !model.providerBackoff) {
    return []
  }

  const active = workers.filter((worker) => !workerIsTerminal(worker.status))
  const terminal = workers.length - active.length
  const backoff = model.providerBackoff
    ? ` · backoff ${model.providerBackoff.reason} ${formatAge(
        model.providerBackoff.until,
        options.nowMs
      )}`
    : ""
  const summary = truncate(
    [
      `session ${model.sessionStatus ?? model.sessionId ?? "local"}`,
      `workers ${active.length}/${workers.length}`,
      terminal ? `terminal ${terminal}` : null,
    ]
      .filter(Boolean)
      .join(" · ") + backoff,
    options.columns
  )
  const lines = [bold(summary, options.color)]

  for (const worker of workers.slice(0, 8)) {
    const activityAt =
      worker.latestAt ??
      worker.lastOutputAt ??
      worker.lastSeenAt ??
      worker.completedAt ??
      worker.startedAt
    const name = worker.workerName ?? worker.workerId.slice(0, 8)
    const phase = worker.phase ? ` phase=${worker.phase}` : ""
    const finalization = worker.finalizationStatus
      ? ` final=${worker.finalizationStatus}`
      : ""
    const age = formatAge(activityAt, options.nowMs)
    const logPath = worker.activityLogPath ?? worker.logPath
    const detail = [
      worker.progressMessage ?? worker.hypothesisName,
      logPath ? `activity=${logPath}` : null,
    ]
      .filter(Boolean)
      .join(" · ")
    lines.push(
      truncate(
        `  ${name}: ${worker.status}${phase}${finalization} seen=${age}${
          detail ? ` · ${detail}` : ""
        }`,
        options.columns
      )
    )
  }

  return lines
}

/**
 * Composes the full `onyx listen` frame as plain lines (no cursor control —
 * commands/listen.ts adds per-line clears): a rounded box around the
 * experiment table, the `ONYX | repo | campaign` title interrupting the top
 * border on the left (best metric on the right), with the activity line and
 * sync footer below the box. Clipped to the terminal size.
 */
export function renderFrame(
  model: ListenModel,
  size: { columns: number; rows: number; nowMs: number; color?: boolean }
): string[] {
  const columns = Math.max(40, size.columns)
  const color = size.color ?? true
  const inner = columns - 4

  // Top border: ╭─ ONYX | repo | branch ───────── best ─╮
  const best =
    model.bestValue !== null && model.metricName
      ? `best ${formatMetricValue(model.bestValue)} ${
          model.metricDirection === "minimize" ? "↓" : "↑"
        } ${model.metricName}${model.metricUnit ? ` ${model.metricUnit}` : ""}`
      : ""
  const title = truncate(
    `ONYX | ${model.projectName ?? "(unlinked)"} | ${model.campaignName ?? "(no campaign)"}`,
    Math.max(8, columns - best.length - 12)
  )
  const fill = Math.max(
    1,
    columns - 3 - title.length - 2 - (best ? best.length + 4 : 1)
  )
  const top = `${dim("╭─ ", color)}${bold(title, color)}${dim(
    ` ${"─".repeat(fill)}${best ? `─ ${best} ─` : "─"}╮`,
    color
  )}`

  const boxLine = (line: string) => {
    const padding = " ".repeat(Math.max(0, inner - stripAnsi(line).length))
    return `${dim("│ ", color)}${line}${padding}${dim(" │", color)}`
  }

  const workerLines = renderWorkerPanel(model, {
    columns: inner,
    color,
    nowMs: size.nowMs,
  })
  // Newest at the bottom: keep the tail when the table outgrows the screen.
  const tableRows = Math.max(1, size.rows - 8 - workerLines.length)
  const table = renderExperimentTable(model.rows.slice(-tableRows), {
    columns: inner,
    color,
    nowMs: size.nowMs,
  })
  const tableBody =
    model.rows.length === 0
      ? [table[0]!, dim("no experiments yet", color)]
      : table
  const body =
    workerLines.length > 0
      ? [...workerLines, dim("─".repeat(Math.min(inner, 24)), color), ...tableBody]
      : tableBody

  const bottom = dim(`╰${"─".repeat(columns - 2)}╯`, color)

  // The notch orbits only while an agent is live; idle shows the full square.
  const spinner = model.active ? spinnerChar(size.nowMs) : "⣿"
  const activity = ` ${dim(spinner, color)} ${truncate(
    `Research Agent: ${model.activity ?? "waiting for activity…"}`,
    columns - 4
  )}`
  const footer = dim(
    truncate(
      ` outbox ${model.pendingOutbox} pending · ${model.conflictOutbox} conflict(s) · ${model.syncedCount} synced · q quit`,
      columns
    ),
    color
  )

  // Blank line above the box; blank box line below the title border; blank
  // line above the footer.
  return [
    "",
    top,
    boxLine(""),
    ...body.map(boxLine),
    bottom,
    activity,
    "",
    footer,
  ]
}
