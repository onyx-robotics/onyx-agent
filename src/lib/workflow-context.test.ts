import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  resolveCampaignNameFromContext,
  resolveWorkerWorkflowContext,
} from "./workflow-context"

const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT

function workerContextFixture() {
  return {
    schemaVersion: 6,
    campaignId: "campaign-id-1",
    campaignName: "context-campaign",
    sessionId: "session-ctx",
    assignmentId: "assignment-ctx",
    startingCommitSha: "a".repeat(40),
    hypothesisId: "hypothesis-ctx",
    hypothesisName: "context hypothesis",
    assignment: {
      id: "assignment-ctx",
      startingCommitSha: "a".repeat(40),
      sourceExperimentId: null,
    },
    hypothesis: {
      id: "hypothesis-ctx",
      name: "context hypothesis",
      description: null,
      status: "active",
      plan: { summary: "do the thing", steps: [] },
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      lastWorkedAt: null,
    },
    workerId: "worker-ctx",
    workerCredential: `owx_worker_v1_${"0".repeat(32)}`,
    worktreeRoot: "/tmp/worktree",
    projectPath: "",
    projectRoot: "/tmp/worktree",
    setupFile: "/tmp/worktree/onyx/setup.json",
    validationFile: "/tmp/worktree/onyx/validation.json",
    researchSpecFile: "/tmp/worktree/onyx/onyx.md",
    researchDeadlineAt: "2026-08-02T12:00:00.000Z",
    shutdownDeadlineAt: "2026-08-02T12:01:30.000Z",
    shutdownCushionSeconds: 90,
  }
}

async function writeContextFile(context: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "onyx-workflow-context-"))
  const path = join(dir, "context.json")
  await writeFile(path, JSON.stringify(context, null, 2), "utf8")
  return path
}

afterEach(() => {
  if (previousWorkerContext === undefined) {
    delete process.env.ONYX_WORKER_CONTEXT
  } else {
    process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
  }
})

describe("worker workflow context resolution", () => {
  test("defaults session, worker, and hypothesis from the worker runtime context", async () => {
    process.env.ONYX_WORKER_CONTEXT = await writeContextFile(
      workerContextFixture()
    )
    const context = await resolveWorkerWorkflowContext({
      positional: [],
      options: {},
    })
    expect(context.sessionId).toBe("session-ctx")
    expect(context.workerId).toBe("worker-ctx")
    expect(context.hypothesisId).toBe("hypothesis-ctx")
  })

  test("explicit flags win over the worker runtime context", async () => {
    process.env.ONYX_WORKER_CONTEXT = await writeContextFile(
      workerContextFixture()
    )
    const context = await resolveWorkerWorkflowContext({
      positional: [],
      options: {
        session: "session-ctx",
        worker: "worker-ctx",
        hypothesis: "hypothesis-ctx",
      },
    })
    expect(context.sessionId).toBe("session-ctx")
    expect(context.workerId).toBe("worker-ctx")
    expect(context.hypothesisId).toBe("hypothesis-ctx")
  })

  test("returns no identity outside a worker runtime", async () => {
    delete process.env.ONYX_WORKER_CONTEXT
    const context = await resolveWorkerWorkflowContext({
      positional: [],
      options: {},
    })
    expect(context.sessionId).toBeUndefined()
    expect(context.workerId).toBeUndefined()
    expect(context.hypothesisId).toBeUndefined()
  })

  test("campaign name resolves from the worker runtime context before local state", async () => {
    process.env.ONYX_WORKER_CONTEXT = await writeContextFile(
      workerContextFixture()
    )
    const dir = await mkdtemp(join(tmpdir(), "onyx-campaign-root-"))
    const campaignName = await resolveCampaignNameFromContext(dir, {
      positional: [],
      options: {},
    })
    expect(campaignName).toBe("context-campaign")
  })
})
