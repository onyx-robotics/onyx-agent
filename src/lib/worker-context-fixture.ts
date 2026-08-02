import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { WorkerRuntimeContext } from "./worker-context"
import { ONYX_WORKER_CONTEXT_SCHEMA_VERSION } from "./version"

/** Test-only: a complete, valid worker runtime context rooted at `root`. */
export function workerRuntimeContextFixture(
  root: string,
  overrides: Partial<WorkerRuntimeContext> = {}
): WorkerRuntimeContext {
  return {
    schemaVersion: ONYX_WORKER_CONTEXT_SCHEMA_VERSION,
    campaignId: "campaign-id",
    campaignName: "context-campaign",
    sessionId: "session-id",
    assignmentId: "assignment-id",
    startingCommitSha: "a".repeat(40),
    hypothesisId: "hypothesis-id",
    hypothesisName: "context hypothesis",
    campaign: {
      id: "campaign-id",
      name: "context-campaign",
      metricName: "error",
      metricUnit: null,
      metricDirection: "minimize",
      baseCommitSha: null,
    },
    assignment: {
      id: "assignment-id",
      startingCommitSha: "a".repeat(40),
      sourceExperimentId: null,
    },
    hypothesis: {
      id: "hypothesis-id",
      name: "context hypothesis",
      description: null,
      status: "active",
      plan: {
        focus: "Test worker scope",
        statement: "The worker context is the authoritative scope.",
        startingPoints: [],
        avoidList: [],
        successSignals: [],
        giveUpSignals: [],
      },
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      lastWorkedAt: null,
    },
    workerId: "worker-id",
    workerCredential: `owx_worker_v1_${"0".repeat(32)}`,
    workerCliPath: join(root, ".git/onyx/bin/onyx-worker"),
    worktreeRoot: root,
    projectPath: "",
    projectRoot: root,
    setupFile: join(root, "onyx/setup.json"),
    validationFile: join(root, "onyx/validation.json"),
    researchSpecFile: join(root, "onyx/onyx.md"),
    researchDeadlineAt: null,
    shutdownDeadlineAt: null,
    shutdownCushionSeconds: null,
    ...overrides,
  }
}

/** Test-only: write a context fixture to a temp file and return its path. */
export async function writeWorkerRuntimeContextFixture(
  context: WorkerRuntimeContext | Record<string, unknown>
) {
  const dir = await mkdtemp(join(tmpdir(), "onyx-worker-context-"))
  const path = join(dir, "context.json")
  await writeFile(path, JSON.stringify(context, null, 2), "utf8")
  return path
}
