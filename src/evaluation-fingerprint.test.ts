import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { researchSetupFileSchema } from "./protocol"
import { evaluationFingerprint } from "./lib/evaluation-fingerprint"
import { currentCommit, git } from "./lib/git"

const roots: string[] = []

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "onyx-evaluation-fingerprint-"))
  roots.push(root)
  await git(["init"], root)
  await git(["config", "user.email", "test@example.com"], root)
  await git(["config", "user.name", "Onyx Test"], root)
  await mkdir(join(root, "onyx", "tools", "evaluation"), { recursive: true })
  await writeFile(
    join(root, "onyx", "tools", "evaluation", "run.sh"),
    "#!/bin/sh\necho 'METRIC score=1'\n",
    "utf8"
  )
  await git(["add", "."], root)
  await git(["commit", "-m", "add evaluator"], root)
  return root
}

function setup(fingerprintPaths = ["onyx/tools/evaluation"]) {
  return researchSetupFileSchema.parse({
    goal: "Improve score",
    projectPath: "",
    scope: { editable: ["src"], protected: ["onyx/"] },
    metric: { name: "score", unit: null, direction: "maximize" },
    resources: {},
    tools: {
      "evaluation.run": {
        command: "sh",
        args: ["onyx/tools/evaluation/run.sh"],
        fingerprintPaths,
      },
    },
    workflow: [
      { id: "edit", agent: "Make one change." },
      { id: "evaluate", run: "evaluation.run", metric: true },
    ],
  })
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe("committed evaluation fingerprints", () => {
  test("are deterministic and ignore dirty tracked working-tree content", async () => {
    const root = await repository()
    const commitSha = await currentCommit(root)
    const first = await evaluationFingerprint({
      root,
      projectPath: "",
      commitSha,
      setup: setup(),
    })
    await writeFile(
      join(root, "onyx", "tools", "evaluation", "run.sh"),
      "#!/bin/sh\necho 'METRIC score=999'\n",
      "utf8"
    )
    const second = await evaluationFingerprint({
      root,
      projectPath: "",
      commitSha,
      setup: setup(),
    })
    expect(second).toEqual(first)
  })

  test("changes cohorts when committed evaluator content changes", async () => {
    const root = await repository()
    const before = await evaluationFingerprint({
      root,
      projectPath: "",
      commitSha: await currentCommit(root),
      setup: setup(),
    })
    await writeFile(
      join(root, "onyx", "tools", "evaluation", "run.sh"),
      "#!/bin/sh\necho 'METRIC score=2'\n",
      "utf8"
    )
    await git(["add", "."], root)
    await git(["commit", "-m", "change evaluator"], root)
    const after = await evaluationFingerprint({
      root,
      projectPath: "",
      commitSha: await currentCommit(root),
      setup: setup(),
    })
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  test("rejects escaping, missing, untracked, and symlinked inputs", async () => {
    const root = await repository()
    const commitSha = await currentCommit(root)
    expect(() => setup(["../outside"])).toThrow("relative repository path")
    await expect(
      evaluationFingerprint({
        root,
        projectPath: "",
        commitSha,
        setup: setup(["missing"]),
      })
    ).rejects.toThrow("missing from commit")

    await writeFile(
      join(root, "onyx", "tools", "evaluation", "untracked.txt"),
      "untracked\n",
      "utf8"
    )
    await expect(
      evaluationFingerprint({
        root,
        projectPath: "",
        commitSha,
        setup: setup(),
      })
    ).rejects.toThrow("contains untracked files")

    await rm(join(root, "onyx", "tools", "evaluation", "untracked.txt"))
    await symlink(
      "run.sh",
      join(root, "onyx", "tools", "evaluation", "linked.sh")
    )
    await git(["add", "."], root)
    await git(["commit", "-m", "add evaluator symlink"], root)
    await expect(
      evaluationFingerprint({
        root,
        projectPath: "",
        commitSha: await currentCommit(root),
        setup: setup(),
      })
    ).rejects.toThrow("not a symlink")
  })
})
