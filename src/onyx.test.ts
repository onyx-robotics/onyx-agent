import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { LocalResearchHistoryRecord } from "./protocol"
import {
  appendOutbox,
  clientRunRef,
  commandSetupInit,
  commandSetupModules,
  commandSetupRequire,
  commandSetupValidate,
  localResearchRecordSchema,
  mergeHistory,
  normalizeSetupFile,
  onyxStateDir,
  parseMetricLines,
  readOutbox,
  readSetupFile,
  readValidationFile,
  renderExperimentTable,
  runToolCommand,
  requiredSetupModules,
  setupModuleRequirement,
  USAGE,
} from "./onyx"
import { runProcess } from "./lib/process"

describe("campaign CLI surface", () => {
  test("usage exposes campaigns and not legacy branch commands", () => {
    expect(USAGE).toContain("onyx campaign setup")
    expect(USAGE).toContain("onyx setup init")
    expect(USAGE).toContain("onyx setup validate")
    expect(USAGE).toContain("onyx setup require")
    expect(USAGE).toContain("onyx research start --campaign")
    expect(USAGE).toContain("onyx research should-stop")
    expect(USAGE).toContain("onyx research finish")
    expect(USAGE).toContain("onyx tools run")
    expect(USAGE).not.toContain("onyx campaign create")
    expect(USAGE).not.toContain("onyx branch create")
  })

  test("run refs are campaign scoped", () => {
    expect(clientRunRef("fast-eval")).toMatch(/^local\/fast-eval\//)
  })
})

describe("local research protocol", () => {
  test("accepts campaign outbox records", () => {
    const parsed = localResearchRecordSchema.parse({
      schemaVersion: 1,
      type: "campaign_experiment_logged",
      createdAt: "2026-06-17T12:00:00.000Z",
      runRef: "local/fast-eval/abc",
      campaignName: "fast-eval",
      name: "experiment-abcdef1",
      baseCommitSha: "abcdef1",
      resultCommitSha: "1234567",
      resultRef:
        "refs/onyx/experiments/11111111-1111-4111-8111-111111111111/local/fast-eval/abc",
      status: "succeeded",
      setupCompliance: {
        status: "passed",
        protectedPathsChanged: [],
        outOfScopePathsChanged: [],
        setupPathsChanged: [],
        notes: null,
      },
      primaryMetricName: "score",
      primaryMetricValue: 0.9,
      metrics: { score: 0.9 },
      agentNotes: {},
    })
    expect(parsed.type).toBe("campaign_experiment_logged")
  })

  test("uses shared git common-dir state and concurrent spool appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-outbox-"))
    const sibling = await mkdtemp(join(tmpdir(), "onyx-outbox-wt-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeFile(join(root, "README.md"), "test\n", "utf8")
    await runProcess("git", ["add", "README.md"], { cwd: root })
    await runProcess(
      "git",
      [
        "-c",
        "user.name=Onyx Test",
        "-c",
        "user.email=onyx@example.com",
        "commit",
        "-m",
        "init",
      ],
      { cwd: root }
    )
    await runProcess("git", ["worktree", "add", "-b", "lane", sibling], {
      cwd: root,
    })

    expect(await onyxStateDir(sibling)).toBe(await onyxStateDir(root))

    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        appendOutbox(root, {
          schemaVersion: 1,
          type: "campaign_experiment_logged",
          createdAt: "2026-06-17T12:00:00.000Z",
          runRef: `local/fast-eval/${index}`,
          campaignName: "fast-eval",
          name: `experiment-${index}`,
          baseCommitSha: "abcdef1",
          resultCommitSha: "1234567",
          resultRef: `refs/onyx/experiments/campaign/local/fast-eval/${index}`,
          status: "succeeded",
          setupCompliance: {
            status: "passed",
            protectedPathsChanged: [],
            outOfScopePathsChanged: [],
            setupPathsChanged: [],
            notes: null,
          },
          primaryMetricName: "score",
          primaryMetricValue: index,
          metrics: { score: index },
          agentNotes: {},
        })
      )
    )

    const { records, corrupt } = await readOutbox(sibling)
    expect(corrupt).toBe(0)
    expect(records).toHaveLength(100)
    const runRefs = records.map((record) => {
      if (record.type !== "campaign_experiment_logged") {
        throw new Error(`Unexpected outbox record type: ${record.type}`)
      }
      return record.runRef
    })
    expect(new Set(runRefs).size).toBe(100)
  })
})

describe("history helpers", () => {
  const local: LocalResearchHistoryRecord = {
    schemaVersion: 1,
    source: "local",
    campaignName: "fast-eval",
    runRef: "local/fast-eval/1",
    baseCommitSha: "abcdef1",
    resultCommitSha: "1234567",
    resultRef: "refs/onyx/experiments/campaign/local/fast-eval/1",
    status: "succeeded",
    name: "local",
    primaryMetricName: "score",
    primaryMetricValue: 0.8,
    metrics: { score: 0.8 },
    agentNotes: {},
    createdAt: "2026-06-17T12:00:00.000Z",
  }
  const api: LocalResearchHistoryRecord = {
    ...local,
    source: "api",
    experimentId: "11111111-1111-4111-8111-111111111111",
    campaignId: "22222222-2222-4222-8222-222222222222",
    primaryMetricValue: 0.9,
  }

  test("canonical API records replace provisional local rows by runRef", () => {
    expect(mergeHistory([api], [local])).toEqual([api])
  })
})

describe("rendering", () => {
  test("experiment table labels campaigns", () => {
    const lines = renderExperimentTable(
      [
        {
          source: "api",
          campaignName: "fast-eval",
          resultCommitSha: "1234567",
          status: "succeeded",
          name: "faster loop",
          primaryMetricName: "score",
          primaryMetricValue: 0.9,
          createdAt: "2026-06-17T12:00:00.000Z",
        },
      ],
      { columns: 100, color: false, nowMs: Date.now(), showCampaign: true }
    )
    expect(lines.join("\n")).toContain("CAMPAIGN")
    expect(lines.join("\n")).toContain("fast-eval")
  })
})

describe("metrics", () => {
  test("parses metric lines", () => {
    expect(parseMetricLines("METRIC score=1.25\n", "score")).toEqual({
      score: 1.25,
    })
  })
})

describe("setup modules", () => {
  test("fundamental modules remain required and conditional modules default optional", () => {
    const setup = normalizeSetupFile({
      schemaVersion: 1,
      goal: "Improve the target metric.",
      metric: { name: "score", unit: null, direction: "maximize" },
      projectPath: "",
      editableScope: ["src"],
      protectedPaths: ["onyx/setup.json", "onyx/validation.json"],
      commands: {
        evaluate: {
          command: "bash",
          args: ["onyx/eval.sh"],
          shell: false,
          cwd: "project",
          env: {},
          resources: [],
          timeoutSeconds: 600,
          leaseTimeoutSeconds: 120,
          outputLimitBytes: 4000,
        },
      },
      modules: {
        setup_spec: { required: false, reason: "attempted override" },
        hardware: { required: true, reason: "physical rig required" },
      },
    })

    expect(setupModuleRequirement(setup, "setup_spec").required).toBe(true)
    expect(setupModuleRequirement(setup, "reliability").required).toBe(false)
    expect(setupModuleRequirement(setup, "resources").required).toBe(true)
    expect(requiredSetupModules(setup)).toContain("setup_spec")
    expect(requiredSetupModules(setup)).toContain("resources")
    expect(requiredSetupModules(setup)).toContain("evaluation")
    expect(requiredSetupModules(setup)).toContain("agent")
  })

  test("setup commands write and print canonical module ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-setup-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })
      await commandSetupRequire({
        positional: ["setup", "require", "checks"],
        options: {},
      })
      await commandSetupRequire({
        positional: ["setup", "require", "agent_handoff"],
        options: {},
      })

      const setup = await readSetupFile(root, "")
      expect(Object.keys(setup.modules).sort()).toEqual([
        "agent",
        "evaluation",
        "project_scope",
        "reliability",
        "setup_spec",
      ])
      expect(setup.modules.reliability?.required).toBe(true)

      const lines: string[] = []
      const originalLog = console.log
      console.log = (...items: unknown[]) => {
        lines.push(items.join(" "))
      }
      try {
        await commandSetupModules({
          positional: ["setup", "modules"],
          options: {},
        })
      } finally {
        console.log = originalLog
      }
      expect(lines).toContain("agent: required; latest=not_run")
      expect(lines).toContain("evaluation: required; latest=not_run")
      expect(lines).toContain("reliability: required; latest=not_run")
      expect(lines.some((line) => line.startsWith("checks:"))).toBe(false)
      expect(lines.some((line) => line.startsWith("agent_handoff:"))).toBe(
        false
      )
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("setup validation is static and does not execute eval", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-validate-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })
      await writeFile(
        join(root, "onyx", "eval.sh"),
        ["#!/usr/bin/env bash", "exit 42", ""].join("\n"),
        "utf8"
      )
      await commandSetupValidate({
        positional: ["setup", "validate"],
        options: {},
      })

      const validation = await readValidationFile(root, "")
      expect(validation?.status).toBe("passed")
      expect(
        validation?.modules.find((item) => item.moduleId === "evaluation")
          ?.status
      ).toBe("passed")
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe("tool api", () => {
  test("runs manifest commands from the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-tools-"))
    await runProcess("git", ["init"], { cwd: root })
    await mkdir(join(root, "onyx"), { recursive: true })
    await writeFile(
      join(root, "onyx", "tool-api.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        commands: {
          evaluate: {
            command: "printf 'METRIC score=2\\n'",
            timeoutSeconds: 5,
          },
        },
      })}\n`,
      "utf8"
    )

    const result = await runToolCommand({
      root,
      projectPath: "",
      name: "evaluate",
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain("METRIC score=2")
  })
})
