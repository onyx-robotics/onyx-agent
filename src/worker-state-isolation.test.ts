import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  workerRuntimeContextFixture,
  writeWorkerRuntimeContextFixture,
} from "./lib/worker-context-fixture"
import { resolveProjectPath } from "./lib/project"
import { runProcess } from "./lib/process"
import { resolveCampaignNameFromContext } from "./lib/workflow-context"

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

async function tempGitRepo() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "onyx-state-isolation-"))
  )
  roots.push(root)
  await runProcess("git", ["init"], { cwd: root })
  return root
}

describe("supervised worker state isolation", () => {
  test("worker scope ignores poisoned convenience state and never rewrites it", async () => {
    const root = await tempGitRepo()
    const statePath = join(root, ".git", "onyx", "state.json")
    await mkdir(join(root, ".git", "onyx"), { recursive: true })
    const poisoned = JSON.stringify({
      projectPath: "apps/wrong",
      activeCampaign: "wrong-campaign",
      campaigns: {
        "wrong-campaign": { campaignId: "wrong-id", metricName: "wrong" },
      },
    })
    await writeFile(statePath, poisoned, "utf8")
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root)
    )

    const args = { positional: [], options: {} }
    expect(await resolveProjectPath(root, args)).toBe("")
    expect(await resolveCampaignNameFromContext(root, args)).toBe(
      "context-campaign"
    )
    expect(await readFile(statePath, "utf8")).toBe(poisoned)
  })

  test("worker scope survives garbage or absent convenience state", async () => {
    const root = await tempGitRepo()
    const statePath = join(root, ".git", "onyx", "state.json")
    await mkdir(join(root, ".git", "onyx"), { recursive: true })
    await writeFile(statePath, "{{{ not json", "utf8")
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root)
    )

    const args = { positional: [], options: {} }
    expect(await resolveProjectPath(root, args)).toBe("")
    expect(await resolveCampaignNameFromContext(root, args)).toBe(
      "context-campaign"
    )
    expect(await readFile(statePath, "utf8")).toBe("{{{ not json")

    await rm(statePath)
    expect(await resolveProjectPath(root, args)).toBe("")
    expect(await resolveCampaignNameFromContext(root, args)).toBe(
      "context-campaign"
    )
  })
})
