import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { Args } from "./args"
import { runProcess } from "./process"
import {
  workerRuntimeContextFixture,
  writeWorkerRuntimeContextFixture,
} from "./worker-context-fixture"
import { resolveWorkerScope } from "./worker-context"

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

async function tempGitRepo(prefix = "onyx-worker-scope-") {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  await runProcess("git", ["init"], { cwd: root })
  return root
}

function argsWith(options: Record<string, string>): Args {
  return { positional: [], options }
}

describe("resolveWorkerScope", () => {
  test("returns null outside a worker runtime", async () => {
    delete process.env.ONYX_WORKER_CONTEXT
    expect(await resolveWorkerScope(argsWith({}))).toBeNull()
  })

  test("injects context scope into unset args", async () => {
    const root = await tempGitRepo()
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root)
    )
    const args = argsWith({ cwd: root })
    const context = await resolveWorkerScope(args)
    expect(context?.campaignName).toBe("context-campaign")
    expect(args.options.campaign).toBe("context-campaign")
    expect(args.options.session).toBe("session-id")
    expect(args.options.assignment).toBe("assignment-id")
    expect(args.options.hypothesis).toBe("hypothesis-id")
    expect(args.options.worker).toBe("worker-id")
    expect(args.options["project-path"]).toBe("")
    expect(args.options.cwd).toBe(root)
  })

  test("rejects --project in a supervised worker context", async () => {
    const root = await tempGitRepo()
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root)
    )
    await expect(
      resolveWorkerScope(argsWith({ cwd: root, project: "some-project" }))
    ).rejects.toThrow("--project is not allowed")
  })

  test("rejects --assignment conflicting with the context assignment", async () => {
    const root = await tempGitRepo()
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root)
    )
    await expect(
      resolveWorkerScope(argsWith({ cwd: root, assignment: "other" }))
    ).rejects.toThrow(
      "--assignment conflicts with supervised worker context assignment assignment-id"
    )
  })

  test("accepts --project-path . when the context project path is empty", async () => {
    const root = await tempGitRepo()
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root)
    )
    const args = argsWith({ cwd: root, "project-path": "." })
    await resolveWorkerScope(args)
    expect(args.options["project-path"]).toBe(".")
  })

  test("rejects a conflicting --project-path", async () => {
    const root = await tempGitRepo()
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root)
    )
    await expect(
      resolveWorkerScope(argsWith({ cwd: root, "project-path": "apps/other" }))
    ).rejects.toThrow("--project-path conflicts")
  })

  test("rejects a cwd inside a different git checkout", async () => {
    const root = await tempGitRepo()
    const other = await tempGitRepo("onyx-worker-scope-other-")
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root)
    )
    await expect(
      resolveWorkerScope(argsWith({ cwd: other }))
    ).rejects.toThrow(`scoped to worktree ${root}`)
  })

  test("rejects a cwd outside the project scope in a monorepo worktree", async () => {
    const root = await tempGitRepo()
    await mkdir(join(root, "apps/ml"), { recursive: true })
    await mkdir(join(root, "apps/web"), { recursive: true })
    process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
      workerRuntimeContextFixture(root, {
        projectPath: "apps/ml",
        projectRoot: join(root, "apps/ml"),
      })
    )
    await expect(
      resolveWorkerScope(argsWith({ cwd: join(root, "apps/web") }))
    ).rejects.toThrow("scoped to project root")
    const args = argsWith({ cwd: join(root, "apps/ml") })
    await resolveWorkerScope(args)
    expect(args.options["project-path"]).toBe("apps/ml")
  })

  test("a set ONYX_WORKER_CONTEXT with a missing file is a hard error", async () => {
    process.env.ONYX_WORKER_CONTEXT = join(
      tmpdir(),
      "onyx-worker-scope-missing",
      "context.json"
    )
    await expect(resolveWorkerScope(argsWith({}))).rejects.toThrow(
      "missing or unreadable"
    )
  })
})
