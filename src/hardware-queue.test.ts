import { existsSync } from "node:fs"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { commandExpRun, runHardwareJob } from "./commands/exp"
import { commandToolsRun } from "./commands/tools"
import type { Args } from "./lib/args"
import type { ResearchSetupFile } from "./lib/contract"
import { currentCommit, git } from "./lib/git"
import { createHardwareDispatcher } from "./lib/hardware-dispatcher"
import {
  listLocalAttempts,
  listWorkflowRuns,
  readWorkflowRun,
  type LocalWorkflowRun,
} from "./lib/research-runtime"
import {
  workerRuntimeContextFixture,
  writeWorkerRuntimeContextFixture,
} from "./lib/worker-context-fixture"

const previousWorkerContext = process.env.ONYX_WORKER_CONTEXT
const cleanup: string[] = []

afterEach(async () => {
  if (previousWorkerContext === undefined) {
    delete process.env.ONYX_WORKER_CONTEXT
  } else {
    process.env.ONYX_WORKER_CONTEXT = previousWorkerContext
  }
  process.exitCode = 0
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function quietly<T>(fn: () => Promise<T>) {
  if (process.env.ONYX_TEST_DEBUG === "1") return fn()
  const { log, warn, error } = console
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
    console.warn = warn
    console.error = error
    process.exitCode = 0
  }
}

let currentRoot = ""

/** Command args pinned to the test repository, never the process cwd. */
function args(options: Record<string, string>, positional = ["exp", "run"]) {
  return {
    positional,
    options: { cwd: currentRoot, ...options },
  } satisfies Args
}

async function script(path: string, body: string) {
  await writeFile(path, `#!/bin/sh\nset -e\n${body}\n`, "utf8")
  await chmod(path, 0o755)
}

/**
 * A project with one hardware resource ("rig"), a reset step, a non-hardware
 * build step that fails unless the rig lease is still held, a measured
 * evaluation, and optionally a simulator that rejects src/value.txt = bad.
 */
async function hardwareProject({ withSim }: { withSim: boolean }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "onyx-hwq-")))
  const logDir = await realpath(await mkdtemp(join(tmpdir(), "onyx-hwq-log-")))
  cleanup.push(root, logDir)
  const hwLog = join(logDir, "hardware.log")
  await git(["init", "--quiet"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Onyx Test"], root)
  await mkdir(join(root, "onyx", "tools"), { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await mkdir(join(root, "sim"), { recursive: true })
  await writeFile(join(root, "src", "value.txt"), "base\n", "utf8")
  await writeFile(join(root, "onyx", "onyx.md"), "# spec\n", "utf8")
  await writeFile(join(root, ".gitignore"), "", "utf8")
  await script(
    join(root, "onyx", "tools", "reset.sh"),
    `echo "reset $(cat src/value.txt) $ONYX_REPO_ROOT" >> ${hwLog}`
  )
  // Passes only while the experiment still holds the rig between steps.
  await script(
    join(root, "onyx", "tools", "build.sh"),
    `ls "$(git rev-parse --git-common-dir)/onyx/resource-locks/rig/0.json" >/dev/null`
  )
  await script(
    join(root, "onyx", "tools", "eval.sh"),
    `echo "eval $(cat src/value.txt)" >> ${hwLog}\necho "METRIC error=0.25"`
  )
  await script(
    join(root, "sim", "run.sh"),
    `if grep -q bad src/value.txt; then echo "unstable in sim"; exit 1; fi\necho "METRIC error=0.3"`
  )
  const tool = (path: string, resources: string[] = []) => ({
    command: "sh",
    args: [path],
    shell: false,
    cwd: "project",
    env: {},
    resources,
    timeoutSeconds: 30,
    leaseTimeoutSeconds: 10,
    outputLimitBytes: 4000,
    fingerprintPaths: [] as string[],
  })
  currentRoot = root
  const setup: ResearchSetupFile = {
    schemaVersion: 2,
    goal: "Lower error on the rig",
    projectPath: "",
    scope: { editable: ["src"], protected: [] },
    metric: { name: "error", unit: null, direction: "minimize" },
    resources: { rig: { slots: 1, description: "Test rig" } },
    tools: {
      "hw.reset": tool("onyx/tools/reset.sh", ["rig"]),
      build: tool("onyx/tools/build.sh"),
      "hw.eval": {
        ...tool("onyx/tools/eval.sh", ["rig"]),
        fingerprintPaths: ["onyx/tools"],
      },
      "sim.run": tool("sim/run.sh"),
    },
    workflow: [
      { id: "edit", agent: "Make one change.", optional: false },
      { id: "reset", run: "hw.reset", optional: false },
      { id: "build", run: "build", optional: false },
      { id: "evaluate", run: "hw.eval", metric: true, optional: false },
    ],
  }
  await writeFile(
    join(root, "onyx", "setup.json"),
    `${JSON.stringify(setup, null, 2)}\n`,
    "utf8"
  )
  if (withSim) {
    await writeFile(
      join(root, "onyx", "sim.json"),
      `${JSON.stringify({ tool: "sim.run", paths: ["sim"] }, null, 2)}\n`,
      "utf8"
    )
  }
  await git(["add", "."], root)
  await git(["commit", "--quiet", "-m", "setup"], root)
  const baseSha = await currentCommit(root)
  return { root, baseSha, hwLog }
}

async function useWorker(root: string, baseSha: string, workerId: string) {
  process.env.ONYX_WORKER_CONTEXT = await writeWorkerRuntimeContextFixture(
    workerRuntimeContextFixture(root, {
      workerId,
      startingCommitSha: baseSha,
      assignment: {
        id: "assignment-id",
        startingCommitSha: baseSha,
        sourceExperimentId: null,
      },
      deliveryDestination: {
        apiUrl: "https://api.onyx.test",
        teamId: "team-id",
        campaignId: "campaign-id",
      },
    })
  )
}

async function commitValue(root: string, value: string, amend = false) {
  await writeFile(join(root, "src", "value.txt"), `${value}\n`, "utf8")
  await git(["add", "src/value.txt"], root)
  await git(
    amend
      ? ["commit", "--quiet", "--amend", "-m", value]
      : ["commit", "--quiet", "-m", value],
    root
  )
}

async function workerRuns(root: string, workerId: string) {
  return listWorkflowRuns(root, { workerId })
}

/** Queues one sim-passing experiment for `workerId`, built on `from`. */
async function queueExperiment(
  root: string,
  baseSha: string,
  workerId: string,
  value: string,
  from = baseSha
) {
  await useWorker(root, baseSha, workerId)
  await git(["checkout", "--quiet", "--detach", from], root)
  await quietly(() => commandExpRun(args({ auto: "true" })))
  await commitValue(root, value)
  await quietly(() =>
    commandExpRun(
      args({ resume: "true", auto: "true", description: `try ${value}` })
    )
  )
  const queued = (await workerRuns(root, workerId)).find(
    (run) => run.status === "queued"
  )
  expect(queued).toBeDefined()
  return queued!
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("timed out waiting for condition")
}

describe("simulation gate", () => {
  test("a failing simulation keeps the commit off hardware; an amended passing one queues", async () => {
    const { root, baseSha, hwLog } = await hardwareProject({ withSim: true })
    await useWorker(root, baseSha, "worker-a")

    await quietly(() => commandExpRun(args({ auto: "true" })))
    await commitValue(root, "bad")
    await quietly(() => commandExpRun(args({ resume: "true", auto: "true" })))

    let [run] = await workerRuns(root, "worker-a")
    expect(run?.status).toBe("paused")
    expect(run?.sim?.status).toBe("failed")
    expect(run?.blockReason).toContain("Simulation failed")
    expect(await listLocalAttempts(root)).toHaveLength(0)
    expect(existsSync(hwLog)).toBe(false)

    await commitValue(root, "good", true)
    await quietly(() =>
      commandExpRun(
        args({
          resume: "true",
          auto: "true",
          name: "good-value",
          description: "Use a good value",
        })
      )
    )
    ;[run] = await workerRuns(root, "worker-a")
    expect(run?.status).toBe("queued")
    expect(run?.sim?.status).toBe("passed")
    expect(run?.sim?.metrics).toEqual({ error: 0.3 })
    expect(run?.hardware?.name).toBe("good-value")
    expect(run?.hardware?.description).toBe("Use a good value")
    // Nothing touched hardware and nothing is a campaign experiment yet.
    expect(existsSync(hwLog)).toBe(false)
    expect(await listLocalAttempts(root)).toHaveLength(0)
    expect(
      await git(["rev-parse", run!.resultRef], root).catch(() => null)
    ).toBe(run!.resultCommitSha)

    // The worker may start its next idea while the first one waits.
    await quietly(() => commandExpRun(args({ auto: "true" })))
    const runs = await workerRuns(root, "worker-a")
    expect(runs.map((item) => item.status).sort()).toEqual([
      "paused",
      "queued",
    ])
  })

  test("a worker at its queue limit keeps developing in simulation", async () => {
    const { root, baseSha } = await hardwareProject({ withSim: true })
    const first = await queueExperiment(root, baseSha, "worker-a", "one")
    await quietly(() => commandExpRun(args({ auto: "true" })))
    await commitValue(root, "two")
    await quietly(() => commandExpRun(args({ resume: "true", auto: "true" })))
    const second = (await workerRuns(root, "worker-a")).find(
      (run) => run.id !== first.id
    )
    expect(second?.status).toBe("paused")
    expect(second?.sim?.status).toBe("passed")
    expect(second?.blockReason).toContain("already have 1 experiment")
  })

  test("workers cannot run hardware tools directly in queue mode", async () => {
    const { root, baseSha } = await hardwareProject({ withSim: true })
    await useWorker(root, baseSha, "worker-a")
    await expect(
      commandToolsRun(args({}, ["tools", "run", "hw.eval"]))
    ).rejects.toThrow("only the hardware queue may run")
  })
})

describe("hardware dispatcher", () => {
  test("runs queued experiments first come, first served in their own worktrees", async () => {
    const { root, baseSha, hwLog } = await hardwareProject({ withSim: true })
    const first = await queueExperiment(root, baseSha, "worker-a", "alpha")
    const second = await queueExperiment(root, baseSha, "worker-b", "beta")
    delete process.env.ONYX_WORKER_CONTEXT

    const delivered: Array<{ workerId: string; runRef: string }> = []
    const dispatcher = createHardwareDispatcher({
      root,
      sessionId: "session-id",
      concurrency: 1,
      deps: {
        runJob: ({ worktree, run }) =>
          quietly(async () => {
            await runHardwareJob({
              root: worktree,
              projectPath: "",
              runId: run.id,
            })
          }),
        deliver: async ({ run, worker }) => {
          delivered.push({ workerId: worker.workerId, runRef: run.runRef })
          return "delivered"
        },
      },
    })
    for (const workerId of ["worker-a", "worker-b"]) {
      dispatcher.registerWorker({
        workerId,
        hypothesisId: "hypothesis-id",
        assignmentId: "assignment-id",
        workerCredential: "credential",
        contextPath: null,
      })
    }

    const finished = async (run: LocalWorkflowRun) =>
      Boolean((await readWorkflowRun(root, run.id))?.hardware?.finishedAt)
    await waitFor(async () => {
      await dispatcher.tick()
      return (await finished(first)) && (await finished(second))
    })

    expect(delivered.map((item) => item.workerId)).toEqual([
      "worker-a",
      "worker-b",
    ])
    for (const run of [first, second]) {
      const done = await readWorkflowRun(root, run.id)
      expect(done?.status).toBe("succeeded")
      expect(done?.metrics).toEqual({ error: 0.25 })
      expect(done?.hardware?.delivery).toBe("delivered")
    }
    const log = (await readFile(hwLog, "utf8")).trim().split("\n")
    expect(log.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "reset alpha",
      "eval alpha",
      "reset beta",
      "eval beta",
    ])
    // Each job ran in a disposable worktree at its own result commit.
    expect(log[0]).toContain(`/worktrees/session-id/hw-${first.id}`)
    expect(existsSync(log[0]!.split(" ")[2]!)).toBe(false)
    const attempts = await listLocalAttempts(root)
    expect(attempts).toHaveLength(2)
    expect(attempts.every((attempt) => attempt.hardwareJob)).toBe(true)
    expect(
      existsSync(join(root, ".git", "onyx", "resource-locks", "rig", "0.json"))
    ).toBe(false)
  })

  test("draining a worker cancels its experiments still waiting in line", async () => {
    const { root, baseSha, hwLog } = await hardwareProject({ withSim: true })
    const queued = await queueExperiment(root, baseSha, "worker-a", "alpha")
    delete process.env.ONYX_WORKER_CONTEXT
    const dispatcher = createHardwareDispatcher({
      root,
      sessionId: "session-id",
      concurrency: 1,
      deps: {
        runJob: async () => {
          throw new Error("must not run")
        },
        deliver: async () => "delivered",
      },
    })
    await dispatcher.drainWorker("worker-a")
    await dispatcher.tick()
    const run = await readWorkflowRun(root, queued.id)
    expect(run?.status).toBe("abandoned")
    expect(run?.hardware?.delivery).toBe("canceled")
    expect(existsSync(hwLog)).toBe(false)
  })
})

describe("experiment lease", () => {
  test("without a simulator, one experiment holds the rig across all its steps", async () => {
    const { root, baseSha, hwLog } = await hardwareProject({ withSim: false })
    await useWorker(root, baseSha, "worker-a")
    await quietly(() => commandExpRun(args({ auto: "true" })))
    await commitValue(root, "direct")
    await quietly(() => commandExpRun(args({ resume: "true", auto: "true" })))
    const [run] = await workerRuns(root, "worker-a")
    // build.sh fails unless the rig lease taken at reset is still held.
    expect(run?.status).toBe("succeeded")
    expect(run?.metrics).toEqual({ error: 0.25 })
    expect((await readFile(hwLog, "utf8")).trim().split("\n")).toHaveLength(2)
    expect(
      existsSync(join(root, ".git", "onyx", "resource-locks", "rig", "0.json"))
    ).toBe(false)
  })
})
