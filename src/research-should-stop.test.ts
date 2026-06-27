import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  commandResearchShouldStop,
  createResearchSessionStopChecker,
} from "./commands/research"
import {
  createLocalCampaign,
  createLocalSession,
  stopLocalSession,
} from "./lib/research-db"
import { writeState } from "./lib/outbox"
import { runProcess } from "./lib/process"

const setup = {
  schemaVersion: 2 as const,
  goal: "Improve score",
  projectPath: "",
  scope: {
    editable: ["src"],
    protected: ["onyx/setup.json", "onyx/validation.json", "onyx/onyx.md"],
  },
  metric: {
    name: "score",
    unit: null,
    direction: "maximize" as const,
  },
  resources: {},
  tools: {
    "evaluation.run": {
      command: "bash",
      args: ["onyx/tools/evaluation/run.sh"],
      shell: false,
      cwd: "project" as const,
      env: {},
      resources: [],
      timeoutSeconds: 600,
      leaseTimeoutSeconds: 120,
      outputLimitBytes: 4000,
    },
  },
  workflow: [
    { id: "edit", agent: "Make one scoped code change.", optional: false },
    { id: "evaluate", run: "evaluation.run", metric: true as const, optional: false },
  ],
}

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "onyx-should-stop-"))
  await runProcess("git", ["init"], { cwd: root })
  return root
}

async function captureShouldStop(
  root: string,
  options: Record<string, string>
) {
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
      options,
    })
  } finally {
    process.chdir(previousCwd)
    console.log = originalLog
  }
  return JSON.parse(lines.join("\n")) as {
    shouldStop: boolean
    reasonCodes: string[]
    reasons: string[]
  }
}

afterEach(() => {
  process.exitCode = undefined
})

describe("research should-stop", () => {
  test("continues with a successful JSON response when no stop reason exists", async () => {
    const root = await createRepo()
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          experimentTarget: 10,
          acceptedExperimentCount: 0,
          remainingExperimentCount: 10,
          status: "running",
        },
      },
    })

    const payload = await captureShouldStop(root, {
      session: "session_123",
      json: "true",
    })

    expect(process.exitCode).toBeUndefined()
    expect(payload.shouldStop).toBe(false)
    expect(payload.reasonCodes).toEqual([])
    expect(payload.reasons).toEqual([])
  })

  test("stops when worker shutdown cushion deadline is reached", async () => {
    const root = await createRepo()
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          experimentTarget: 10,
          acceptedExperimentCount: 0,
          remainingExperimentCount: 10,
          status: "running",
        },
      },
    })

    const previousDeadline = process.env.ONYX_RESEARCH_DEADLINE_AT
    try {
      process.env.ONYX_RESEARCH_DEADLINE_AT = new Date(
        Date.now() - 1000
      ).toISOString()
      const payload = await captureShouldStop(root, {
        session: "session_123",
        json: "true",
      })

      expect(process.exitCode).toBeUndefined()
      expect(payload.shouldStop).toBe(true)
      expect(payload.reasonCodes).toContain("deadline_reached")
      expect(payload.reasons).toContain("worker shutdown cushion reached")
    } finally {
      if (previousDeadline === undefined) {
        delete process.env.ONYX_RESEARCH_DEADLINE_AT
      } else {
        process.env.ONYX_RESEARCH_DEADLINE_AT = previousDeadline
      }
    }
  })

  test("stops when local state has an explicit stop request", async () => {
    const root = await createRepo()
    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        session_123: {
          campaignName: "smoke",
          campaignId: "campaign_123",
          experimentTarget: 10,
          acceptedExperimentCount: 0,
          remainingExperimentCount: 10,
          status: "running",
          stopRequested: true,
        },
      },
    })

    const checker = createResearchSessionStopChecker({
      root,
      sessionId: "session_123",
      args: { positional: [], options: {} },
    })
    const result = await checker.check()

    expect(result.shouldStop).toBe(true)
    expect(result.reasonCodes).toContain("stop_requested")
  })

  test("stops when the local ledger marks the experiment target reached", async () => {
    const root = await createRepo()
    const campaign = await createLocalCampaign({
      root,
      name: "smoke",
      description: null,
      projectPath: "",
      baseCommitSha: "base",
      setup,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const { session } = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "session",
      workerTarget: 10,
      experimentTarget: 2,
      deadlineAt: null,
      schedulerSiteId: "site-1",
    })
    await stopLocalSession({
      root,
      sessionId: session.id,
      status: "completed",
      finalizationStatus: "complete",
      terminalReason: "experiment_target_reached",
    })

    await writeState(root, {
      projectPath: "",
      activeCampaign: "smoke",
      sessions: {
        [session.id]: {
          campaignName: "smoke",
          campaignId: campaign.id,
          experimentTarget: 2,
          acceptedExperimentCount: 2,
          remainingExperimentCount: 0,
          status: "completed",
        },
      },
    })

    const payload = await captureShouldStop(root, {
      session: session.id,
      json: "true",
    })

    expect(payload.shouldStop).toBe(true)
    expect(payload.reasonCodes).toContain("experiment_target_reached")
    expect(payload.reasonCodes).toContain("session_terminal")
  })
})
