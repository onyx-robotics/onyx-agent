import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { commandSetupValidate } from "./commands/setup"
import type { Args } from "./lib/args"
import { git } from "./lib/git"

async function withMutedConsole<T>(fn: () => Promise<T>) {
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
}

function args(): Args {
  return { positional: ["setup", "validate"], options: {} }
}

describe("setup validation", () => {
  test("does not rewrite validation.json when only generated timestamps changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-setup-validate-"))
    await git(["init"], root)
    await mkdir(join(root, "onyx", "tools", "evaluation"), {
      recursive: true,
    })
    await writeFile(
      join(root, "onyx", "setup.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          goal: "Maximize deterministic score.",
          projectPath: "",
          scope: {
            editable: ["src"],
            protected: [
              "onyx/setup.json",
              "onyx/validation.json",
              "onyx/onyx.md",
              "onyx/tools/",
            ],
          },
          metric: { name: "score", unit: null, direction: "maximize" },
          resources: {},
          tools: {
            "evaluation.run": {
              description: "Emit deterministic score.",
              command: "bash",
              args: ["onyx/tools/evaluation/run.sh"],
              shell: false,
              cwd: "project",
              env: {},
              resources: [],
              timeoutSeconds: 30,
              leaseTimeoutSeconds: 30,
              outputLimitBytes: 4000,
              fingerprintPaths: ["onyx/tools/evaluation"],
            },
          },
          workflow: [
            {
              id: "edit",
              agent: "Make one scoped change and commit it.",
              optional: false,
            },
            {
              id: "evaluate",
              run: "evaluation.run",
              metric: true,
              optional: false,
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    )
    await writeFile(
      join(root, "onyx", "onyx.md"),
      [
        "# Research",
        "",
        "Goal: maximize the deterministic score.",
        "Metric: score.",
        "Workflow: one small measured experiment at a time.",
        "Safety: keep changes scoped to src.",
        "Readiness: evaluation.run emits the metric.",
        "Reliability: deterministic smoke validation.",
        "",
      ].join("\n"),
      "utf8"
    )
    const evalPath = join(root, "onyx", "tools", "evaluation", "run.sh")
    await writeFile(
      evalPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "echo 'METRIC score=1'",
        "",
      ].join("\n"),
      "utf8"
    )
    await chmod(evalPath, 0o755)

    const previousCwd = process.cwd()
    process.chdir(root)
    try {
      await withMutedConsole(() => commandSetupValidate(args()))
      const first = await readFile(
        join(root, "onyx", "validation.json"),
        "utf8"
      )
      await withMutedConsole(() => commandSetupValidate(args()))
      const second = await readFile(
        join(root, "onyx", "validation.json"),
        "utf8"
      )

      expect(second).toBe(first)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("validates the simulator gate and requires it to pass on the current code", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-setup-sim-"))
    await git(["init"], root)
    await mkdir(join(root, "onyx", "tools"), { recursive: true })
    await mkdir(join(root, "sim"), { recursive: true })
    const tool = (path: string, resources: string[] = []) => ({
      command: "sh",
      args: [path],
      shell: false,
      cwd: "project",
      env: {},
      resources,
      timeoutSeconds: 30,
      leaseTimeoutSeconds: 30,
      outputLimitBytes: 4000,
      fingerprintPaths: ["onyx/tools"],
    })
    await writeFile(
      join(root, "onyx", "setup.json"),
      JSON.stringify({
        schemaVersion: 2,
        goal: "Lower rig error.",
        projectPath: "",
        scope: { editable: ["src"], protected: [] },
        metric: { name: "error", unit: null, direction: "minimize" },
        resources: { rig: { slots: 1, description: "hardware rig" } },
        tools: {
          "hw.eval": tool("onyx/tools/eval.sh", ["rig"]),
          "sim.run": tool("sim/run.sh"),
        },
        workflow: [
          { id: "edit", agent: "Make one change.", optional: false },
          { id: "evaluate", run: "hw.eval", metric: true, optional: false },
        ],
      })
    )
    await writeFile(
      join(root, "onyx", "onyx.md"),
      "# Research\n\nMetric: error. Evaluation on the rig. Editable scope: src.\n"
    )
    await writeFile(join(root, "onyx", "tools", "eval.sh"), "echo 'METRIC error=1'\n")
    await writeFile(
      join(root, "onyx", "sim.json"),
      JSON.stringify({ tool: "sim.run", paths: ["sim"], source: "user" })
    )
    const checksFor = async (simBody: string) => {
      await writeFile(join(root, "sim", "run.sh"), simBody)
      await withMutedConsole(() => commandSetupValidate(args()))
      const validation = JSON.parse(
        await readFile(join(root, "onyx", "validation.json"), "utf8")
      ) as { checks: Array<{ id: string; status: string }> }
      return Object.fromEntries(
        validation.checks.map((check) => [check.id, check.status])
      )
    }

    const previousCwd = process.cwd()
    process.chdir(root)
    try {
      const passing = await checksFor("echo 'METRIC error=1.1'\n")
      expect(passing.sim_config).toBe("passed")
      expect(passing.sim_tool_readiness).toBe("passed")
      const failing = await checksFor("exit 3\n")
      expect(failing.sim_tool_readiness).toBe("failed")
    } finally {
      process.chdir(previousCwd)
      process.exitCode = 0
    }
  })
})
