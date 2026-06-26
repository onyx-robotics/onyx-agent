import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { commandResearchShouldStop } from "./commands/research"
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

function remoteState(overrides: Record<string, unknown> = {}) {
  return {
    session: remoteSession(overrides),
    campaign: { id: "campaign_123", name: "smoke" },
    latestExperiments: [],
    bestExperiment: null,
    hypotheses: [],
    workers: [],
    summaries: [],
    knowledge: [],
    updatedAt: new Date().toISOString(),
  }
}

function remoteLive(overrides: Record<string, unknown> = {}) {
  return {
    session: remoteSession(),
    campaign: { id: "campaign_123", name: "smoke" },
    budget: {
      maxExperiments: 2,
      reservedCount: 1,
      terminalCount: 1,
      remainingCount: 0,
      openReservationCount: 0,
      expiredReservationCount: 1,
      ...overrides,
    },
    livenessCounts: {},
    phaseCounts: {},
    workers: [],
    sites: [],
    unmatchedPresenceCount: 0,
    ignoredPresence: {},
    syncLagMs: null,
    providerBackoff: null,
    recentExperiments: [],
    recentTerminalWorkers: [],
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
        (path) =>
          path.endsWith("/live")
            ? remoteLive()
            : remoteState({ status: "completed" }),
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
})
