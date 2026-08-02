import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { resolveFreshBaseCommitSha } from "./commands/exp"
import { git } from "./lib/git"
import {
  workerRuntimeContextFixture,
  writeWorkerRuntimeContextFixture,
} from "./lib/worker-context-fixture"

const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT
const roots: string[] = []

afterEach(async () => {
  if (previousWorkerContext === undefined) {
    delete process.env.ONYX_WORKER_CONTEXT
  } else {
    process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function repoWithLineage() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "onyx-lineage-")))
  roots.push(root)
  await git(["init"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Onyx Test"], root)
  await writeFile(join(root, "a.txt"), "a\n", "utf8")
  await git(["add", "."], root)
  await git(["commit", "-m", "base"], root)
  const baseSha = await git(["rev-parse", "HEAD"], root)
  await writeFile(join(root, "b.txt"), "b\n", "utf8")
  await git(["add", "."], root)
  await git(["commit", "-m", "descendant"], root)
  const descendantSha = await git(["rev-parse", "HEAD"], root)
  await git(["checkout", "-q", "-b", "divergent", baseSha], root)
  await writeFile(join(root, "c.txt"), "c\n", "utf8")
  await git(["add", "."], root)
  await git(["commit", "-m", "divergent"], root)
  const divergentSha = await git(["rev-parse", "HEAD"], root)
  return { root, baseSha, descendantSha, divergentSha }
}

const campaignStub = {
  campaignId: "campaign-id",
  hypothesisId: undefined,
  metricName: "error",
  baseCommitSha: "unused",
}

describe("worker base commit lineage", () => {
  test("accepts the assignment starting commit and its descendants", async () => {
    const { root, baseSha, descendantSha } = await repoWithLineage()
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root, {
        startingCommitSha: descendantSha,
        assignment: {
          id: "assignment-id",
          startingCommitSha: baseSha,
          sourceExperimentId: null,
        },
      })
    )
    await git(["checkout", "-q", descendantSha], root)
    const resolved = await resolveFreshBaseCommitSha({
      root,
      args: { positional: [], options: {} },
      campaign: campaignStub,
      context: { workerId: "worker-id" },
    })
    expect(resolved).toBe(descendantSha)
  })

  test("rejects a HEAD that does not descend from the assignment base", async () => {
    const { root, descendantSha, divergentSha } = await repoWithLineage()
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root, {
        startingCommitSha: descendantSha,
        assignment: {
          id: "assignment-id",
          startingCommitSha: descendantSha,
          sourceExperimentId: null,
        },
      })
    )
    await git(["checkout", "-q", divergentSha], root)
    await expect(
      resolveFreshBaseCommitSha({
        root,
        args: { positional: [], options: {} },
        campaign: campaignStub,
        context: { workerId: "worker-id" },
      })
    ).rejects.toThrow("must descend from the assignment starting commit")
  })

  test("rejects an explicit --base off the assignment lineage", async () => {
    const { root, baseSha, descendantSha, divergentSha } =
      await repoWithLineage()
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root, {
        startingCommitSha: descendantSha,
        assignment: {
          id: "assignment-id",
          startingCommitSha: descendantSha,
          sourceExperimentId: null,
        },
      })
    )
    await expect(
      resolveFreshBaseCommitSha({
        root,
        args: { positional: [], options: { base: divergentSha } },
        campaign: campaignStub,
        context: { workerId: "worker-id" },
      })
    ).rejects.toThrow("must descend from the assignment starting commit")
    await expect(
      resolveFreshBaseCommitSha({
        root,
        args: { positional: [], options: { base: baseSha } },
        campaign: campaignStub,
        context: { workerId: "worker-id" },
      })
    ).rejects.toThrow("must descend from the assignment starting commit")
  })
})
