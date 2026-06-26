import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  commandResearchShouldStop,
  createResearchSessionStopChecker,
} from "./commands/research"
import { writeState } from "./lib/outbox"
import { runProcess } from "./lib/process"

async function withMockApi(
  handler: (path: string) => unknown,
  run: () => Promise<void>
) {
  const originalFetch = globalThis.fetch
  const previousApiUrl = process.env.ONYX_API_URL
  const previousApiKey = process.env.ONYX_API_KEY
  process.env.ONYX_API_URL = "https://api.onyx.test"
  process.env.ONYX_API_KEY = "test-key"
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input))
    return new Response(JSON.stringify({ data: handler(url.pathname) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
    else process.env.ONYX_API_URL = previousApiUrl
    if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
    else process.env.ONYX_API_KEY = previousApiKey
  }
}

function remoteSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session_123",
    campaignId: "campaign_123",
    name: "session",
    status: "running",
    workerTarget: 1,
    maxExperiments: 2,
    reservedExperimentCount: 1,
    terminalExperimentCount: 1,
    finalizationStatus: "running",
    metadata: {},
    ...overrides,
  }
}

function remoteControlState(overrides: Record<string, unknown> = {}) {
  const session = remoteSession(overrides)
  const maxExperiments =
    typeof session.maxExperiments === "number" ? session.maxExperiments : null
  const reservedCount =
    typeof session.reservedExperimentCount === "number"
      ? session.reservedExperimentCount
      : 0
  const terminalCount =
    typeof session.terminalExperimentCount === "number"
      ? session.terminalExperimentCount
      : 0
  const expiredReservationCount =
    typeof overrides.expiredReservationCount === "number"
      ? overrides.expiredReservationCount
      : 0
  const remainingCount =
    maxExperiments === null
      ? null
      : Math.max(0, maxExperiments - reservedCount - terminalCount)
  const terminalRemainingCount =
    maxExperiments === null ? null : Math.max(0, maxExperiments - terminalCount)
  return {
    sessionId: session.id,
    status: session.status,
    finalizationStatus: session.finalizationStatus,
    budget: {
      maxExperiments,
      reservedCount,
      terminalCount,
      remainingCount,
      terminalRemainingCount,
      budgetSaturated: remainingCount !== null && remainingCount <= 0,
      budgetExhausted:
        terminalRemainingCount !== null && terminalRemainingCount <= 0,
      openReservationCount: reservedCount,
      expiredReservationCount,
    },
    finalization: {
      status: session.finalizationStatus,
      reasons: [],
      terminalReason: null,
      releasedReservationCount: 0,
      expiredReservationCount: 0,
      unmeasuredSalvageCount: 0,
    },
    updatedAt: new Date().toISOString(),
  }
}

afterEach(() => {
  process.exitCode = undefined
})

describe("research should-stop", () => {
  test("continues with a successful JSON response when no stop reason exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-should-stop-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          endTimeMs: Date.now() + 60_000,
          maxIterations: 10,
          status: "running",
        },
      },
    })

    const previousCwd = process.cwd()
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      lines.push(items.join(" "))
    }
    try {
      process.chdir(root)
      await commandResearchShouldStop({
        positional: ["research", "should-stop"],
        options: { session: "session_123", iteration: "1", json: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const payload = JSON.parse(lines.join("\n")) as {
      shouldStop: boolean
      reasonCodes: string[]
      reasons: string[]
    }
    expect(process.exitCode).toBeUndefined()
    expect(payload.shouldStop).toBe(false)
    expect(payload.reasonCodes).toEqual([])
    expect(payload.reasons).toEqual([])
  })

  test("stops when worker shutdown cushion deadline is reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-should-stop-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          endTimeMs: Date.now() + 60_000,
          maxIterations: 10,
          status: "running",
        },
      },
    })

    const previousCwd = process.cwd()
    const previousDeadline = process.env.ONYX_RESEARCH_DEADLINE_AT
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      lines.push(items.join(" "))
    }
    try {
      process.chdir(root)
      process.env.ONYX_RESEARCH_DEADLINE_AT = new Date(
        Date.now() - 1000
      ).toISOString()
      await commandResearchShouldStop({
        positional: ["research", "should-stop"],
        options: { session: "session_123", json: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
      if (previousDeadline === undefined) {
        delete process.env.ONYX_RESEARCH_DEADLINE_AT
      } else {
        process.env.ONYX_RESEARCH_DEADLINE_AT = previousDeadline
      }
    }

    const payload = JSON.parse(lines.join("\n")) as {
      shouldStop: boolean
      reasonCodes: string[]
      reasons: string[]
    }
    expect(process.exitCode).toBeUndefined()
    expect(payload.shouldStop).toBe(true)
    expect(payload.reasonCodes).toContain("deadline_reached")
    expect(payload.reasons).toContain("worker shutdown cushion reached")
  })

  test("returns stable remote budget, reservation, and terminal reason codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-should-stop-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          endTimeMs: Date.now() + 60_000,
          maxIterations: 10,
          status: "running",
        },
      },
    })

    const previousCwd = process.cwd()
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      lines.push(items.join(" "))
    }
    try {
      process.chdir(root)
      await withMockApi(
        () =>
          remoteControlState({
            reservedExperimentCount: 0,
            terminalExperimentCount: 2,
            status: "completed",
            expiredReservationCount: 1,
          }),
        () =>
          commandResearchShouldStop({
            positional: ["research", "should-stop"],
            options: { session: "session_123", json: "true" },
          })
      )
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const payload = JSON.parse(lines.join("\n")) as {
      shouldStop: boolean
      reasonCodes: string[]
    }
    expect(payload.shouldStop).toBe(true)
    expect(payload.reasonCodes).toContain("budget_exhausted")
    expect(payload.reasonCodes).toContain("reservation_expired")
    expect(payload.reasonCodes).toContain("session_terminal")
  })

  test("shared session stop checker stops supervisor launches on budget exhaustion", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-should-stop-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          endTimeMs: Date.now() + 60_000,
          maxExperiments: 2,
          status: "running",
        },
      },
    })

    await withMockApi(
      () =>
        remoteControlState({
          reservedExperimentCount: 0,
          terminalExperimentCount: 2,
          expiredReservationCount: 0,
        }),
      async () => {
        const checker = createResearchSessionStopChecker({
          root,
          sessionId: "session_123",
          args: { positional: [], options: {} },
        })
        const result = await checker.check()
        expect(result.shouldStop).toBe(true)
        expect(result.reasonCodes).toContain("budget_exhausted")
      }
    )
  })

  test("shared session stop checker caches live budget reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-should-stop-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          endTimeMs: Date.now() + 60_000,
          maxExperiments: 3,
          status: "running",
        },
      },
    })
    let controlStateCalls = 0

    await withMockApi(
      (path) => {
        if (path.endsWith("/control-state")) {
          controlStateCalls += 1
          return remoteControlState({
            maxExperiments: 3,
            reservedExperimentCount: 0,
            terminalExperimentCount: 0,
            expiredReservationCount: 0,
          })
        }
        throw new Error(`unexpected path ${path}`)
      },
      async () => {
        const checker = createResearchSessionStopChecker({
          root,
          sessionId: "session_123",
          args: { positional: [], options: {} },
          controlStateTtlMs: 5000,
        })
        await checker.check({ nowMs: 10_000 })
        await checker.check({ nowMs: 11_000 })
        expect(controlStateCalls).toBe(1)
      }
    )
  })
})
