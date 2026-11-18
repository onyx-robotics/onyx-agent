import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { researchConfig, type LoadedConfig } from "./config"
import { basePrompt, varopPrompt, workerPrompt } from "./prompts"

test("each role is told its skill, and the base agent the run's brief with every guide", () => {
  const root = mkdtempSync(join(tmpdir(), "onyx-prompts-"))
  mkdirSync(join(root, "onyx", "endpoints"), { recursive: true })
  writeFileSync(
    join(root, "onyx", "endpoints", "bench.md"),
    "# Bench\r\n\r\nTimes solve() twice.\r\n"
  )
  const cfg: LoadedConfig = {
    ...researchConfig.parse({
      name: "t",
      goal: "make it fast",
      remote: "../remote.git",
      editable: ["solver.py"],
      metrics: [{ key: "t.speedup", better: "higher" }],
      endpoints: [
        {
          type: "t.bench",
          label: "the bench",
          guide: "onyx/endpoints/bench.md",
          driver: "x",
          timeoutS: 120,
        },
      ],
    }),
    root,
    path: join(root, "onyx", "research.json"),
  }

  const base = basePrompt(cfg)
  expect(base).toContain("# Working as the base agent")
  expect(base).toContain("Times solve() twice.")
  expect(base).toContain("Time limit per experiment: 120 s")

  const worker = workerPrompt({
    hypothesis: "a banded solve",
    why: "the matrix is banded",
    baseCommit: "abc",
    worktree: "/w",
    cited: "",
    related: "",
    limits: { "t.bench": 60 },
  })
  expect(worker).toContain("# Working as a worker")
  expect(worker).toContain("**a banded solve**")
  // the limit as it is now, which may have changed since the brief
  expect(worker).toContain("`t.bench` 60 s")
  expect(varopPrompt("the board")).toContain("# Working as the var-op")
  // the front matter names a skill to Claude Code; agents get only its instructions
  for (const p of [base, worker]) expect(p).not.toContain("description: How to work")
})
