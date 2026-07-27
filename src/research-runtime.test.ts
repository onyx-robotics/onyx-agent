import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { git } from "./lib/git"
import {
  abandonNonterminalWorkflowRunsForWorker,
  listWorkflowRuns,
  upsertWorkflowRun,
  type LocalWorkflowRun,
  type LocalWorkflowRunStatus,
} from "./lib/research-runtime"

const roots: string[] = []

async function createRepo() {
  const root = await mkdtemp(join(tmpdir(), "onyx-runtime-test-"))
  roots.push(root)
  await git(["init"], root)
  return root
}

function workflowRun(
  id: string,
  status: LocalWorkflowRunStatus
): LocalWorkflowRun {
  const now = new Date().toISOString()
  return {
    id,
    campaignId: "20000000-0000-4000-8000-000000000001",
    campaignName: "smoke",
    projectPath: "",
    runRef: `local/smoke/${id}`,
    baseCommitSha: "a".repeat(40),
    resultCommitSha: status === "succeeded" ? "b".repeat(40) : null,
    resultRef: `refs/onyx/experiments/campaign/${id}`,
    setupHash: "sha256:setup",
    status,
    currentStepIndex: 0,
    metrics: status === "succeeded" ? { score: 1 } : {},
    blockReason: status === "paused" ? "Paused at agent step." : null,
    createdAt: now,
    startedAt: now,
    completedAt: status === "succeeded" ? now : null,
    updatedAt: now,
    sessionId: "30000000-0000-4000-8000-000000000001",
    workerId: "60000000-0000-4000-8000-000000000001",
    hypothesisId: "40000000-0000-4000-8000-000000000001",
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  )
})

describe("worker workflow teardown", () => {
  test("abandons every nonterminal run while preserving terminal evidence", async () => {
    const root = await createRepo()
    for (const [id, status] of [
      ["running", "running"],
      ["paused", "paused"],
      ["blocked", "blocked"],
      ["succeeded", "succeeded"],
    ] as const) {
      await upsertWorkflowRun({ root, run: workflowRun(id, status) })
    }

    const abandoned = await abandonNonterminalWorkflowRunsForWorker({
      root,
      sessionId: "30000000-0000-4000-8000-000000000001",
      workerId: "60000000-0000-4000-8000-000000000001",
      hypothesisId: "40000000-0000-4000-8000-000000000001",
      reason: "Worker teardown: experiment_target_reached",
    })

    expect(abandoned).toHaveLength(3)
    const runs = await listWorkflowRuns(root, { campaignName: "smoke" })
    expect(runs.filter((run) => run.status === "abandoned")).toHaveLength(3)
    expect(runs.find((run) => run.id === "paused")?.blockReason).toContain(
      "experiment_target_reached"
    )
    expect(runs.find((run) => run.id === "succeeded")?.status).toBe("succeeded")
  })
})
