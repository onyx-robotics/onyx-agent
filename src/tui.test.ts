import { describe, expect, test } from "bun:test"

import {
  buildSlotRows,
  renderFocusFrame,
  renderFrame,
  stripAnsi,
  type ListenModel,
  type ListenWorkerRow,
} from "./lib/tui"

import { lowestFreeSlot } from "./lib/worker-launcher"

function workerRow(overrides: Partial<ListenWorkerRow>): ListenWorkerRow {
  return {
    workerId: "worker_1",
    workerName: "worker-1",
    hypothesisName: "Cache tune",
    status: "running",
    phase: "measuring",
    progressMessage: null,
    trace: "eval tool run 3",
    slotIndex: 1,
    latestAt: "2026-07-04T12:00:00.000Z",
    lastSeenAt: null,
    lastOutputAt: null,
    startedAt: "2026-07-04T11:59:00.000Z",
    completedAt: null,
    finalizationStatus: null,
    activityLogPath: "/tmp/activity.log",
    logPath: "/tmp/raw.log",
    ...overrides,
  }
}

function model(overrides: Partial<ListenModel>): ListenModel {
  return {
    projectName: "repo",
    campaignName: "smoke",
    sessionId: "session_1",
    sessionStatus: "running",
    metricName: "score",
    metricUnit: null,
    metricDirection: "maximize",
    bestValue: null,
    activity: null,
    active: true,
    rows: [],
    workers: [],
    workerTarget: null,
    ...overrides,
  }
}

const size = { columns: 100, rows: 30, nowMs: Date.parse("2026-07-04T12:00:30.000Z") }

describe("slot rows", () => {
  test("lowestFreeSlot fills gaps before extending", () => {
    expect(lowestFreeSlot([])).toBe(1)
    expect(lowestFreeSlot([1, 2, 3])).toBe(4)
    expect(lowestFreeSlot([1, 3])).toBe(2)
  })

  test("slots stay positionally stable and idle slots render", () => {
    const rows = buildSlotRows(
      model({
        workerTarget: 3,
        workers: [
          workerRow({ workerId: "a", workerName: "w-a", slotIndex: 2 }),
          // Slot 2's previous, terminal occupant loses to the live one.
          workerRow({
            workerId: "old",
            workerName: "w-old",
            slotIndex: 2,
            status: "stopped",
            completedAt: "2026-07-04T11:58:00.000Z",
          }),
          // Pre-slot manifests append after the slot rows.
          workerRow({ workerId: "b", workerName: "w-b", slotIndex: null }),
        ],
      })
    )

    expect(rows.map((row) => row.slotIndex)).toEqual([1, 2, 3, null])
    expect(rows[0]!.worker).toBeNull()
    expect(rows[1]!.worker?.workerName).toBe("w-a")
    expect(rows[3]!.worker?.workerName).toBe("w-b")
  })

  test("selected slot is marked in the frame", () => {
    const lines = renderFrame(
      model({
        workerTarget: 2,
        workers: [workerRow({})],
      }),
      { ...size, color: false, selectedSlot: 1 }
    ).map(stripAnsi)
    const row = lines.find((line) => line.includes("worker-1"))
    expect(row).toContain("▸ 1 worker-1 · Cache tune · running measuring")
    expect(lines.some((line) => line.includes("2 idle"))).toBe(true)
    expect(lines.join("\n")).toContain("↑↓/1-8 select · → focus")
  })
})

describe("focus frame", () => {
  test("renders worker identity and the activity tail", () => {
    const lines = renderFocusFrame(
      model({}),
      {
        slotIndex: 1,
        worker: workerRow({}),
        logLines: ["line one", "line two"],
      },
      { ...size, color: false }
    ).map(stripAnsi)
    const text = lines.join("\n")
    expect(text).toContain("ONYX | slot 1 | worker-1")
    expect(text).toContain("Cache tune · running measuring · seen 30s")
    expect(text).toContain("line one")
    expect(text).toContain("line two")
    expect(text).toContain("← back · q quit")
  })

  test("clips the log tail to the terminal height, newest last", () => {
    const logLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
    const lines = renderFocusFrame(
      model({}),
      { slotIndex: 2, worker: workerRow({}), logLines },
      { ...size, rows: 20, color: false }
    ).map(stripAnsi)
    const text = lines.join("\n")
    expect(text).not.toContain("line 1\n")
    expect(text).toContain("line 60")
    expect(lines.length).toBeLessThanOrEqual(20)
  })
})
