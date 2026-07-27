import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  createResearchSessionStopChecker,
  sessionStateBriefControlSignature,
} from "./commands/research"
import { git } from "./lib/git"
import {
  readSupervisorControlStateSnapshot,
  supervisorControlStateIsFresh,
  writeSupervisorControlStateSnapshot,
  type SupervisorControlStateSnapshot,
} from "./lib/supervisor-control-state"

const roots: string[] = []

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "onyx-control-state-"))
  roots.push(root)
  await git(["init"], root)
  return root
}

function snapshot(fetchedAt: string): SupervisorControlStateSnapshot {
  return {
    schemaVersion: 1,
    sequence: 3,
    fetchedAt,
    control: {
      sessionId: "30000000-0000-4000-8000-000000000001",
      campaignStatus: "active",
      runtimeState: "active",
      status: "running",
      finalizationStatus: "running",
      progress: {
        experimentTarget: 50,
        acceptedExperimentCount: 10,
        receivedExperimentCount: 11,
        remainingExperimentCount: 40,
        deadlineAt: null,
        endedAt: null,
        endReason: null,
        terminalReason: null,
      },
      launch: {
        activeWorkerCount: 10,
        workerTarget: 10,
        openWorkerSlotCount: 0,
        activeHypothesisCount: 10,
        acceptingExperiments: true,
      },
      canceledAssignmentIds: ["55000000-0000-4000-8000-000000000001"],
      finalization: {
        status: "running",
        reasons: [],
        terminalReason: null,
      },
      updatedAt: fetchedAt,
    },
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

describe("supervisor control state snapshots", () => {
  test("refreshes full brief context when meaningful control facts change", () => {
    const control = snapshot(new Date().toISOString()).control
    const baseline = sessionStateBriefControlSignature(control)
    expect(
      sessionStateBriefControlSignature({
        ...control,
        canceledAssignmentIds: [...control.canceledAssignmentIds].reverse(),
      })
    ).toBe(baseline)
    expect(
      sessionStateBriefControlSignature({
        ...control,
        progress: {
          ...control.progress,
          acceptedExperimentCount:
            control.progress.acceptedExperimentCount + 1,
        },
      })
    ).not.toBe(baseline)
    expect(
      sessionStateBriefControlSignature({
        ...control,
        launch: {
          ...control.launch,
          activeHypothesisCount: control.launch.activeHypothesisCount + 1,
        },
      })
    ).not.toBe(baseline)
    expect(
      sessionStateBriefControlSignature({
        ...control,
        status: "completed",
        runtimeState: "ended",
      })
    ).not.toBe(baseline)
  })

  test("atomically persists complete control state for worker harnesses", async () => {
    const root = await createRepo()
    const fetchedAt = new Date().toISOString()
    await writeSupervisorControlStateSnapshot({
      root,
      sessionId: "30000000-0000-4000-8000-000000000001",
      snapshot: snapshot(fetchedAt),
    })

    const value = await readSupervisorControlStateSnapshot({
      root,
      sessionId: "30000000-0000-4000-8000-000000000001",
    })
    expect(value.sequence).toBe(3)
    expect(value.control.canceledAssignmentIds).toHaveLength(1)
    expect(supervisorControlStateIsFresh(value, Date.parse(fetchedAt))).toBe(
      true
    )
  })

  test("rejects stale snapshots so workers can fall back to remote control", () => {
    const now = Date.now()
    expect(
      supervisorControlStateIsFresh(
        snapshot(new Date(now - 11_000).toISOString()),
        now
      )
    ).toBe(false)
  })

  test("serves one hundred supervised harnesses without remote polling", async () => {
    const root = await createRepo()
    const fetchedAt = new Date().toISOString()
    await writeSupervisorControlStateSnapshot({
      root,
      sessionId: "30000000-0000-4000-8000-000000000001",
      snapshot: snapshot(fetchedAt),
    })
    const originalFetch = globalThis.fetch
    let remoteCalls = 0
    globalThis.fetch = (async () => {
      remoteCalls += 1
      throw new Error("supervised harness should use local control")
    }) as unknown as typeof fetch
    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          createResearchSessionStopChecker({
            root,
            sessionId: "30000000-0000-4000-8000-000000000001",
            args: { positional: [], options: {} },
            preferLocalSupervisorControl: true,
          }).check({ nowMs: Date.parse(fetchedAt) })
        )
      )
      expect(results.every((result) => result.shouldStop === false)).toBe(true)
      expect(remoteCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back to remote control when the supervisor snapshot is stale", async () => {
    const root = await createRepo()
    const now = Date.now()
    const stale = snapshot(new Date(now - 11_000).toISOString())
    await writeSupervisorControlStateSnapshot({
      root,
      sessionId: stale.control.sessionId,
      snapshot: stale,
    })
    const originalFetch = globalThis.fetch
    const previousApiUrl = process.env.ONYX_API_URL
    const previousApiKey = process.env.ONYX_API_KEY
    let remoteCalls = 0
    process.env.ONYX_API_URL = "https://api.onyx.test"
    process.env.ONYX_API_KEY = "test-key"
    globalThis.fetch = (async () => {
      remoteCalls += 1
      return new Response(
        JSON.stringify({ data: snapshot(new Date(now).toISOString()).control }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    }) as unknown as typeof fetch
    try {
      const result = await createResearchSessionStopChecker({
        root,
        sessionId: stale.control.sessionId,
        args: { positional: [], options: {} },
        preferLocalSupervisorControl: true,
      }).check({ nowMs: now })
      expect(result.shouldStop).toBe(false)
      expect(remoteCalls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      if (previousApiUrl === undefined) delete process.env.ONYX_API_URL
      else process.env.ONYX_API_URL = previousApiUrl
      if (previousApiKey === undefined) delete process.env.ONYX_API_KEY
      else process.env.ONYX_API_KEY = previousApiKey
    }
  })
})
