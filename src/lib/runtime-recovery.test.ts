import { trackManagedProcessGroup } from "./managed-process-groups"
import {
  commandResearchClean,
  commandResearchRecover,
} from "../commands/research"
import { afterEach, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "./git"
import { reconcileRuntime } from "./runtime-recovery"
import { inspectProcessIdentity } from "./process-identity"
import { recoverReports } from "./report-delivery"

const roots: string[] = []
const initialHome = process.env.ONYX_HOME
afterEach(async () => {
  if (initialHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = initialHome
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "onyx-recovery-")))
  roots.push(root)
  process.env.ONYX_HOME = join(root, "isolated-config")
  await git(["init", "--quiet"], root)
  const base = join(root, ".git", "onyx")
  const supervisor = {
    schemaVersion: 1,
    mode: "foreground",
    createdAt: new Date().toISOString(),
    sessionId: "session",
    pid: 2147483647,
    supervisorRunId: "run",
    processStartedAt: "old",
    commandIdentity: "onyx",
  }
  const local = { schedulerSiteId: "site", supervisor }
  await mkdir(join(base, "runtime"), { recursive: true })
  await mkdir(join(base, "worker-runtime", "session"), { recursive: true })
  await writeFile(join(base, "runtime", "site-id"), "site")
  await writeFile(
    join(base, "state.json"),
    JSON.stringify({ schemaVersion: 2, sessions: { session: local } })
  )
  await writeFile(
    join(base, "worker-runtime", "session", "supervisor-process.json"),
    JSON.stringify(supervisor)
  )
  return { root, base, supervisor, local }
}

test("fresh report/runtime dry-run creates no runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "onyx-readonly-"))
  roots.push(root)
  process.env.ONYX_HOME = join(root, "isolated-config")
  await git(["init", "--quiet"], root)
  const before = (await readdir(join(root, ".git"), { recursive: true })).sort()
  const result = await reconcileRuntime({
    root,
    dryRun: true,
    cleanup: async () => {
      throw new Error("mutation")
    },
    complete: async () => {
      throw new Error("mutation")
    },
  })
  expect(result.sessions).toEqual([])
  expect(
    (await recoverReports(root, { positional: [], options: {} }, true)).pending
  ).toBe(0)
  expect(
    (await readdir(join(root, ".git"), { recursive: true })).sort()
  ).toEqual(before)
})

test("dead session recovery is repeatable and dry-run never invokes mutation callbacks", async () => {
  const { root, base } = await fixture()
  let completed = 0
  const input = {
    root,
    cleanup: async () => true,
    complete: async () => {
      completed++
    },
  }
  expect((await reconcileRuntime({ ...input, dryRun: true })).recovered).toBe(1)
  expect(completed).toBe(0)
  expect((await reconcileRuntime(input)).recovered).toBe(1)
  expect((await reconcileRuntime(input)).recovered).toBe(1)
  expect(completed).toBe(2)
  await mkdir(join(base, "worker-runtime", "session", "unaccounted-home"))
  expect((await reconcileRuntime(input)).blocked).toBe(1)
  expect(completed).toBe(2)
})

test("live, mismatched and malformed ownership never invokes cleanup", async () => {
  const { root, base, supervisor, local } = await fixture()
  const identity = inspectProcessIdentity(process.pid)!
  Object.assign(supervisor, {
    pid: process.pid,
    processStartedAt: identity.startedAt,
    commandIdentity: identity.command,
  })
  await writeFile(
    join(base, "state.json"),
    JSON.stringify({ schemaVersion: 2, sessions: { session: local } })
  )
  await writeFile(
    join(base, "worker-runtime", "session", "supervisor-process.json"),
    JSON.stringify(supervisor)
  )
  const input = {
    root,
    cleanup: async () => {
      throw new Error("must not run")
    },
    complete: async () => {
      throw new Error("must not run")
    },
  }
  expect((await reconcileRuntime(input)).skippedActive).toBe(1)
  await writeFile(join(base, "runtime", "site-id"), "another-site")
  expect((await reconcileRuntime(input)).blocked).toBe(1)
  await writeFile(
    join(base, "worker-runtime", "session", "supervisor-process.json"),
    "bad-json"
  )
  expect((await reconcileRuntime(input)).blocked).toBe(1)
  expect(
    await readFile(
      join(base, "worker-runtime", "session", "supervisor-process.json"),
      "utf8"
    )
  ).toBe("bad-json")
})

test("explicit recovery removes real abandoned credentials and Git worktree registration", async () => {
  const { root, base, supervisor, local } = await fixture()
  await git(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ],
    root
  )
  const sha = await git(["rev-parse", "HEAD"], root)
  const worktree = join(base, "worktrees", "session", "worker")
  await git(["worktree", "add", "--detach", worktree, sha], root)
  const logDir = join(base, "worker-logs", "session")
  const runtime = join(base, "worker-runtime", "session", "worker")
  await mkdir(logDir, { recursive: true })
  await mkdir(join(runtime, "home"), { recursive: true })
  await writeFile(
    join(runtime, "context.json"),
    JSON.stringify({ token: "private-test-token" })
  )
  const manifestPath = join(logDir, "worker.manifest.json")
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      managedProcessGroupsVersion: 1,
      sessionId: "session",
      workerId: "worker",
      hypothesisId: "hypothesis",
      supervisorRunId: "run",
      pid: 2147483647,
      processStartedAt: "old",
      commandIdentity: "provider",
      cwd: worktree,
      manifestPath,
      startingCommitSha: sha,
      status: "running",
      teardown: null,
    })
  )
  await writeFile(
    join(base, "state.json"),
    JSON.stringify({
      schemaVersion: 2,
      sessions: { session: { ...local, campaignId: "campaign" } },
    })
  )
  await writeFile(
    join(base, "worker-runtime", "session", "supervisor-process.json"),
    JSON.stringify({
      ...supervisor,
      destination: {
        apiUrl: "http://127.0.0.1:1",
        teamId: "team",
        campaignId: "campaign",
      },
    })
  )
  if (process.platform === "linux") {
    const pending = trackManagedProcessGroup(join(runtime, "context.json"))!
    const originalExitCode = process.exitCode
    try {
      await commandResearchRecover({
        positional: ["research", "recover"],
        options: { cwd: root, runtime: "true", json: "true" },
      })
      expect(process.exitCode).toBe(1)
      await expect(
        commandResearchClean({
          positional: ["research", "clean"],
          options: { cwd: root },
        })
      ).rejects.toThrow("unresolved")
      expect(await readFile(join(runtime, "context.json"), "utf8")).toContain(
        "private-test-token"
      )
      expect(await git(["worktree", "list", "--porcelain"], root)).toContain(
        worktree
      )
    } finally {
      process.exitCode = originalExitCode ?? 0
      pending.failedToSpawn()
    }
  }
  // No credentials or remote service is needed for local reconciliation. The
  // scoped cleanup receipt remains pending for a later authenticated pass.
  await commandResearchRecover({
    positional: ["research", "recover"],
    options: { cwd: root, runtime: "true", json: "true" },
  })
  expect(await readdir(join(base, "worker-runtime", "session"))).not.toContain(
    "worker"
  )
  expect(await git(["worktree", "list", "--porcelain"], root)).not.toContain(
    worktree
  )
  expect(
    JSON.parse(await readFile(manifestPath, "utf8")).teardown.worktreeCleanup
  ).toBe("removed")
  expect(
    await readFile(join(base, "delivery-cleanup", "session.site.json"), "utf8")
  ).toContain('"supervisorRunId":"run"')
  await commandResearchRecover({
    positional: ["research", "recover"],
    options: { cwd: root, runtime: "true", json: "true" },
  })
  expect(await git(["rev-parse", "HEAD"], root)).toBe(sha)
  await expect(
    commandResearchClean({
      positional: ["research", "clean"],
      options: { cwd: root },
    })
  ).rejects.toThrow("incomplete")
})
