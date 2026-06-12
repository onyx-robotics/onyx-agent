import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { LocalResearchHistoryRecord } from "./protocol"

import {
  appendHistory,
  appendOutbox,
  applyHistorySyncUpdates,
  branchMetadata,
  commandBranchCreate,
  commandAgent,
  commandExpList,
  commandExpLog,
  commandExpRun,
  commandStatus,
  defaultSkillInstallRoot,
  formatAge,
  historyPath,
  installOnyxSkill,
  lastRunPath,
  mergeHistory,
  outboxPath,
  parseArgs,
  parseMetricLines,
  readEvents,
  readHistory,
  readLastRun,
  readOutbox,
  readState,
  renderFrame,
  writeState,
  spinnerChar,
  stripAnsi,
  USAGE,
  main,
} from "./onyx"

// Force the offline path: every flush resolves the project over the network,
// and a closed port makes that fail fast so records stay queued in the outbox.
process.env.ONYX_API_URL = "http://127.0.0.1:9"
process.env.ONYX_API_KEY = "test-offline"

async function git(root: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()
  const code = await process.exited
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`)
  }
  return stdout.trim()
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>) {
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    return await fn()
  } finally {
    process.chdir(previous)
  }
}

async function captureLogs(fn: () => Promise<void>) {
  const previous = console.log
  const logs: string[] = []
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  }
  try {
    await fn()
  } finally {
    console.log = previous
  }
  return logs.join("\n")
}

async function createGitRepo() {
  const root = await mkdtemp(join(tmpdir(), "onyx-cli-git-test-"))
  await git(root, ["init"])
  await git(root, ["config", "user.email", "test@example.com"])
  await git(root, ["config", "user.name", "Test User"])
  await writeFile(join(root, "README.md"), "# Test\n", "utf8")
  await git(root, ["add", "README.md"])
  await git(root, ["commit", "-m", "initial"])
  return root
}

async function writeOnyxFiles({
  root,
  projectPath = "",
  evalBody = 'echo "METRIC score=0.9"\n',
  checksBody,
}: {
  root: string
  projectPath?: string
  evalBody?: string
  checksBody?: string
}) {
  const scoped = projectPath ? join(root, projectPath) : root
  await mkdir(join(scoped, "onyx"), { recursive: true })
  await writeFile(
    join(scoped, "onyx", "onyx.md"),
    `# Onyx Research

## Objective

Test objective.

## Branches
`,
    "utf8"
  )
  await writeFile(
    join(scoped, "onyx", "eval.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
${evalBody}`,
    { encoding: "utf8", mode: 0o755 }
  )
  await chmod(join(scoped, "onyx", "eval.sh"), 0o755)

  if (checksBody !== undefined) {
    await writeFile(
      join(scoped, "onyx", "checks.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
${checksBody}`,
      { encoding: "utf8", mode: 0o755 }
    )
    await chmod(join(scoped, "onyx", "checks.sh"), 0o755)
  }
}

async function startBranch({
  root,
  options,
  projectPath = "",
  evalBody,
  checksBody,
}: {
  root: string
  options: Record<string, string>
  projectPath?: string
  evalBody?: string
  checksBody?: string
}) {
  await writeOnyxFiles({ root, projectPath, evalBody, checksBody })
  await git(root, ["add", projectPath ? join(projectPath, "onyx") : "onyx"])
  await git(root, ["commit", "-m", "add onyx files"])
  await commandBranchCreate({
    positional: ["branch", "create"],
    options: {
      ...options,
      ...(projectPath ? { "project-path": projectPath } : {}),
    },
  })
  await git(root, [
    "add",
    projectPath
      ? join(projectPath, "onyx", "onyx.md")
      : join("onyx", "onyx.md"),
  ])
  await git(root, ["commit", "-m", "start branch"])
}

describe("onyx CLI helpers", () => {
  test("parses positional args and long options", () => {
    expect(
      parseArgs([
        "branch",
        "create",
        "--name",
        "fast-eval",
        "--metric=score",
        "--dry-run",
      ])
    ).toEqual({
      positional: ["branch", "create"],
      options: {
        name: "fast-eval",
        metric: "score",
        "dry-run": "true",
      },
    })
  })

  test("parses metric lines and numeric fallback output", () => {
    expect(
      parseMetricLines("log\nMETRIC score=0.42\nMETRIC loss=1e-3")
    ).toEqual({
      score: 0.42,
      loss: 0.001,
    })
    expect(parseMetricLines("0.7", "accuracy")).toEqual({ accuracy: 0.7 })
  })

  test("public usage stays focused on primitive commands", () => {
    expect(USAGE).toContain("onyx --version")
    expect(USAGE).toContain("onyx developer status")
    expect(USAGE).toContain("onyx developer use dev")
    expect(USAGE).toContain("onyx agent skill-path")
    expect(USAGE).toContain("onyx agent install-skill")
    expect(USAGE).not.toContain("onyx init")
    expect(USAGE).toContain("onyx login")
    expect(USAGE).toContain("onyx branch create")
    expect(USAGE).toContain("onyx exp run")
    expect(USAGE).toContain("onyx exp log")
    expect(USAGE).toContain("onyx status")
    expect(USAGE).toContain("onyx push")

    expect(USAGE).not.toContain("remote-create")
    expect(USAGE).not.toContain("remote-list")
    expect(USAGE).not.toContain("onyx exp create")
  })

  test("prints the package version for --version", async () => {
    const output = await captureLogs(() => main(["--version"]))

    expect(output).toBe("0.1.2")
  })

  test("exp run writes last-run and exp log queues it when offline", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        await startBranch({
          root,
          options: {
            name: "fast-eval",
            metric: "score",
            unit: "points",
            direction: "maximize",
          },
        })

        await commandExpRun({ positional: ["exp", "run"], options: {} })
        const lastRun = await readLastRun(root)
        expect(lastRun?.status).toBe("succeeded")
        expect(lastRun?.primaryMetricValue).toBe(0.9)

        await commandExpLog({
          positional: ["exp", "log"],
          options: {
            description: "First experiment",
            "agent-notes": '{"hypothesis":"baseline"}',
          },
        })

        const { records } = await readOutbox(root)
        const experiments = records.flatMap((record) =>
          record.type === "experiment_logged" ? [record] : []
        )
        expect(experiments).toHaveLength(1)
        const experiment = experiments[0]!
        expect(experiment.branchName).toBe("fast-eval")
        expect(experiment.status).toBe("succeeded")
        expect(experiment.primaryMetricValue).toBe(0.9)
        expect(experiment.agentNotes.hypothesis).toBe("baseline")
        expect(experiment.runRef).toContain("local/fast-eval/")
        expect(await readLastRun(root)).toBeNull()
        expect(
          records.some(
            (record) =>
              record.type === "branch_started" && record.name === "fast-eval"
          )
        ).toBe(true)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("branch create records the branch HEAD was on as parent", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        const defaultBranch = await git(root, ["branch", "--show-current"])
        await startBranch({
          root,
          options: { name: "pid-tune", metric: "score" },
        })

        // HEAD is now on onyx/pid-tune; fork a child research direction.
        await commandBranchCreate({
          positional: ["branch", "create"],
          options: { name: "pid-tune-d-only", metric: "score" },
        })

        const { records } = await readOutbox(root)
        const branches = records.flatMap((record) =>
          record.type === "branch_started" ? [record] : []
        )
        expect(branches).toHaveLength(2)
        expect(branches[0]?.name).toBe("pid-tune")
        expect(branches[0]?.parentGitBranchName).toBe(defaultBranch)
        expect(branches[1]?.name).toBe("pid-tune-d-only")
        expect(branches[1]?.parentGitBranchName).toBe("onyx/pid-tune")

        const state = await readState(root)
        expect(state.branches["pid-tune-d-only"]?.parentGitBranchName).toBe(
          "onyx/pid-tune"
        )

        const markdown = await readFile(join(root, "onyx", "onyx.md"), "utf8")
        expect(markdown).toContain("Parent branch: onyx/pid-tune")

        // The markdown fallback path (fresh clone, no local state) parses the
        // parent back out of onyx.md.
        await writeState(root, { branches: {} })
        const meta = await branchMetadata({
          root,
          projectPath: "",
          branchName: "pid-tune-d-only",
          gitBranchName: "onyx/pid-tune-d-only",
        })
        expect(meta.parentGitBranchName).toBe("onyx/pid-tune")
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("branch create on a detached HEAD records no parent", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        await git(root, ["checkout", "--detach"])
        await commandBranchCreate({
          positional: ["branch", "create"],
          options: { name: "detached", metric: "score" },
        })

        const { records } = await readOutbox(root)
        const record = records.find(
          (item) => item.type === "branch_started" && item.name === "detached"
        )
        expect(record?.type).toBe("branch_started")
        expect(
          record?.type === "branch_started"
            ? record.parentGitBranchName
            : "unset"
        ).toBeUndefined()
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("branch create for an existing branch keeps the parent unset", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        const defaultBranch = await git(root, ["branch", "--show-current"])
        await startBranch({
          root,
          options: { name: "pid-tune", metric: "score" },
        })
        await git(root, ["checkout", defaultBranch])
        await commandBranchCreate({
          positional: ["branch", "create"],
          options: { name: "other", metric: "score" },
        })
        await git(root, ["add", join("onyx", "onyx.md")])
        await git(root, ["commit", "-m", "start other"])

        // Re-running create for pid-tune while on onyx/other only checks the
        // existing branch out; HEAD's branch is not its fork parent.
        await commandBranchCreate({
          positional: ["branch", "create"],
          options: { name: "pid-tune", metric: "score" },
        })

        const { records } = await readOutbox(root)
        const recreates = records.flatMap((record) =>
          record.type === "branch_started" && record.name === "pid-tune"
            ? [record]
            : []
        )
        expect(recreates).toHaveLength(2)
        expect(recreates[1]?.parentGitBranchName).toBeUndefined()
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("failed evals are measured and logged as failed", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        await startBranch({
          root,
          options: { name: "fast-eval", metric: "score" },
          evalBody: 'echo "boom" >&2\nexit 2\n',
        })

        await commandExpRun({ positional: ["exp", "run"], options: {} })
        process.exitCode = 0
        const lastRun = await readLastRun(root)
        expect(lastRun?.status).toBe("failed")
        expect(lastRun?.primaryMetricValue).toBeNull()

        await commandExpLog({
          positional: ["exp", "log"],
          options: { description: "Eval failed" },
        })

        const { records } = await readOutbox(root)
        const experiment = records.find(
          (record) => record.type === "experiment_logged"
        )
        expect(experiment?.status).toBe("failed")
      })
    } finally {
      process.exitCode = 0
      await rm(root, { recursive: true, force: true })
    }
  })

  test("checks failures are measured and logged as checks_failed", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        await startBranch({
          root,
          options: { name: "fast-eval", metric: "score" },
          checksBody: 'echo "type error" >&2\nexit 1\n',
        })

        await commandExpRun({ positional: ["exp", "run"], options: {} })
        process.exitCode = 0
        const lastRun = await readLastRun(root)
        expect(lastRun?.status).toBe("checks_failed")
        expect(lastRun?.checks?.status).toBe("failed")

        await commandExpLog({
          positional: ["exp", "log"],
          options: { description: "Checks failed" },
        })

        const { records } = await readOutbox(root)
        const experiment = records.find(
          (record) => record.type === "experiment_logged"
        )
        expect(experiment?.status).toBe("checks_failed")
        expect(experiment?.checks?.status).toBe("failed")
      })
    } finally {
      process.exitCode = 0
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stub evals are rejected before measurement", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        await startBranch({
          root,
          options: { name: "fast-eval", metric: "score" },
          evalBody: '# ONYX_STUB_EVAL\necho "METRIC score=0"\n',
        })

        await expect(
          commandExpRun({ positional: ["exp", "run"], options: {} })
        ).rejects.toThrow("ONYX_STUB_EVAL")
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("project-path commands use scoped onyx files", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        const projectPath = "packages/demo"
        await mkdir(join(root, projectPath), { recursive: true })
        await writeFile(join(root, projectPath, "marker.txt"), "ok\n", "utf8")
        await startBranch({
          root,
          projectPath,
          options: { name: "scoped", metric: "score" },
          evalBody: 'test -f marker.txt\nprintf "METRIC score=1.5\\n"\n',
        })

        await commandExpRun({
          positional: ["exp", "run"],
          options: { "project-path": projectPath },
        })

        const lastRun = await readLastRun(root)
        expect(lastRun?.projectPath).toBe(projectPath)
        expect(lastRun?.primaryMetricValue).toBe(1.5)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("status reports pending outbox records and last run", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        await startBranch({
          root,
          options: { name: "fast-eval", metric: "score" },
        })
        await commandExpRun({ positional: ["exp", "run"], options: {} })
        await commandExpLog({
          positional: ["exp", "log"],
          options: { metric: "0.9" },
        })
        await commandExpRun({ positional: ["exp", "run"], options: {} })

        const output = await captureLogs(() =>
          commandStatus({ positional: ["status"], options: {} })
        )
        expect(output).toContain("1 experiment(s)")
        expect(output).toContain("pending")
        expect(output).toContain("last run:")
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("readOutbox skips corrupt lines instead of throwing", async () => {
    const root = await createGitRepo()
    try {
      await appendOutbox(root, {
        schemaVersion: 1,
        type: "branch_started",
        createdAt: "2026-05-02T12:00:00.000Z",
        name: "fast-eval",
        gitBranchName: "onyx/fast-eval",
        baseCommitSha: "abcdef1",
        metricName: "score",
        metricDirection: "maximize",
      })
      await writeFile(await outboxPath(root), "{ not json\n", { flag: "a" })

      const { records, corrupt } = await readOutbox(root)
      expect(records).toHaveLength(1)
      expect(corrupt).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("packaged skills have valid metadata and use public CLI primitives", async () => {
    const skillsDir = join(import.meta.dir, "..", "skills")
    const skillNames = await readdir(skillsDir)
    expect(skillNames.sort()).toEqual(["onyx"])

    for (const skillName of skillNames) {
      const skill = await readFile(
        join(skillsDir, skillName, "SKILL.md"),
        "utf8"
      )
      expect(skill).toMatch(/^---\n[\s\S]*\n---\n/)
      expect(skill).toMatch(/\nname: [a-z0-9-]+\n/)
      expect(skill).toMatch(/\ndescription: .+\n/)
      expect(skill).not.toContain("remote-create")
      expect(skill).not.toContain("remote-list")
      expect(skill).not.toContain("onyx exp create")
      expect(skill).not.toContain("onyx init")
      expect(skill).toContain("onyx status")
      expect(skill).toContain("onyx exp run")
      expect(skill).toContain("onyx exp log")
    }
  })

  test("package declares bundled agent skills", async () => {
    const pkg = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8")
    ) as { pi?: { skills?: string[] }; files?: string[] }

    expect(pkg.pi?.skills).toEqual(["./skills"])
    expect(pkg.files).toContain("skills")
  })

  test("agent skill commands expose and install the bundled skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-agent-skill-test-"))
    try {
      expect(defaultSkillInstallRoot()).toBe(
        join(homedir(), ".claude", "skills")
      )

      const pathOutput = await captureLogs(() =>
        commandAgent({ positional: ["agent", "skill-path"], options: {} })
      )
      expect(pathOutput).toContain("SKILL.md")

      await installOnyxSkill({ dir: root, quiet: true })
      const installed = await readFile(
        join(root, "onyx", "SKILL.md"),
        "utf8"
      )
      expect(installed).toContain("name: onyx")

      const commandOutput = await captureLogs(() =>
        commandAgent({
          positional: ["agent", "install-skill"],
          options: { dir: root, quiet: "true" },
        })
      )
      expect(commandOutput).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("last-run path lives in the git onyx state directory", async () => {
    const root = await createGitRepo()
    try {
      const path = await lastRunPath(root)
      expect(path).toContain(join(".git", "onyx", "last-run.json"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function historyRecord(
  overrides: Partial<LocalResearchHistoryRecord> = {}
): LocalResearchHistoryRecord {
  return {
    schemaVersion: 1,
    source: "local",
    branchName: "fast-eval",
    runRef: `local/fast-eval/${overrides.name ?? "fixture"}`,
    commitSha: "abc1234",
    status: "succeeded",
    name: "experiment-abc1234",
    primaryMetricName: "score",
    primaryMetricValue: 0.9,
    metrics: { score: 0.9 },
    agentNotes: {},
    createdAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  }
}

describe("local history cache", () => {
  test("exp log appends a provisional history record and emits events", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        await startBranch({
          root,
          options: { name: "fast-eval", metric: "score" },
        })
        await commandExpRun({ positional: ["exp", "run"], options: {} })
        await commandExpLog({
          positional: ["exp", "log"],
          options: { "agent-notes": '{"idea":"baseline"}' },
        })

        const { records } = await readHistory(root)
        expect(records).toHaveLength(1)
        const record = records[0]!
        expect(record.source).toBe("local")
        expect(record.branchName).toBe("fast-eval")
        expect(record.status).toBe("succeeded")
        expect(record.primaryMetricValue).toBe(0.9)
        expect(record.agentNotes.idea).toBe("baseline")

        const { records: outbox } = await readOutbox(root)
        const logged = outbox.find((r) => r.type === "experiment_logged")
        expect(record.runRef).toBe(logged!.runRef)

        const eventTypes = (await readEvents(root)).map((event) => event.type)
        expect(eventTypes).toContain("branch_created")
        expect(eventTypes).toContain("exp_run_started")
        expect(eventTypes).toContain("eval_finished")
        expect(eventTypes).toContain("run_finished")
        expect(eventTypes).toContain("exp_logged")
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("readHistory skips corrupt lines instead of throwing", async () => {
    const root = await createGitRepo()
    try {
      await appendHistory(root, historyRecord())
      await writeFile(await historyPath(root), "{ not json\n", { flag: "a" })

      const { records, corrupt } = await readHistory(root)
      expect(records).toHaveLength(1)
      expect(corrupt).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("mergeHistory dedupes by runRef, canonical winning, branch-grouped", () => {
    const canonical = [
      historyRecord({
        source: "api",
        runRef: "local/fast-eval/a",
        status: "accepted",
        sequenceNumber: 2,
        name: "exp-a",
      }),
      historyRecord({
        source: "api",
        runRef: "local/fast-eval/b",
        sequenceNumber: 1,
        name: "exp-b",
      }),
      // A branch created on another machine appears without conflict.
      historyRecord({
        source: "api",
        branchName: "other-machine",
        runRef: "local/other-machine/c",
        sequenceNumber: 1,
        name: "exp-c",
      }),
    ]
    const localPending = [
      // Same runRef as a canonical record: canonical status wins.
      historyRecord({ runRef: "local/fast-eval/a", status: "succeeded" }),
      // Unflushed local record: preserved, sorted after sequenced rows.
      historyRecord({
        runRef: "local/fast-eval/z",
        name: "exp-z",
        createdAt: "2026-06-02T08:00:00.000Z",
      }),
    ]

    const merged = mergeHistory(canonical, localPending)
    expect(merged.map((record) => record.runRef)).toEqual([
      "local/fast-eval/b",
      "local/fast-eval/a",
      "local/fast-eval/z",
      "local/other-machine/c",
    ])
    expect(
      merged.find((record) => record.runRef === "local/fast-eval/a")?.status
    ).toBe("accepted")
    expect(
      merged.find((record) => record.runRef === "local/fast-eval/z")?.source
    ).toBe("local")
  })

  test("flush write-back stamps server sequence numbers onto history", async () => {
    const root = await createGitRepo()
    try {
      await appendHistory(
        root,
        historyRecord({ runRef: "local/fast-eval/a", name: "exp-a" })
      )
      await appendHistory(
        root,
        historyRecord({ runRef: "local/fast-eval/b", name: "exp-b" })
      )

      await applyHistorySyncUpdates(
        root,
        new Map([
          [
            "local/fast-eval/a",
            {
              sequenceNumber: 7,
              experimentId: "3e2c5a31-94a1-4be4-9f74-1de4e9f4d8aa",
              branchId: "9b8d6e42-7c15-4f7a-8a3b-2fe6c7a9d1bb",
            },
          ],
        ])
      )

      const { records } = await readHistory(root)
      const stamped = records.find((r) => r.runRef === "local/fast-eval/a")!
      expect(stamped.sequenceNumber).toBe(7)
      expect(stamped.source).toBe("api")
      expect(stamped.experimentId).toBe("3e2c5a31-94a1-4be4-9f74-1de4e9f4d8aa")
      // Unmatched records stay provisional.
      const untouched = records.find((r) => r.runRef === "local/fast-eval/b")!
      expect(untouched.sequenceNumber).toBeUndefined()
      expect(untouched.source).toBe("local")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("exp list filters by branch, status, and grep", async () => {
    const root = await createGitRepo()
    try {
      await withCwd(root, async () => {
        await appendHistory(
          root,
          historyRecord({
            runRef: "local/fast-eval/1",
            name: "tune-cache",
            agentNotes: { idea: "memoize hot path" },
            createdAt: "2026-06-01T10:00:00.000Z",
          })
        )
        await appendHistory(
          root,
          historyRecord({
            runRef: "local/fast-eval/2",
            name: "wider-batch",
            status: "failed",
            primaryMetricValue: null,
            createdAt: "2026-06-01T11:00:00.000Z",
          })
        )
        await appendHistory(
          root,
          historyRecord({
            branchName: "other-branch",
            runRef: "local/other-branch/3",
            name: "other-idea",
            createdAt: "2026-06-01T12:00:00.000Z",
          })
        )

        const all = await captureLogs(() =>
          commandExpList({ positional: ["exp", "list"], options: {} })
        )
        expect(all).toContain("tune-cache")
        expect(all).toContain("wider-batch")
        expect(all).toContain("other-idea")
        // Newest first.
        expect(all.indexOf("other-idea")).toBeLessThan(
          all.indexOf("tune-cache")
        )

        const byBranch = await captureLogs(() =>
          commandExpList({
            positional: ["exp", "list"],
            options: { branch: "fast-eval" },
          })
        )
        expect(byBranch).toContain("tune-cache")
        expect(byBranch).not.toContain("other-idea")

        const byStatus = await captureLogs(() =>
          commandExpList({
            positional: ["exp", "list"],
            options: { status: "failed" },
          })
        )
        expect(byStatus).toContain("wider-batch")
        expect(byStatus).not.toContain("tune-cache")

        // Grep matches agent notes, case-insensitively.
        const byGrep = await captureLogs(() =>
          commandExpList({
            positional: ["exp", "list"],
            options: { grep: "MEMOIZE|cache" },
          })
        )
        expect(byGrep).toContain("tune-cache")
        expect(byGrep).not.toContain("wider-batch")

        const asJson = await captureLogs(() =>
          commandExpList({
            positional: ["exp", "list"],
            options: { json: "true", limit: "2" },
          })
        )
        const parsed = JSON.parse(asJson) as LocalResearchHistoryRecord[]
        expect(parsed).toHaveLength(2)
        expect(parsed[0]!.runRef).toBe("local/other-branch/3")

        await expect(
          commandExpList({
            positional: ["exp", "list"],
            options: { grep: "(" },
          })
        ).rejects.toThrow("--grep is not a valid regex")
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("listen TUI rendering", () => {
  const NOW = Date.parse("2026-06-01T12:05:00.000Z")

  test("formatAge renders compact relative times", () => {
    expect(formatAge("2026-06-01T12:04:58.000Z", NOW)).toBe("now")
    expect(formatAge("2026-06-01T12:04:18.000Z", NOW)).toBe("42s")
    expect(formatAge("2026-06-01T12:00:00.000Z", NOW)).toBe("5m")
    expect(formatAge("2026-06-01T10:05:00.000Z", NOW)).toBe("2h")
    expect(formatAge("2026-05-29T12:05:00.000Z", NOW)).toBe("3d")
    expect(formatAge(null, NOW)).toBe("—")
  })

  test("renderFrame draws a titled rounded box with newest at the bottom", () => {
    const lines = renderFrame(
      {
        projectName: "demo-repo",
        branchName: "onyx/fast-eval",
        metricName: "score",
        metricUnit: null,
        metricDirection: "maximize",
        bestValue: 0.92,
        activity: "running eval · abc1234 · 12s",
        rows: [
          historyRecord({
            sequenceNumber: 1,
            name: "baseline",
            status: "failed",
            primaryMetricValue: null,
            description: "first attempt",
          }),
          historyRecord({
            sequenceNumber: 2,
            name: "tune-cache",
            description: "memoize the hot path",
          }),
        ],
        active: true,
        pendingOutbox: 2,
        syncedCount: 11,
      },
      { columns: 100, rows: 24, nowMs: NOW }
    ).map(stripAnsi)

    // A blank line above the box, then the ONYX | repo | branch title
    // interrupting the top border on the left; best metric on the right.
    expect(lines[0]).toBe("")
    expect(lines[1]).toMatch(
      /^╭─ ONYX \| demo-repo \| onyx\/fast-eval ─+─ best 0\.92 ↑ score ─╮$/
    )
    // A blank box line separates the title border from the column header.
    expect(lines[2]).toMatch(/^│ +│$/)
    expect(lines.at(-4)).toMatch(/^╰─+╯$/)
    // Activity sits below the box; a blank line separates it from the footer.
    expect(lines.at(-3)).toContain("running eval · abc1234 · 12s")
    expect(lines.at(-2)).toBe("")
    expect(lines.at(-1)).toContain("outbox 2 pending · 11 synced · q quit")

    const body = lines.join("\n")
    // Tree-view column vocabulary: glyphs, lowercase labels, value-only metric.
    expect(body).toContain("NAME")
    expect(body).toContain("DESCRIPTION")
    expect(body).toContain("CREATED")
    expect(body).toContain("✗")
    expect(body).toContain("failed")
    expect(body).toContain("•")
    expect(body).toMatch(/ok\s+│/)
    expect(body).toContain("memoize the hot path")
    expect(body).toContain("#2")
    // Most recent experiment renders below the older one.
    expect(body.indexOf("baseline")).toBeLessThan(body.indexOf("tune-cache"))
    // Table rows are framed by the box border.
    expect(lines[3]).toMatch(/^│ .*│$/)
  })

  test("renderFrame clips every line to the terminal width", () => {
    const lines = renderFrame(
      {
        projectName: "a-rather-long-project-name",
        branchName: "onyx/a-long-branch-name",
        metricName: "integral_abs_error",
        metricUnit: "error",
        metricDirection: "minimize",
        bestValue: 0.9084,
        activity: null,
        rows: [
          historyRecord({
            name: "an-experiment-with-a-very-long-descriptive-name",
            primaryMetricName: "integral_abs_error",
            primaryMetricValue: 0.9084,
          }),
        ],
        active: true,
        pendingOutbox: 0,
        syncedCount: 0,
      },
      { columns: 60, rows: 24, nowMs: NOW }
    )
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(60)
    }
    // The metric value column survives narrow widths.
    expect(stripAnsi(lines.join("\n"))).toContain("0.9084")
  })

  test("activity spinner orbits the braille square clockwise", () => {
    // One full revolution: the notch sweeps top-left → top-right → down the
    // right side → bottom-right → bottom-left → up the left side.
    const frames = Array.from({ length: 8 }, (_, i) => spinnerChar(i * 120))
    expect(frames).toEqual(["⣾", "⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽"])
    expect(spinnerChar(8 * 120)).toBe("⣾") // wraps around

    const model = {
      projectName: "demo-repo",
      branchName: "onyx/fast-eval",
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize" as const,
      bestValue: null,
      activity: "running eval",
      rows: [],
      active: true,
      pendingOutbox: 0,
      syncedCount: 0,
    }
    const live = renderFrame(model, { columns: 80, rows: 24, nowMs: NOW }).map(
      stripAnsi
    )
    // The activity line leads with the current spinner frame and the label.
    expect(live.at(-3)).toBe(
      ` ${spinnerChar(NOW)} Research Agent: running eval`
    )

    // Idle sessions show the full square instead of animating.
    const idle = renderFrame(
      { ...model, active: false },
      { columns: 80, rows: 24, nowMs: NOW }
    ).map(stripAnsi)
    expect(idle.at(-3)).toBe(" ⣿ Research Agent: running eval")
  })

  test("renderFrame shows duration and created columns like the tree view", () => {
    const lines = renderFrame(
      {
        projectName: "demo-repo",
        branchName: "onyx/fast-eval",
        metricName: "score",
        metricUnit: null,
        metricDirection: "maximize",
        bestValue: 0.9,
        activity: null,
        rows: [
          historyRecord({
            sequenceNumber: 1,
            startedAt: "2026-06-01T12:00:00.000Z",
            completedAt: "2026-06-01T12:00:02.000Z",
          }),
        ],
        active: true,
        pendingOutbox: 0,
        syncedCount: 1,
      },
      { columns: 130, rows: 24, nowMs: NOW }
    ).map(stripAnsi)

    const body = lines.join("\n")
    expect(body).toContain("DURATION")
    expect(body).toContain("2.0000s")
    // Created column renders MM-DD HH:mm:ss.
    expect(body).toMatch(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
  })

  test("usage covers the new history and listen commands", () => {
    expect(USAGE).toContain("onyx exp list")
    expect(USAGE).toContain("onyx listen")
    expect(USAGE).toContain("history.jsonl")
  })
})
