import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"

import type { LocalResearchHistoryRecord } from "./protocol"
import {
  appendOutbox,
  assertSetupCommitted,
  campaignStateKey,
  clientRunRef,
  commandCampaignCreate,
  commandExpLog,
  commandExpRun,
  commandExpList,
  commandKnowledgeAdd,
  commandKnowledgeList,
  commandListen,
  commandResearchBrief,
  commandResearchFinish,
  commandResearchStart,
  commandResearchHypothesisAdd,
  commandResearchHypotheses,
  commandResearchRun,
  commandResearchStatus,
  commandResearchStop,
  commandStatus,
  commandSummaryList,
  commandSummaryUpsert,
  commandSetupInit,
  commandSetupValidate,
  commandSync,
  commandWorkerRun,
  commandWorkflowStatus,
  finalizeHypothesisAttempt,
  localResearchRecordSchema,
  mergeHistory,
  main,
  normalizeProjectPath,
  normalizeSetupFile,
  normalizeValidationFile,
  onyxStateDir,
  parseArgs,
  parseMetricLines,
  parseWorkflowMetricLines,
  readOutbox,
  readState,
  readSetupFile,
  readValidationFile,
  readWorkerLaunchManifests,
  renderExperimentTable,
  runToolCommand,
  setupHash,
  summarizeWorkerOutput,
  updateState,
  USAGE,
  writeSetupFile,
  writeState,
  writeValidationFile,
} from "./onyx"
import {
  createLocalCampaign,
  createLocalKnowledge,
  createLocalSession,
  getLocalSessionState,
  listLocalHypotheses,
  listLocalAttempts,
  listLocalExperimentHistory,
  listLocalKnowledge,
  listLocalSummaries,
  localCampaignByName,
  logLocalExperiment,
  pendingResearchSyncCount,
  readWorkflowRun,
  researchDbPath,
  registerLocalWorker,
  recordLocalWorkerHeartbeat,
  upsertLocalSummary,
  upsertWorkflowRun,
  writeLocalAttempt,
} from "./lib/research-db"
import { runProcess } from "./lib/process"
import { writeWorkerLaunchManifest } from "./lib/worker-launcher"

async function commitAll(root: string, message: string) {
  await runProcess("git", ["add", "-A"], { cwd: root })
  await runProcess(
    "git",
    [
      "-c",
      "user.name=Onyx Test",
      "-c",
      "user.email=onyx@example.com",
      "commit",
      "-m",
      message,
    ],
    { cwd: root }
  )
}

async function writeResearchSmokeRepo() {
  const root = await mkdtemp(join(tmpdir(), "onyx-research-smoke-"))
  await runProcess("git", ["init"], { cwd: root })
  await writeFile(join(root, "README.md"), "test\n", "utf8")
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src", "controller.txt"), "base\n", "utf8")
  await mkdir(join(root, "onyx", "tools", "evaluation"), { recursive: true })
  await writeFile(
    join(root, "onyx", "onyx.md"),
    "Use the configured eval command and keep changes small.\n",
    "utf8"
  )
  await writeFile(
    join(root, "onyx", "tools", "evaluation", "run.sh"),
    "#!/usr/bin/env sh\nprintf 'METRIC score=1.25\\n'\n",
    "utf8"
  )
  const setup = normalizeSetupFile({
    schemaVersion: 1,
    goal: "Improve score.",
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
        command: "printf 'METRIC score=1.25\\n'",
        args: [],
        shell: true,
        cwd: "project",
        env: {},
        resources: [],
        timeoutSeconds: 5,
        leaseTimeoutSeconds: 5,
        outputLimitBytes: 4000,
      },
    },
    workflow: [
      {
        id: "edit",
        agent: "Make one scoped code change, commit it, then resume.",
      },
      { id: "evaluate", run: "evaluation.run", metric: true },
    ],
  })
  await writeSetupFile(root, "", setup)
  const now = new Date().toISOString()
  await writeValidationFile(
    root,
    "",
    normalizeValidationFile({
      schemaVersion: 1,
      status: "passed",
      setupHash: setupHash(setup),
      generatedAt: now,
      summary: null,
      checks: [
        {
          id: "setup_schema",
          status: "passed",
          message: "setup ok",
          evidence: {},
        },
        {
          id: "metric_capture",
          status: "passed",
          message: "metric ok",
          evidence: {},
        },
        {
          id: "metric_tool_readiness",
          status: "passed",
          message: "metric tool ok",
          evidence: {
            toolId: "evaluation.run",
            exitCode: 0,
            timedOut: false,
            primaryMetric: { name: "score", value: 1.25 },
            secondaryMetricNames: [],
            outputSummary: "METRIC score=1.25",
            checkedAt: now,
            error: null,
          },
        },
      ],
    })
  )
  await commitAll(root, "init")
  const baseCommitSha = (
    await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim()
  const campaignId = "11111111-1111-4111-8111-111111111111"
  const campaignName = "smoke"
  await writeState(root, {
    projectPath: "",
    activeCampaign: campaignName,
    campaigns: {
      [campaignStateKey("", campaignName)]: {
        campaignId,
        projectPath: "",
        baseCommitSha,
        metricName: "score",
        metricUnit: null,
        metricDirection: "maximize",
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
    },
    sessions: {
      "22222222-2222-4222-8222-222222222222": {
        campaignName,
        campaignId,
        maxIterations: 10,
        endTimeMs: Date.now() + 60_000,
        status: "running",
      },
    },
  })

  return { root, baseCommitSha, campaignId, campaignName }
}

async function addBareOrigin(root: string) {
  const origin = await mkdtemp(join(tmpdir(), "onyx-origin-"))
  await runProcess("git", ["init", "--bare"], { cwd: origin })
  await runProcess("git", ["remote", "add", "origin", origin], { cwd: root })
  return origin
}

function testCampaign({
  campaignId,
  campaignName,
  baseCommitSha,
}: {
  campaignId: string
  campaignName: string
  baseCommitSha: string
}) {
  return {
    id: campaignId,
    projectId: "44444444-4444-4444-8444-444444444444",
    name: campaignName,
    description: "Improve score.",
    baseCommitSha,
    metricName: "score",
    metricUnit: null,
    metricDirection: "maximize" as const,
    bestMetricValue: null,
    bestCommitSha: null,
    experimentCount: 0,
    promotionRefName: null,
  }
}

function testHypothesis({
  campaignId,
  baseCommitSha,
}: {
  campaignId: string
  baseCommitSha: string
}) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    campaignId,
    createdBySessionId: "22222222-2222-4222-8222-222222222222",
    name: "hypothesis-1",
    description: null,
    status: "active" as const,
    baseCommitSha,
    bestExperimentId: null,
    bestMetricValue: null,
    lastWorkedAt: null,
    plan: {
      focus: "Scoped text tuning",
      statement: "A small scoped change can improve the score.",
      startingPoints: ["src/controller.txt"],
      avoidList: ["onyx/"],
      successSignals: ["METRIC score improves"],
      giveUpSignals: ["No clean scoped change"],
    },
    metadata: {},
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  }
}

async function withMockResearchApi(
  handler: (request: { method: string; path: string; body: unknown }) => {
    status?: number
    body: unknown
  },
  run: () => Promise<void>
) {
  const originalFetch = globalThis.fetch
  const previousApiUrl = process.env.ONYX_API_URL
  const previousApiKey = process.env.ONYX_API_KEY
  process.env.ONYX_API_URL = "https://api.onyx.test"
  process.env.ONYX_API_KEY = "test-key"
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const response = handler({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body,
    })
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    if (previousApiUrl === undefined) {
      delete process.env.ONYX_API_URL
    } else {
      process.env.ONYX_API_URL = previousApiUrl
    }
    if (previousApiKey === undefined) {
      delete process.env.ONYX_API_KEY
    } else {
      process.env.ONYX_API_KEY = previousApiKey
    }
  }
}

describe("campaign CLI surface", () => {
  test("usage exposes campaigns and not legacy branch commands", () => {
    expect(USAGE).toContain("onyx campaign setup")
    expect(USAGE).toContain("onyx setup init")
    expect(USAGE).toContain("onyx setup validate")
    expect(USAGE).not.toContain("onyx setup require")
    expect(USAGE).toContain("onyx workflow status")
    expect(USAGE).toContain("onyx research start --campaign")
    expect(USAGE).toContain("onyx research run --campaign")
    expect(USAGE).toContain("onyx research hypotheses --example")
    expect(USAGE).toContain(
      "onyx research hypothesis add (--campaign <name> | --session <id>)"
    )
    expect(USAGE).toContain("onyx research should-stop")
    expect(USAGE).toContain("onyx research finish")
    expect(USAGE).toContain("onyx knowledge list")
    expect(USAGE).toContain("onyx tools run")
    expect(USAGE).not.toContain("onyx campaign create")
    expect(USAGE).not.toContain("onyx branch create")
  })

  test("run refs are campaign scoped", () => {
    expect(clientRunRef("fast-eval")).toMatch(/^local\/fast-eval\//)
  })

  test("repeated options preserve last option while exposing all values", () => {
    const args = parseArgs([
      "--agent",
      "codex",
      "--agent",
      "claude",
      "--starting-point",
      "first",
      "--starting-point=second",
    ])

    expect(args.options.agent).toBe("claude")
    expect(args.options["starting-point"]).toBe("second")
    expect(args.optionLists?.["starting-point"]).toEqual(["first", "second"])
  })

  test("global help returns usage before subcommand dispatch", async () => {
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      lines.push(items.join(" "))
    }
    try {
      await main(["research", "start", "--help"])
    } finally {
      console.log = originalLog
    }

    expect(lines.join("\n")).toContain("onyx research start --campaign")
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
    await runProcess("git", ["worktree", "add", "-b", "hypothesis", sibling], {
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

  test("serializes concurrent state updates through the local lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-state-lock-"))
    await runProcess("git", ["init"], { cwd: root })

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        updateState(root, (state) => {
          state.campaigns = state.campaigns ?? {}
          state.campaigns[`campaign-${index}`] = {
            campaignId: `campaign-${index}`,
          }
        })
      )
    )

    const state = await readState(root)
    expect(Object.keys(state.campaigns ?? {})).toHaveLength(50)
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

  test("exp list includes unlogged local SQLite attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-exp-list-attempt-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeFile(join(root, "README.md"), "test\n", "utf8")
    await commitAll(root, "init")
    await writeLocalAttempt({
      root,
      record: {
        schemaVersion: 1,
        createdAt: "2026-06-17T12:00:00.000Z",
        runRef: "local/fast-eval/unlogged",
        campaignName: "fast-eval",
        projectPath: "",
        baseCommitSha: "abcdef1",
        resultCommitSha: "1234567",
        resultRef: "refs/onyx/experiments/campaign/local/fast-eval/unlogged",
        status: "succeeded",
        setupCompliance: {
          status: "passed",
          protectedPathsChanged: [],
          outOfScopePathsChanged: [],
          setupPathsChanged: [],
          notes: null,
        },
        primaryMetricName: "score",
        primaryMetricValue: 1,
        metrics: { score: 1 },
        agentNotes: {},
        checks: null,
        durationMs: null,
        startedAt: null,
        completedAt: null,
        outputSummary: null,
      },
    })

    const previousCwd = process.cwd()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }
    try {
      process.chdir(root)
      await commandExpList({
        positional: ["exp", "list"],
        options: { json: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const rows = JSON.parse(logs.join("\n")) as LocalResearchHistoryRecord[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.runRef).toBe("local/fast-eval/unlogged")
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

  test("parses workflow primary and secondary metric lines", () => {
    expect(parseWorkflowMetricLines("METRIC score=1.25\n", "score")).toEqual({
      metrics: { score: 1.25 },
      error: null,
    })
    expect(
      parseWorkflowMetricLines(
        "METRIC score=1.25\nMETRIC control_effort=0.4\n",
        "score"
      )
    ).toEqual({
      metrics: { score: 1.25, control_effort: 0.4 },
      error: null,
    })
  })

  test("rejects workflow metric output without the configured primary", () => {
    expect(
      parseWorkflowMetricLines("METRIC control_effort=0.4\n", "score").error
    ).toContain("without the primary metric")
  })

  test("rejects duplicate workflow metric names", () => {
    expect(
      parseWorkflowMetricLines("METRIC score=1\nMETRIC score=2\n", "score")
        .error
    ).toContain("Duplicate METRIC score")
  })

  test("rejects invalid workflow metric values", () => {
    expect(parseWorkflowMetricLines("METRIC score=fast\n", "score").error).toBe(
      "Invalid METRIC line: METRIC score=fast"
    )
  })
})

describe("exp run", () => {
  test("--no-log points diagnostics to tools run", async () => {
    const { root } = await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await expect(
        commandExpRun({
          positional: ["exp", "run"],
          options: { "no-log": "true", timeout: "5" },
        })
      ).rejects.toThrow("onyx tools run <tool-id>")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("requires setup in the selected base commit instead of falling back to the working tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-exp-base-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeFile(join(root, "README.md"), "base\n", "utf8")
    await commitAll(root, "base without setup")
    const baseWithoutSetup = (
      await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim()

    await mkdir(join(root, "onyx", "tools", "evaluation"), {
      recursive: true,
    })
    await writeFile(
      join(root, "onyx", "onyx.md"),
      "Use the configured eval command and keep changes small.\n",
      "utf8"
    )
    const setup = normalizeSetupFile({
      schemaVersion: 1,
      goal: "Improve score.",
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
          command: "printf 'METRIC score=1.25\\n'",
          args: [],
          shell: true,
          cwd: "project",
          env: {},
          resources: [],
          timeoutSeconds: 5,
          leaseTimeoutSeconds: 5,
          outputLimitBytes: 4000,
        },
      },
      workflow: [
        {
          id: "edit",
          agent: "Make one scoped code change, commit it, then resume.",
        },
        { id: "evaluate", run: "evaluation.run", metric: true },
      ],
    })
    await writeSetupFile(root, "", setup)
    const now = new Date().toISOString()
    await writeValidationFile(
      root,
      "",
      normalizeValidationFile({
        schemaVersion: 1,
        status: "passed",
        setupHash: setupHash(setup),
        generatedAt: now,
        summary: null,
        checks: [
          {
            id: "setup_schema",
            status: "passed",
            message: "setup ok",
            evidence: {},
          },
          {
            id: "metric_capture",
            status: "passed",
            message: "metric ok",
            evidence: {},
          },
          {
            id: "metric_tool_readiness",
            status: "passed",
            message: "metric tool ok",
            evidence: {
              toolId: "evaluation.run",
              exitCode: 0,
              timedOut: false,
              primaryMetric: { name: "score", value: 1.25 },
              secondaryMetricNames: [],
              outputSummary: "METRIC score=1.25",
              checkedAt: now,
              error: null,
            },
          },
        ],
      })
    )
    await commitAll(root, "add setup")
    await createLocalCampaign({
      root,
      name: "smoke",
      description: "Improve score.",
      projectPath: "",
      baseCommitSha: (
        await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
      ).stdout.trim(),
      setup,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })

    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await expect(
        commandExpRun({
          positional: ["exp", "run"],
          options: { campaign: "smoke", base: baseWithoutSetup, timeout: "5" },
        })
      ).rejects.toThrow("does not contain a valid Onyx setup")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("pauses, resumes, and writes a terminal local attempt", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    const previousExitCode = process.exitCode
    const originalLog = console.log
    console.log = () => {}
    try {
      process.chdir(root)
      process.exitCode = undefined
      const paused = await commandExpRun({
        positional: ["exp", "run"],
        options: { campaign: "smoke", base: baseCommitSha, timeout: "5" },
      })
      expect(paused?.status).toBe("paused")
      if (!paused || !("id" in paused)) throw new Error("expected paused run")
      await commandWorkflowStatus({
        positional: ["workflow", "status"],
        options: { run: paused!.id, json: "true" },
      })
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "src", "candidate.txt"), "candidate\n", "utf8")
      await commitAll(root, "candidate")
      const completed = await commandExpRun({
        positional: ["exp", "run"],
        options: { resume: paused!.id, timeout: "5" },
      })
      expect(completed?.status).toBe("succeeded")
      const latest = await commandWorkflowStatus({
        positional: ["workflow", "status"],
        options: { campaign: "smoke", json: "true" },
      })
      expect(latest?.run.id).toBe(paused.id)
      await expect(
        commandWorkflowStatus({
          positional: ["workflow", "status"],
          options: { campaign: "smoke", active: "true", json: "true" },
        })
      ).rejects.toThrow("No active workflow runs exist")
      const attempts = await listLocalAttempts(root)
      expect(attempts[0]?.runRef).toBe(paused?.runRef)
      expect(attempts[0]?.primaryMetricValue).toBe(1.25)
    } finally {
      process.chdir(previousCwd)
      process.exitCode = previousExitCode
      console.log = originalLog
    }
  })

  test("--active excludes blocked workflow runs and --blocked shows them", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = () => {}
    try {
      process.chdir(root)
      await upsertWorkflowRun({
        root,
        run: {
          id: "workflow-blocked",
          campaignId,
          campaignName,
          projectPath: "",
          runRef: "local/smoke/blocked",
          baseCommitSha,
          resultCommitSha: null,
          resultRef: `refs/onyx/experiments/${campaignId}/local/smoke/blocked`,
          setupHash: setupHash(await readSetupFile(root, "")),
          status: "blocked",
          currentStepIndex: 0,
          metrics: {},
          blockReason:
            "Workflow attempts must contain exactly one result commit over the base commit.",
          createdAt: "2026-06-20T00:00:00.000Z",
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: null,
          updatedAt: "2026-06-20T00:00:00.000Z",
          sessionId: "22222222-2222-4222-8222-222222222222",
          workerId: "77777777-7777-4777-8777-777777777777",
          hypothesisId: "66666666-6666-4666-8666-666666666666",
        },
      })

      await expect(
        commandWorkflowStatus({
          positional: ["workflow", "status"],
          options: { campaign: campaignName, active: "true", json: "true" },
        })
      ).rejects.toThrow("No active workflow runs exist")
      const blocked = await commandWorkflowStatus({
        positional: ["workflow", "status"],
        options: { campaign: campaignName, blocked: "true", json: "true" },
      })
      expect(blocked?.run.id).toBe("workflow-blocked")
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }
  })
})

describe("worker finalization", () => {
  test("measures and logs exactly one unlogged worker commit", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    await addBareOrigin(root)
    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = () => {}
    try {
      process.chdir(root)
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "src", "candidate.txt"), "candidate\n", "utf8")
      await commitAll(root, "candidate")
      const head = (
        await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
      ).stdout.trim()

      const manifest = await finalizeHypothesisAttempt({
        root,
        worktree: root,
        campaign: testCampaign({ campaignId, campaignName, baseCommitSha }),
        hypothesis: testHypothesis({ campaignId, baseCommitSha }),
        sessionId: "22222222-2222-4222-8222-222222222222",
        workerId: "77777777-7777-4777-8777-777777777777",
        workerBranch: "onyx/test/finalization",
        args: { positional: ["worker", "run"], options: { offline: "true" } },
        workerFailed: false,
      })

      expect(manifest.finalizationStatus).toBe("measured_and_logged")
      expect(manifest.commitSha).toBe(head)
      expect(manifest.measurementBaseCommitSha).toBe(baseCommitSha)
      expect(manifest.unloggedCommitCount).toBe(1)
      expect(manifest.workerBranchPushStatus).toBe("pushed")
      const history = await listLocalExperimentHistory(root)
      expect(history).toHaveLength(1)
      expect(history[0]?.resultCommitSha).toBe(head)
      expect(history[0]?.baseCommitSha).toBe(baseCommitSha)
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }
  })

  test("treats an already logged worker HEAD as already_logged", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    await addBareOrigin(root)
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "src", "candidate.txt"), "candidate\n", "utf8")
      await commitAll(root, "candidate")
      const head = (
        await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
      ).stdout.trim()
      const hypothesis = testHypothesis({ campaignId, baseCommitSha })
      await writeLocalAttempt({
        root,
        record: {
          schemaVersion: 1,
          createdAt: "2026-06-20T00:00:00.000Z",
          runRef: "local/smoke/already-logged",
          campaignName,
          projectPath: "",
          baseCommitSha,
          resultCommitSha: head,
          resultRef: `refs/onyx/experiments/${campaignId}/local/smoke/already-logged`,
          status: "succeeded",
          setupCompliance: {
            status: "passed",
            protectedPathsChanged: [],
            outOfScopePathsChanged: [],
            setupPathsChanged: [],
            notes: null,
          },
          primaryMetricName: "score",
          primaryMetricValue: 1.25,
          metrics: { score: 1.25 },
          agentNotes: {},
          checks: null,
          durationMs: null,
          startedAt: null,
          completedAt: null,
          outputSummary: null,
          hypothesisId: hypothesis.id,
          sessionId: hypothesis.createdBySessionId,
          workerId: "77777777-7777-4777-8777-777777777777",
        },
      })

      const manifest = await finalizeHypothesisAttempt({
        root,
        worktree: root,
        campaign: testCampaign({ campaignId, campaignName, baseCommitSha }),
        hypothesis,
        sessionId: hypothesis.createdBySessionId,
        workerId: "77777777-7777-4777-8777-777777777777",
        workerBranch: "onyx/test/already-logged",
        args: { positional: ["worker", "run"], options: { offline: "true" } },
        workerFailed: false,
      })

      expect(manifest.finalizationStatus).toBe("already_logged")
      expect(manifest.commitSha).toBe(head)
      expect(manifest.unloggedCommitCount).toBe(0)
      const attempts = await listLocalAttempts(root)
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.runRef).toBe("local/smoke/already-logged")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("salvages multiple unlogged commits without creating a workflow run", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    await addBareOrigin(root)
    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = () => {}
    try {
      process.chdir(root)
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "src", "candidate.txt"), "candidate\n", "utf8")
      await commitAll(root, "candidate one")
      await writeFile(
        join(root, "src", "candidate-2.txt"),
        "candidate\n",
        "utf8"
      )
      await commitAll(root, "candidate two")

      const manifest = await finalizeHypothesisAttempt({
        root,
        worktree: root,
        campaign: testCampaign({ campaignId, campaignName, baseCommitSha }),
        hypothesis: testHypothesis({ campaignId, baseCommitSha }),
        sessionId: "22222222-2222-4222-8222-222222222222",
        workerId: "77777777-7777-4777-8777-777777777777",
        workerBranch: "onyx/test/multi-commit",
        args: { positional: ["worker", "run"], options: { offline: "true" } },
        workerFailed: false,
      })

      expect(manifest.finalizationStatus).toBe("salvaged_unmeasured")
      expect(manifest.unloggedCommitCount).toBe(2)
      expect(manifest.error).toContain("exactly one unlogged HEAD commit")
      expect(await listLocalAttempts(root)).toHaveLength(0)
      await expect(
        commandWorkflowStatus({
          positional: ["workflow", "status"],
          options: { campaign: campaignName, active: "true", json: "true" },
        })
      ).rejects.toThrow("No active workflow runs exist")
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }
  })
})

describe("exp log", () => {
  test("preserves explicit scoped run attempts and logs each run ref once", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const sessionId = "22222222-2222-4222-8222-222222222222"
    const workerOneId = "77777777-7777-4777-8777-777777777771"
    const workerTwoId = "77777777-7777-4777-8777-777777777772"
    const hypothesisOneId = "88888888-8888-4888-8888-888888888881"
    const hypothesisTwoId = "88888888-8888-4888-8888-888888888882"
    const makeRun = (
      workerId: string,
      hypothesisId: string,
      value: number
    ) => ({
      schemaVersion: 1 as const,
      createdAt: `2026-06-20T00:00:0${value}.000Z`,
      runRef: `local/smoke/${workerId}`,
      campaignName,
      projectPath: "",
      baseCommitSha,
      resultCommitSha: baseCommitSha,
      resultRef: `refs/onyx/experiments/${campaignId}/local/smoke/${workerId}`,
      status: "succeeded" as const,
      setupCompliance: {
        status: "passed" as const,
        protectedPathsChanged: [],
        outOfScopePathsChanged: [],
        setupPathsChanged: [],
        notes: null,
      },
      primaryMetricName: "score",
      primaryMetricValue: value,
      metrics: { score: value },
      agentNotes: {},
      checks: null,
      durationMs: value,
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: `2026-06-20T00:00:0${value}.000Z`,
      outputSummary: `worker ${workerId}`,
      sessionId,
      workerId,
      hypothesisId,
    })
    const workerOne = makeRun(workerOneId, hypothesisOneId, 1)
    const workerTwo = makeRun(workerTwoId, hypothesisTwoId, 2)
    await writeLocalAttempt({ root, record: workerOne })
    await writeLocalAttempt({ root, record: workerTwo })

    const previousCwd = process.cwd()
    const originalLog = console.log
    const logs: string[] = []
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""))
    }
    try {
      process.chdir(root)
      await commandExpLog({
        positional: ["exp", "log"],
        options: {
          campaign: campaignName,
          "run-ref": workerTwo.runRef,
          session: sessionId,
          worker: workerTwoId,
          hypothesis: hypothesisTwoId,
          name: "worker-two-result",
          description: "logged the second worker",
        },
      })
      await commandExpLog({
        positional: ["exp", "log"],
        options: {
          campaign: campaignName,
          "run-ref": workerTwo.runRef,
          session: sessionId,
          worker: workerTwoId,
          hypothesis: hypothesisTwoId,
          name: "mutated-worker-two-result",
          description: "this repeat should not mutate",
        },
      })
      expect(logs.join("\n")).toContain(
        `Experiment ${workerTwo.runRef} is already recorded for campaign ${campaignName}`
      )
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const records = await listLocalExperimentHistory(root)
    const logged = records.find((record) => record.runRef === workerTwo.runRef)
    expect(logged).toMatchObject({
      name: "worker-two-result",
      description: "logged the second worker",
      workerId: workerTwoId,
      hypothesisId: hypothesisTwoId,
      primaryMetricValue: 2,
      outputSummary: `worker ${workerTwoId}`,
    })
    expect(
      records.filter((record) => record.runRef === workerTwo.runRef)
    ).toHaveLength(1)
    const remainingRuns = await listLocalAttempts(root)
    expect(new Set(remainingRuns.map((run) => run.runRef))).toEqual(
      new Set([workerOne.runRef, workerTwo.runRef])
    )

    const listLogs: string[] = []
    console.log = (message?: unknown) => {
      listLogs.push(String(message ?? ""))
    }
    try {
      process.chdir(root)
      await commandExpList({
        positional: ["exp", "list"],
        options: { campaign: campaignName, json: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }
    const listed = JSON.parse(listLogs.join("\n")) as LocalResearchHistoryRecord[]
    expect(
      listed.filter((record) => record.runRef === workerTwo.runRef)
    ).toHaveLength(1)
  })

  test("--run-ref fails clearly when the measured run is missing", async () => {
    const { root, campaignName } = await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await expect(
        commandExpLog({
          positional: ["exp", "log"],
          options: {
            campaign: campaignName,
            "run-ref": "local/smoke/missing",
            name: "missing",
            description: "missing",
          },
        })
      ).rejects.toThrow("No measured run found for --run-ref")
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe("research start", () => {
  test("accepts inline hypothesis JSON and prints budgeted worker commands", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const sessionId = "22222222-2222-4222-8222-222222222222"
    const hypothesisId = "66666666-6666-4666-8666-666666666666"
    const campaign = {
      id: campaignId,
      projectId: "44444444-4444-4444-8444-444444444444",
      name: campaignName,
      description: "Improve score.",
      baseCommitSha,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: null,
    }
    const plan = {
      focus: "Inline search",
      statement: "Inline JSON can seed the session.",
      startingPoints: ["src"],
      avoidList: ["onyx/setup.json"],
      successSignals: ["METRIC score improves"],
      giveUpSignals: ["No movement"],
    }
    const logs: string[] = []
    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }

    try {
      process.chdir(root)
      await withMockResearchApi(
        (request) => {
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/overview`
          ) {
            return {
              body: {
                data: {
                  campaign,
                  workers: [],
                  hypotheses: [],
                  summaries: [],
                  knowledge: [],
                  bestExperiment: null,
                  latestExperiments: [],
                  counts: {
                    experiments: 0,
                    hypothesisCount: 0,
                    activeWorkers: 0,
                  },
                },
              },
            }
          }
          if (
            request.method === "POST" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/sessions`
          ) {
            return {
              status: 201,
              body: {
                data: {
                  session: {
                    id: sessionId,
                    campaignId,
                    name: "session",
                    status: "running",
                    workerTarget: 1,
                    metadata: (request.body as { metadata: unknown }).metadata,
                  },
                  hypotheses: [
                    {
                      id: hypothesisId,
                      campaignId,
                      createdBySessionId: sessionId,
                      name: "inline",
                      description: null,
                      status: "active",
                      baseCommitSha,
                      bestExperimentId: null,
                      bestMetricValue: null,
                      lastWorkedAt: null,
                      plan,
                      metadata: {},
                      createdAt: "2026-06-20T00:00:00.000Z",
                      updatedAt: "2026-06-20T00:00:00.000Z",
                    },
                  ],
                },
              },
            }
          }
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/sessions/${sessionId}/state`
          ) {
            return {
              body: {
                data: {
                  session: {
                    id: sessionId,
                    campaignId,
                    name: "session",
                    status: "running",
                    workerTarget: 1,
                    metadata: {},
                  },
                  campaign,
                  latestExperiments: [],
                  bestExperiment: null,
                  hypotheses: [],
                  workers: [],
                  summaries: [],
                  knowledge: [],
                  updatedAt: "2026-06-20T00:00:00.000Z",
                },
              },
            }
          }
          throw new Error(
            `Unexpected API call ${request.method} ${request.path}`
          )
        },
        () =>
          commandResearchStart({
            positional: ["research", "start"],
            options: {
              campaign: campaignName,
              workers: "1",
              agent: "claude",
              hypotheses: JSON.stringify([plan]),
              "max-iterations": "3",
              "max-minutes": "10",
            },
          })
      )
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const sessionLine = logs.find((line) =>
      line.startsWith("Research session: ")
    )
    expect(sessionLine).toMatch(/^Research session: [0-9a-f-]{36}$/)
    const generatedSessionId = sessionLine?.replace("Research session: ", "")
    const workerLine = logs.find((line) =>
      line.startsWith("- worker 1: hypothesis-1: Inline search")
    )
    expect(workerLine).toContain(
      `onyx worker run --session ${generatedSessionId} --hypothesis `
    )
    expect(workerLine).toContain(
      "--agent claude --max-iterations 3 --max-minutes 10"
    )
  })

  test("rejects a hypotheses file path", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const campaign = {
      id: campaignId,
      projectId: "44444444-4444-4444-8444-444444444444",
      name: campaignName,
      description: "Improve score.",
      baseCommitSha,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: null,
    }
    const path = join(root, "onyx", "hypotheses.json")
    await writeFile(path, "[]\n", "utf8")
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await withMockResearchApi(
        (request) => {
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/overview`
          ) {
            return {
              body: {
                data: {
                  campaign,
                  workers: [],
                  hypotheses: [],
                  summaries: [],
                  knowledge: [],
                  bestExperiment: null,
                  latestExperiments: [],
                  counts: {
                    experiments: 0,
                    hypothesisCount: 0,
                    activeWorkers: 0,
                  },
                },
              },
            }
          }
          throw new Error(
            `Unexpected API call ${request.method} ${request.path}`
          )
        },
        async () => {
          await expect(
            commandResearchStart({
              positional: ["research", "start"],
              options: {
                campaign: campaignName,
                hypotheses: path,
              },
            })
          ).rejects.toThrow("--hypotheses must be an inline JSON array")
        }
      )
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe("automated research smoke", () => {
  async function createSupervisorRunCampaign({
    root,
    baseCommitSha,
    campaignName,
  }: {
    root: string
    baseCommitSha: string
    campaignName: string
  }) {
    const setup = await readSetupFile(root, "")
    const campaign = await createLocalCampaign({
      root,
      name: campaignName,
      description: "Improve score.",
      projectPath: "",
      baseCommitSha,
      setup,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    await writeState(root, {
      projectPath: "",
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: campaign.id,
          projectPath: "",
          baseCommitSha,
          metricName: "score",
          metricUnit: null,
          metricDirection: "maximize",
        },
      },
      sessions: {},
    })
    return campaign
  }

  function supervisorPlans(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      focus: `Scoped text tuning ${index + 1}`,
      statement: `A small scoped change ${index + 1} can improve the score.`,
      startingPoints: ["src/controller.txt"],
      avoidList: ["onyx/"],
      successSignals: ["METRIC score improves"],
      giveUpSignals: ["No clean scoped change"],
    }))
  }

  function fastWorkerCommand() {
    return [
      "test -n \"$ONYX_SETUP_FILE\"",
      "test -n \"$ONYX_VALIDATION_FILE\"",
      "test -n \"$ONYX_RESEARCH_SPEC_FILE\"",
      "test -z \"${ONYX_BRIEF_FILE:-}\"",
      "test -z \"${ONYX_SESSION_STATE_FILE:-}\"",
      "onyx research brief --campaign \"$ONYX_CAMPAIGN_NAME\" --session \"$ONYX_SESSION_ID\" --hypothesis \"$ONYX_HYPOTHESIS_ID\" --json >/dev/null",
      "printf \"worker $ONYX_WORKER_ID\\n\" >> src/controller.txt",
      "git add src/controller.txt",
      "git -c user.name='Onyx Test' -c user.email='onyx@example.com' commit -m \"smoke worker $ONYX_WORKER_ID\"",
      "printf 'fast worker done\\n'",
    ].join(" && ")
  }

  test("research run blocks when metric readiness validation is missing", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    const campaignName = "missing-readiness"
    await createSupervisorRunCampaign({ root, baseCommitSha, campaignName })
    const setup = await readSetupFile(root, "")
    await writeValidationFile(
      root,
      "",
      normalizeValidationFile({
        schemaVersion: 1,
        status: "passed",
        setupHash: setupHash(setup),
        generatedAt: new Date().toISOString(),
        summary: null,
        checks: [
          {
            id: "setup_schema",
            status: "passed",
            message: "setup ok",
            evidence: {},
          },
          {
            id: "metric_capture",
            status: "passed",
            message: "metric ok",
            evidence: {},
          },
        ],
      })
    )

    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await expect(
        commandResearchRun({
          positional: ["research", "run"],
          options: {
            campaign: campaignName,
            workers: "1",
            "worker-command": fastWorkerCommand(),
            hypotheses: JSON.stringify(supervisorPlans(1)),
            offline: "true",
          },
        })
      ).rejects.toThrow("has not proven metric tool readiness")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("research run blocks when metric readiness validation failed", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    const campaignName = "failed-readiness"
    await createSupervisorRunCampaign({ root, baseCommitSha, campaignName })
    const setup = await readSetupFile(root, "")
    await writeValidationFile(
      root,
      "",
      normalizeValidationFile({
        schemaVersion: 1,
        status: "failed",
        setupHash: setupHash(setup),
        generatedAt: new Date().toISOString(),
        summary: null,
        checks: [
          {
            id: "setup_schema",
            status: "passed",
            message: "setup ok",
            evidence: {},
          },
          {
            id: "metric_capture",
            status: "passed",
            message: "metric ok",
            evidence: {},
          },
          {
            id: "metric_tool_readiness",
            status: "failed",
            message: "metric not ready",
            evidence: {},
          },
        ],
      })
    )

    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await expect(
        commandResearchRun({
          positional: ["research", "run"],
          options: {
            campaign: campaignName,
            workers: "1",
            "worker-command": fastWorkerCommand(),
            hypotheses: JSON.stringify(supervisorPlans(1)),
            offline: "true",
          },
        })
      ).rejects.toThrow("metric_tool_readiness")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("research run accepts passed metric readiness before later clean-tree checks", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    const campaignName = "passed-readiness"
    await createSupervisorRunCampaign({ root, baseCommitSha, campaignName })
    await writeFile(join(root, "scratch.txt"), "dirty\n", "utf8")

    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await expect(
        commandResearchRun({
          positional: ["research", "run"],
          options: {
            campaign: campaignName,
            workers: "1",
            "worker-command": fastWorkerCommand(),
            hypotheses: JSON.stringify(supervisorPlans(1)),
            offline: "true",
          },
        })
      ).rejects.toThrow("Main checkout must be clean before running research")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("research brief renders live local campaign memory as markdown and json", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    const campaignName = "brief-smoke"
    const campaign = await createSupervisorRunCampaign({
      root,
      baseCommitSha,
      campaignName,
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "brief-session",
      workerTarget: 1,
      hypotheses: supervisorPlans(1),
      maxIterations: 3,
    })
    const hypothesis = session.hypotheses[0]!
    const worker = await registerLocalWorker({
      root,
      campaignId: campaign.id,
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      workerName: "brief-worker",
      agentKind: "custom",
    })
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      status: "running",
      phase: "measuring",
      progressMessage: "testing current digest",
    })
    await logLocalExperiment({
      root,
      record: {
        schemaVersion: 1,
        type: "campaign_experiment_logged",
        campaignName,
        sessionId: session.session.id,
        hypothesisId: hypothesis.id,
        workerId: worker.id,
        runRef: "local/brief-smoke/live",
        projectPath: "",
        baseCommitSha,
        resultCommitSha: "bbbbbbb",
        resultRef: `refs/onyx/experiments/${campaign.id}/local/brief-smoke/live`,
        status: "succeeded",
        setupCompliance: {
          status: "passed",
          protectedPathsChanged: [],
          outOfScopePathsChanged: [],
          setupPathsChanged: [],
          notes: null,
        },
        name: "live-improvement",
        description: "Improved score",
        primaryMetricName: "score",
        primaryMetricValue: 2.5,
        metrics: { score: 2.5 },
        agentNotes: {},
        checks: null,
        createdAt: "2026-06-20T00:00:00.000Z",
      },
    })
    await upsertLocalSummary({
      root,
      campaignId: campaign.id,
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      authoredByWorkerId: worker.id,
      summaryKind: "hypothesis_summary",
      title: "Controller summary",
      body: "Scoped controller edits are promising.",
    })
    await createLocalKnowledge({
      root,
      campaignId: campaign.id,
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      authoredByWorkerId: worker.id,
      kind: "insight",
      title: "Tune lightly",
      body: "Small scoped edits are outperforming broad rewrites.",
    })
    const state = await readState(root)
    const key = campaignStateKey("", campaignName)
    state.campaigns = state.campaigns ?? {}
    state.campaigns[key] = {
      ...(state.campaigns[key] ?? {}),
      campaignId: campaign.id,
      projectPath: "",
      sessionId: session.session.id,
    }
    state.sessions = state.sessions ?? {}
    state.sessions[session.session.id] = {
      campaignName,
      campaignId: campaign.id,
      status: "running",
    }
    await writeState(root, state)

    const previousCwd = process.cwd()
    const previousSession = process.env.ONYX_SESSION_ID
    const previousHypothesis = process.env.ONYX_HYPOTHESIS_ID
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }
    try {
      process.chdir(root)
      process.env.ONYX_SESSION_ID = session.session.id
      process.env.ONYX_HYPOTHESIS_ID = hypothesis.id
      await commandResearchBrief({
        positional: ["research", "brief"],
        options: {},
      })
      const markdown = logs.join("\n")
      expect(markdown).toContain("# Onyx Research Brief: brief-smoke")
      expect(markdown).toContain("Goal: Improve score.")
      expect(markdown).toContain("Metric: score, maximize")
      expect(markdown).toContain(`Session: ${session.session.id} (running)`)
      expect(markdown).toContain(`Hypothesis: ${hypothesis.name}`)
      expect(markdown).toContain("live-improvement")
      expect(markdown).toContain("Controller summary")
      expect(markdown).toContain("Tune lightly")
      expect(markdown).toContain("brief-worker: running")

      logs.length = 0
      await commandResearchBrief({
        positional: ["research", "brief"],
        options: { json: "true" },
      })
      const json = JSON.parse(logs.join("\n")) as {
        campaign: { name: string }
        currentHypothesis: { id: string } | null
        recentExperiments: Array<{ name: string }>
        summaries: Array<{ title: string }>
        knowledge: Array<{ title: string }>
        workers: Array<{ workerName: string }>
        markdown: string
      }
      expect(json.campaign.name).toBe(campaignName)
      expect(json.currentHypothesis?.id).toBe(hypothesis.id)
      expect(json.recentExperiments[0]?.name).toBe("live-improvement")
      expect(json.summaries[0]?.title).toBe("Controller summary")
      expect(json.knowledge[0]?.title).toBe("Tune lightly")
      expect(json.workers[0]?.workerName).toBe("brief-worker")
      expect(json.markdown).toContain("live-improvement")
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
      if (previousSession === undefined) delete process.env.ONYX_SESSION_ID
      else process.env.ONYX_SESSION_ID = previousSession
      if (previousHypothesis === undefined) delete process.env.ONYX_HYPOTHESIS_ID
      else process.env.ONYX_HYPOTHESIS_ID = previousHypothesis
    }
  })

  test("research brief fails clearly when local campaign is missing", async () => {
    const { root } = await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await expect(
        commandResearchBrief({
          positional: ["research", "brief"],
          options: { campaign: "missing" },
        })
      ).rejects.toThrow("Local campaign missing was not found")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("research run caps fast custom workers and reserves unique hypotheses", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    await addBareOrigin(root)
    const campaignName = "capped-smoke"
    await createSupervisorRunCampaign({ root, baseCommitSha, campaignName })
    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = () => {}

    try {
      process.chdir(root)
      await commandResearchRun({
        positional: ["research", "run"],
        options: {
          campaign: campaignName,
          workers: "5",
          "max-concurrency": "5",
          "max-launches": "5",
          hypotheses: JSON.stringify(supervisorPlans(5)),
          "worker-command": fastWorkerCommand(),
          "max-minutes": "1",
          "worker-timeout": "20",
          "startup-timeout": "0",
          "sync-interval": "60",
          "presence-interval": "60",
          "final-sync-timeout": "1",
          "stop-grace-seconds": "1",
          offline: "true",
          quiet: "true",
        },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const state = await readState(root)
    const sessionId =
      state.campaigns?.[campaignStateKey("", campaignName)]?.sessionId
    if (!sessionId) throw new Error("expected session id")
    const sessionState = await getLocalSessionState(root, sessionId)
    expect(sessionState.session.status).toBe("completed")
    await expect(
      stat(join(await onyxStateDir(root), "session-state"))
    ).rejects.toThrow()
    await expect(stat(join(await onyxStateDir(root), "briefs"))).rejects.toThrow()
    expect(sessionState.session.metadata).toMatchObject({
      agentKind: "custom",
      maxConcurrency: 5,
      maxLaunches: 5,
    })
    expect(sessionState.workers).toHaveLength(5)
    expect(
      new Set(sessionState.workers.map((worker) => worker.hypothesisId)).size
    ).toBe(5)
    for (const worker of sessionState.workers) {
      expect(worker.agentKind).toBe("custom")
      expect(worker.workerName.endsWith("-custom")).toBe(true)
      expect(worker.status).toBe("completed")
      expect(worker.phase).toBe("completed")
    }

    const manifests = await readWorkerLaunchManifests(root, sessionId)
    expect(manifests).toHaveLength(5)
    for (const manifest of manifests) {
      expect(manifest.agentKind).toBe("custom")
      expect(manifest.workerName.endsWith("-custom")).toBe(true)
      expect(manifest.status).toBe("completed")
      expect(manifest.finalization?.finalizationStatus).toBe(
        "measured_and_logged"
      )
    }

    const experiments = (await listLocalExperimentHistory(root)).filter(
      (experiment) => experiment.campaignName === campaignName
    )
    expect(experiments).toHaveLength(5)

    const db = new Database(await researchDbPath(root), { readonly: true })
    try {
      const launchCount = db
        .query(
          "SELECT COUNT(*) AS count FROM worker_launches WHERE session_id = ?"
        )
        .get(sessionId) as { count: number }
      const launchRows = db
        .query(
          "SELECT status, metadata_json AS metadataJson FROM worker_launches WHERE session_id = ?"
        )
        .all(sessionId) as { status: string; metadataJson: string }[]
      const schema = db
        .query("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number }
      const conflicts = db
        .query(
          "SELECT COUNT(*) AS count FROM sync_events WHERE status = 'conflict'"
        )
        .get() as { count: number }
      const workflowRuns = experiments.map((experiment) =>
        db
          .query(
            `
              SELECT session_id AS sessionId, worker_id AS workerId,
                hypothesis_id AS hypothesisId,
                result_commit_sha AS resultCommitSha
              FROM workflow_runs
              WHERE run_ref = ?
            `
          )
          .get(experiment.runRef)
      ) as Array<{
        sessionId: string | null
        workerId: string | null
        hypothesisId: string | null
        resultCommitSha: string | null
      } | null>
      expect(launchCount.count).toBe(5)
      expect(
        launchRows.every(
          (row) =>
            row.status === "completed" &&
            JSON.parse(row.metadataJson).agentKind === "custom"
        )
      ).toBe(true)
      expect(workflowRuns).toHaveLength(5)
      for (const [index, workflow] of workflowRuns.entries()) {
        const experiment = experiments[index]!
        expect(workflow).toMatchObject({
          sessionId,
          workerId: experiment.workerId,
          hypothesisId: experiment.hypothesisId,
          resultCommitSha: experiment.resultCommitSha,
        })
      }
      expect(schema.version).toBe(3)
      expect(conflicts.count).toBe(0)
    } finally {
      db.close()
    }
  })

  test("max-launches one stops a two-slot supervisor after one worker", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    await addBareOrigin(root)
    const campaignName = "one-launch-smoke"
    await createSupervisorRunCampaign({ root, baseCommitSha, campaignName })
    const previousCwd = process.cwd()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }

    try {
      process.chdir(root)
      await commandResearchRun({
        positional: ["research", "run"],
        options: {
          campaign: campaignName,
          workers: "2",
          "max-concurrency": "2",
          "max-launches": "1",
          hypotheses: JSON.stringify(supervisorPlans(2)),
          "worker-command": fastWorkerCommand(),
          "max-minutes": "1",
          "worker-timeout": "20",
          "startup-timeout": "0",
          "sync-interval": "60",
          "presence-interval": "60",
          "final-sync-timeout": "1",
          "stop-grace-seconds": "1",
          offline: "true",
          quiet: "true",
        },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const state = await readState(root)
    const sessionId =
      state.campaigns?.[campaignStateKey("", campaignName)]?.sessionId
    if (!sessionId) throw new Error("expected session id")
    const sessionState = await getLocalSessionState(root, sessionId)
    expect(sessionState.session.status).toBe("completed")
    expect(sessionState.workers).toHaveLength(1)
    expect(sessionState.workers[0]?.status).toBe("completed")
    expect(logs.join("\n")).toContain(
      "Workers: target=2 concurrency=2 maxLaunches=1"
    )
    expect(logs.join("\n")).toContain("launched=1/1")
  })

  test("max-launches caps only the current existing-session run", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    await addBareOrigin(root)
    const campaignName = "existing-session-smoke"
    const campaign = await createSupervisorRunCampaign({
      root,
      baseCommitSha,
      campaignName,
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "existing-session",
      workerTarget: 2,
      hypotheses: supervisorPlans(3),
      maxIterations: 2,
      endTimeMs: Date.now() + 60_000,
    })
    await writeState(root, {
      projectPath: "",
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: campaign.id,
          projectPath: "",
          baseCommitSha,
          metricName: "score",
          metricUnit: null,
          metricDirection: "maximize",
          sessionId: session.session.id,
        },
      },
      sessions: {
        [session.session.id]: {
          campaignName,
          campaignId: campaign.id,
          status: "running",
          endTimeMs: Date.now() + 60_000,
          maxIterations: 2,
        },
      },
    })

    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = () => {}
    try {
      process.chdir(root)
      await commandResearchRun({
        positional: ["research", "run"],
        options: {
          campaign: campaignName,
          session: session.session.id,
          workers: "2",
          "max-concurrency": "2",
          "max-launches": "2",
          "worker-command": fastWorkerCommand(),
          "worker-timeout": "20",
          "startup-timeout": "0",
          "sync-interval": "60",
          "presence-interval": "60",
          "final-sync-timeout": "1",
          "stop-grace-seconds": "1",
          offline: "true",
          quiet: "true",
        },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const sessionState = await getLocalSessionState(root, session.session.id)
    expect(sessionState.session.status).toBe("completed")
    expect(sessionState.workers).toHaveLength(2)
    expect(
      new Set(sessionState.workers.map((worker) => worker.hypothesisId)).size
    ).toBe(2)
    expect(
      sessionState.workers.every((worker) => worker.status === "completed")
    ).toBe(true)
  })

  test("omitting max-launches preserves slot maintenance until stopped", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    await addBareOrigin(root)
    const campaignName = "uncapped-session-smoke"
    const campaign = await createSupervisorRunCampaign({
      root,
      baseCommitSha,
      campaignName,
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "uncapped-session",
      workerTarget: 1,
      hypotheses: supervisorPlans(2),
      maxIterations: 2,
      endTimeMs: Date.now() + 60_000,
    })
    await writeState(root, {
      projectPath: "",
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: campaign.id,
          projectPath: "",
          baseCommitSha,
          metricName: "score",
          metricUnit: null,
          metricDirection: "maximize",
          sessionId: session.session.id,
        },
      },
      sessions: {
        [session.session.id]: {
          campaignName,
          campaignId: campaign.id,
          status: "running",
          endTimeMs: Date.now() + 60_000,
          maxIterations: 2,
        },
      },
    })

    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }
    let runError: unknown = null
    const run = commandResearchRun({
      positional: ["research", "run"],
      options: {
        campaign: campaignName,
        session: session.session.id,
        workers: "1",
        "max-concurrency": "1",
        "worker-command": fastWorkerCommand(),
        "worker-timeout": "20",
        "startup-timeout": "0",
        "sync-interval": "60",
        "presence-interval": "60",
        "final-sync-timeout": "1",
        "stop-grace-seconds": "1",
        offline: "true",
        quiet: "true",
        cwd: root,
      },
    }).catch((error) => {
      runError = error
    })

    try {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const sessionState = await getLocalSessionState(
          root,
          session.session.id
        )
        if (sessionState.workers.length >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const sessionState = await getLocalSessionState(root, session.session.id)
      expect(sessionState.workers.length).toBeGreaterThanOrEqual(2)
    } finally {
      await commandResearchStop({
        positional: ["research", "stop"],
        options: {
          session: session.session.id,
          offline: "true",
          quiet: "true",
          cwd: root,
        },
      }).catch(() => {})
      await run
      console.log = originalLog
    }
    if (runError) throw runError

    const finalSessionState = await getLocalSessionState(root, session.session.id)
    expect(finalSessionState.workers.length).toBeGreaterThanOrEqual(2)
    expect(logs.join("\n")).toContain("Workers: target=1 concurrency=1")
    expect(logs.join("\n")).not.toContain("maxLaunches=")
  })

  test("exercises setup, campaign, worker, sync, status, finish, summaries, and knowledge with a mock worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-auto-smoke-"))
    const remote = await mkdtemp(join(tmpdir(), "onyx-auto-smoke-remote-"))
    const projectId = "44444444-4444-4444-8444-444444444444"
    const campaignName = "auto-smoke"
    let campaignId = ""
    let sessionId = ""
    let baseCommitSha = ""
    let campaignStatus: "active" | "completed" = "active"
    const syncedEvents: Array<{
      type: string
      payload: Record<string, unknown>
    }> = []
    const logs: string[] = []
    const originalLog = console.log
    const originalWarn = console.warn
    const previousCwd = process.cwd()

    const campaignDto = (status: "active" | "completed" = campaignStatus) => ({
      id: campaignId,
      projectId,
      name: campaignName,
      description: "Improve score.",
      baseCommitSha,
      status,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize" as const,
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: `refs/heads/onyx/${campaignName}/best`,
    })

    const syncResponse = (body: unknown) => {
      const events =
        (body as { events?: Array<Record<string, unknown>> }).events ?? []
      syncedEvents.push(
        ...events.map((event) => ({
          type: String(event.type),
          payload: event.payload as Record<string, unknown>,
        }))
      )
      for (const event of events) {
        const campaign = (event.payload as { campaign?: { status?: string } })
          .campaign
        if (
          event.type === "campaign.upserted" &&
          campaign?.status === "completed"
        ) {
          campaignStatus = "completed"
        }
      }
      return {
        body: {
          data: {
            accepted: events.length,
            duplicate: 0,
            conflicts: 0,
            invalid: 0,
            acknowledgements: events.map((event) => ({
              eventId: String(event.eventId),
              sequence: Number(event.sequence),
              status: "acked",
              code: "ok",
              entityType: String(event.entityType),
              entityId:
                typeof event.entityId === "string" ? event.entityId : null,
              message: null,
              details: {},
            })),
            tombstones: [],
            projectionDeltas: {
              campaigns: [],
              sessions: [],
              hypotheses: [],
              workers: [],
              experiments: [],
              summaries: [],
              knowledge: [],
            },
          },
        },
      }
    }

    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }
    console.warn = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }

    try {
      await runProcess("git", ["init"], { cwd: root })
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "README.md"), "test\n", "utf8")
      await writeFile(join(root, "src", "controller.txt"), "base\n", "utf8")
      process.chdir(root)

      await withMockResearchApi(
        (request) => {
          if (
            request.method === "POST" &&
            request.path === "/api/v1/research/sync"
          ) {
            return syncResponse(request.body)
          }
          if (
            campaignId &&
            request.method === "POST" &&
            request.path ===
              `/api/v1/research/campaigns/${campaignId}/reconcile`
          ) {
            return {
              body: {
                data: {
                  campaign: campaignDto(),
                  hypotheses: [],
                  workers: [],
                  experiments: [],
                  experimentsUpdated: 0,
                },
              },
            }
          }
          if (
            campaignId &&
            request.method === "GET" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/overview`
          ) {
            return {
              body: {
                data: {
                  campaign: campaignDto(),
                  workers: [],
                  hypotheses: [],
                  summaries: [],
                  knowledge: [],
                  bestExperiment: null,
                  latestExperiments: [],
                  counts: {
                    experiments: 0,
                    hypothesisCount: 0,
                    activeWorkers: 0,
                  },
                },
              },
            }
          }
          if (
            sessionId &&
            request.method === "POST" &&
            request.path === `/api/v1/research/sessions/${sessionId}/stop`
          ) {
            const body = request.body as { campaignId: string; status?: string }
            return {
              body: {
                data: {
                  id: sessionId,
                  campaignId: body.campaignId,
                  name: "session",
                  status: body.status ?? "stop_requested",
                  workerTarget: 1,
                  metadata: {},
                },
              },
            }
          }
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/projects/${projectId}/deletions`
          ) {
            return { body: { data: { campaigns: [], experiments: [] } } }
          }
          throw new Error(
            `Unexpected API call ${request.method} ${request.path}`
          )
        },
        async () => {
          await commandSetupInit({
            positional: ["setup", "init"],
            options: {
              goal: "Improve score.",
              "metric-name": "score",
              "metric-direction": "maximize",
              "editable-scope": "src",
              "eval-command": "printf 'METRIC score=1.25\\n'",
            },
          })
          await commandSetupValidate({
            positional: ["setup", "validate"],
            options: {},
          })
          await commitAll(root, "setup")
          baseCommitSha = (
            await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
          ).stdout.trim()
          await runProcess("git", ["init", "--bare"], { cwd: remote })
          await runProcess("git", ["remote", "add", "origin", remote], {
            cwd: root,
          })
          await runProcess("git", ["push", "-u", "origin", "HEAD"], {
            cwd: root,
          })

          await commandCampaignCreate({
            positional: ["campaign", "setup"],
            options: {
              name: campaignName,
              description: "Improve score.",
              "require-online": "true",
            },
          })
          const localCampaign = await localCampaignByName({
            root,
            projectPath: "",
            name: campaignName,
          })
          if (!localCampaign) throw new Error("expected local campaign")
          campaignId = localCampaign.id

          const plan = {
            focus: "Scoped text tuning",
            statement: "A small scoped change can improve the score.",
            startingPoints: ["src/controller.txt"],
            avoidList: ["onyx/"],
            successSignals: ["METRIC score improves"],
            giveUpSignals: ["No clean scoped change"],
          }
          await commandResearchStart({
            positional: ["research", "start"],
            options: {
              campaign: campaignName,
              workers: "1",
              agent: "claude",
              hypotheses: JSON.stringify([plan]),
              "max-iterations": "2",
              "max-minutes": "1",
              "require-online": "true",
            },
          })
          const state = await readState(root)
          sessionId =
            state.campaigns?.[campaignStateKey("", campaignName)]?.sessionId ??
            ""
          expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
          const [hypothesis] = await listLocalHypotheses(root, campaignId)
          expect(hypothesis?.plan.focus).toBe("Scoped text tuning")

          const workerCommand = [
            "mkdir -p src",
            "printf 'worker tuned\\n' >> src/controller.txt",
            "git add src/controller.txt",
            "git -c user.name='Onyx Test' -c user.email='onyx@example.com' commit -m 'smoke worker change'",
            'printf \'%s\\n\' \'{"type":"assistant","message":{"content":[{"type":"text","text":"changed controller"}]}}\'',
          ].join(" && ")
          await commandWorkerRun({
            positional: ["worker", "run"],
            options: {
              session: sessionId,
              hypothesis: hypothesis!.id,
              "worker-command": workerCommand,
              "worker-timeout": "10",
              "startup-timeout": "0",
              "sync-interval": "60",
              "final-sync-timeout": "10",
              "stop-grace-seconds": "1",
              quiet: "true",
              project: projectId,
              "require-online": "true",
            },
          })

          const workflow = await commandWorkflowStatus({
            positional: ["workflow", "status"],
            options: { campaign: campaignName, json: "true" },
          })
          expect(workflow?.run.status).toBe("succeeded")

          await commandResearchStatus({
            positional: ["research", "status"],
            options: {
              campaign: campaignName,
              json: "true",
              project: projectId,
            },
          })
          await commandSummaryUpsert({
            positional: ["summary", "upsert"],
            options: {
              campaign: campaignName,
              session: sessionId,
              hypothesis: hypothesis!.id,
              kind: "hypothesis_summary",
              title: "Smoke summary",
              body: "The mock worker produced a measured scoped change.",
              project: projectId,
              "require-online": "true",
            },
          })
          await commandKnowledgeAdd({
            positional: ["knowledge", "add"],
            options: {
              campaign: campaignName,
              session: sessionId,
              hypothesis: hypothesis!.id,
              kind: "insight",
              title: "Smoke insight",
              body: "The mock path can exercise sync without model credentials.",
              confidence: "0.8",
              project: projectId,
              "require-online": "true",
            },
          })
          await commandSync({
            positional: ["sync"],
            options: { project: projectId, "require-online": "true" },
          })
          await commandSummaryList({
            positional: ["summary", "list"],
            options: { campaign: campaignName, project: projectId },
          })
          await commandKnowledgeList({
            positional: ["knowledge", "list"],
            options: { campaign: campaignName, project: projectId },
          })
          await commandStatus({
            positional: ["status"],
            options: { project: projectId, json: "true" },
          })

          const listenOutput: string[] = []
          const originalWrite = process.stdout.write
          process.stdout.write = ((chunk: unknown) => {
            listenOutput.push(String(chunk))
            return true
          }) as typeof process.stdout.write
          try {
            await commandListen()
          } finally {
            process.stdout.write = originalWrite
          }
          expect(listenOutput.join("\n")).toContain(campaignName)

          await commandResearchStop({
            positional: ["research", "stop"],
            options: {
              session: sessionId,
              reason: "smoke stop",
              project: projectId,
            },
          })
          await commandResearchFinish({
            positional: ["research", "finish"],
            options: {
              campaign: campaignName,
              session: sessionId,
              project: projectId,
              "final-sync-timeout": "10",
              "require-online": "true",
            },
          })
        }
      )

      const experiments = await listLocalExperimentHistory(root)
      const summaries = await listLocalSummaries(root, campaignId)
      const knowledge = await listLocalKnowledge(root, campaignId)
      const finishedCampaign = await localCampaignByName({
        root,
        projectPath: "",
        name: campaignName,
      })

      expect(
        experiments.some((item) => item.campaignName === campaignName)
      ).toBe(true)
      expect(summaries.some((item) => item.title === "Smoke summary")).toBe(
        true
      )
      expect(knowledge.some((item) => item.title === "Smoke insight")).toBe(
        true
      )
      expect(finishedCampaign?.status).toBe("completed")
      expect(await pendingResearchSyncCount(root)).toBe(0)
      expect(syncedEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "campaign.upserted",
          "session.started",
          "hypothesis.upserted",
          "worker.registered",
          "worker.heartbeat",
          "experiment.logged",
          "summary.upserted",
          "knowledge.created",
          "session.stopped",
        ])
      )
      expect(
        syncedEvents.some(
          (event) =>
            event.type === "campaign.upserted" &&
            (event.payload.campaign as { status?: string } | undefined)
              ?.status === "completed"
        )
      ).toBe(true)
      expect(logs.join("\n")).toContain("final sync: accepted=")
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
      console.warn = originalWarn
    }
  })
})

describe("summary CLI", () => {
  test("suggests hypothesis_summary for hypothesis summary kind", async () => {
    const { root, campaignName } = await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await expect(
        commandSummaryUpsert({
          positional: ["summary", "upsert"],
          options: {
            campaign: campaignName,
            kind: "hypothesis",
            body: "summary",
            offline: "true",
          },
        })
      ).rejects.toThrow("Did you mean hypothesis_summary?")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("rejects non-UUID summary identity flags locally", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const campaign = {
      id: campaignId,
      projectId: "44444444-4444-4444-8444-444444444444",
      name: campaignName,
      description: "Improve score.",
      baseCommitSha,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: null,
    }
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await withMockResearchApi(
        (request) => {
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/overview`
          ) {
            return {
              body: {
                data: {
                  campaign,
                  workers: [],
                  hypotheses: [],
                  summaries: [],
                  knowledge: [],
                  bestExperiment: null,
                  latestExperiments: [],
                  counts: {
                    experiments: 0,
                    hypothesisCount: 0,
                    activeWorkers: 0,
                  },
                },
              },
            }
          }
          throw new Error(
            `Unexpected API call ${request.method} ${request.path}`
          )
        },
        async () => {
          await expect(
            commandSummaryUpsert({
              positional: ["summary", "upsert"],
              options: {
                campaign: campaignName,
                hypothesis: "hypothesis-1",
                body: "summary",
              },
            })
          ).rejects.toThrow("--hypothesis must be a UUID")
        }
      )
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("lists campaign summaries as text", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const campaign = {
      id: campaignId,
      projectId: "44444444-4444-4444-8444-444444444444",
      name: campaignName,
      description: "Improve score.",
      baseCommitSha,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: null,
    }
    const overview = {
      campaign,
      workers: [],
      hypotheses: [],
      summaries: [
        {
          id: "summary-1",
          campaignId,
          sessionId: "session-1",
          hypothesisId: "hypothesis-1",
          authoredByWorkerId: "worker-1",
          summaryKind: "hypothesis_summary",
          title: "Tuning completed",
          body: "Score improved after a small gain sweep.",
          isCurrent: true,
        },
        {
          id: "summary-2",
          campaignId,
          sessionId: null,
          hypothesisId: null,
          authoredByWorkerId: null,
          summaryKind: "campaign_brief",
          title: "Campaign brief",
          body: "Overall campaign context.",
          isCurrent: false,
        },
      ],
      knowledge: [],
      bestExperiment: null,
      latestExperiments: [],
      counts: { experiments: 0, hypothesisCount: 0, activeWorkers: 0 },
    }
    const previousCwd = process.cwd()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }

    try {
      process.chdir(root)
      await withMockResearchApi(
        (request) => {
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/overview`
          ) {
            return { body: { data: overview } }
          }
          throw new Error(
            `Unexpected API call ${request.method} ${request.path}`
          )
        },
        () =>
          commandSummaryList({
            positional: ["summary", "list"],
            options: { campaign: campaignName, kind: "hypothesis_summary" },
          })
      )
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    expect(logs.join("\n")).toContain(
      "hypothesis_summary current: Tuning completed"
    )
    expect(logs.join("\n")).toContain("worker=worker-1")
    expect(logs.join("\n")).not.toContain("Campaign brief")
  })
})

describe("worker output summaries", () => {
  test("uses final stream-json result before partial assistant text", () => {
    const summary = summarizeWorkerOutput({
      code: 0,
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "partial text" }] },
        }),
        JSON.stringify({ type: "result", result: "clean final answer" }),
      ].join("\n"),
      stderr: "",
      timedOut: false,
      signal: null,
      startupTimedOut: false,
      lastOutputAt: null,
      logPath: "/tmp/worker.log",
      activityLogPath: "/tmp/worker.activity.log",
      cancelled: false,
    })

    expect(summary).toBe("clean final answer")
  })
})

describe("research status", () => {
  test("is read-only unless --reconcile is passed", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const sessionId = "22222222-2222-4222-8222-222222222222"
    const campaign = {
      id: campaignId,
      projectId: "44444444-4444-4444-8444-444444444444",
      name: campaignName,
      description: "Improve score.",
      baseCommitSha,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: null,
    }
    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = () => {}
    try {
      process.chdir(root)
      const stateFile = join(await onyxStateDir(root), "state.json")
      const beforeState = await readFile(stateFile, "utf8")
      const beforeStat = await stat(stateFile)
      await withMockResearchApi(
        (request) => {
          if (request.method === "POST") {
            throw new Error(`Unexpected write ${request.path}`)
          }
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/overview`
          ) {
            return {
              body: {
                data: {
                  campaign,
                  workers: [],
                  hypotheses: [],
                  summaries: [],
                  knowledge: [],
                  bestExperiment: null,
                  latestExperiments: [],
                  counts: {
                    experiments: 0,
                    hypothesisCount: 0,
                    activeWorkers: 0,
                  },
                },
              },
            }
          }
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/sessions/${sessionId}/state`
          ) {
            return {
              body: {
                data: {
                  session: {
                    id: sessionId,
                    campaignId,
                    name: "session",
                    status: "running",
                    workerTarget: 2,
                    metadata: {},
                  },
                  campaign,
                  latestExperiments: [],
                  bestExperiment: null,
                  hypotheses: [],
                  workers: [],
                  summaries: [],
                  knowledge: [],
                  updatedAt: "2026-06-20T00:00:00.000Z",
                },
              },
            }
          }
          throw new Error(
            `Unexpected API call ${request.method} ${request.path}`
          )
        },
        () =>
          commandResearchStatus({
            positional: ["research", "status"],
            options: { campaign: campaignName },
          })
      )
      const afterState = await readFile(stateFile, "utf8")
      const afterStat = await stat(stateFile)
      expect(afterState).toBe(beforeState)
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }
  })

  test("repairs terminal worker manifests before computing open slots", async () => {
    const { root, baseCommitSha, campaignName } = await writeResearchSmokeRepo()
    const campaign = await createLocalCampaign({
      root,
      name: campaignName,
      projectPath: "",
      baseCommitSha,
      setup: await readSetupFile(root, ""),
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "session",
      workerTarget: 1,
      hypotheses: [
        {
          focus: "try one thing",
          statement: "A focused local change can improve score.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
      ],
    })
    const hypothesis = session.hypotheses[0]!
    const worker = await registerLocalWorker({
      root,
      campaignId: campaign.id,
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      workerName: "worker-1",
      agentKind: "codex",
    })
    const manifestDir = join(
      await onyxStateDir(root),
      "worker-logs",
      session.session.id
    )
    await writeWorkerLaunchManifest({
      schemaVersion: 1,
      agentKind: "codex",
      command: "codex",
      args: [],
      onyxShimPath: null,
      addedWritableRoots: [],
      cwd: root,
      promptPath: join(manifestDir, "prompt.md"),
      logPath: join(manifestDir, "worker.log"),
      activityLogPath: join(manifestDir, "worker.activity.log"),
      manifestPath: join(manifestDir, "worker.manifest.json"),
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      hypothesisName: hypothesis.name,
      workerId: worker.id,
      workerName: worker.workerName,
      version: null,
      startedAt: "2026-06-20T00:00:00.000Z",
      lastOutputAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:02.000Z",
      status: "completed",
      exitCode: 0,
      signal: null,
      timedOut: false,
      startupTimedOut: false,
      error: null,
      preflight: null,
      finalization: {
        attempted: true,
        salvaged: false,
        finalizationStatus: "already_logged",
        commitSha: baseCommitSha,
        measurementBaseCommitSha: null,
        unloggedCommitCount: 0,
        workerBranchPushStatus: "pushed",
        rootDriftStatus: "clean",
        error: null,
      },
    })
    await writeState(root, {
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: campaign.id,
          sessionId: session.session.id,
          baseCommitSha,
        },
      },
      sessions: {
        [session.session.id]: {
          campaignName,
          campaignId: campaign.id,
          status: "running",
        },
      },
    })

    const previousCwd = process.cwd()
    const originalLog = console.log
    const lines: string[] = []
    console.log = (...items: unknown[]) => {
      lines.push(items.join(" "))
    }
    try {
      process.chdir(root)
      await commandResearchStatus({
        positional: ["research", "status"],
        options: { campaign: campaignName, json: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const output = JSON.parse(lines.join("\n")) as {
      session: { activeWorkers: number; openSlots: number }
      workers: Array<{ id: string; status: string }>
    }
    expect(output.session.activeWorkers).toBe(0)
    expect(output.session.openSlots).toBe(1)
    expect(output.workers.find((item) => item.id === worker.id)?.status).toBe(
      "completed"
    )
  })

  test("reports open slots immediately after a worker completes", async () => {
    const { root, baseCommitSha, campaignName } = await writeResearchSmokeRepo()
    const campaign = await createLocalCampaign({
      root,
      name: campaignName,
      projectPath: "",
      baseCommitSha,
      setup: await readSetupFile(root, ""),
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "session",
      workerTarget: 1,
      hypotheses: [
        {
          focus: "try one thing",
          statement: "A focused local change can improve score.",
          startingPoints: [],
          avoidList: [],
          successSignals: [],
          giveUpSignals: [],
        },
      ],
    })
    const hypothesis = session.hypotheses[0]!
    const worker = await registerLocalWorker({
      root,
      campaignId: campaign.id,
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      workerName: "worker-1",
      agentKind: "codex",
    })
    await recordLocalWorkerHeartbeat({
      root,
      workerId: worker.id,
      status: "completed",
      sessionId: session.session.id,
      hypothesisId: hypothesis.id,
      event: "completed",
    })
    await writeState(root, {
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: campaign.id,
          sessionId: session.session.id,
          baseCommitSha,
        },
      },
      sessions: {
        [session.session.id]: {
          campaignName,
          campaignId: campaign.id,
          status: "running",
        },
      },
    })

    const previousCwd = process.cwd()
    const originalLog = console.log
    const lines: string[] = []
    console.log = (...items: unknown[]) => {
      lines.push(items.join(" "))
    }
    try {
      process.chdir(root)
      await commandResearchStatus({
        positional: ["research", "status"],
        options: { campaign: campaignName, json: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const output = JSON.parse(lines.join("\n")) as {
      session: { activeWorkers: number; openSlots: number }
      workers: Array<{ id: string; status: string }>
    }
    expect(output.session.activeWorkers).toBe(0)
    expect(output.session.openSlots).toBe(1)
    expect(output.workers.find((item) => item.id === worker.id)?.status).toBe(
      "completed"
    )
  })

  test("emits structured launch suggestions only for unworked hypotheses", async () => {
    const { root, baseCommitSha, campaignName } = await writeResearchSmokeRepo()
    const setup = await readSetupFile(root, "")
    const campaign = await createLocalCampaign({
      root,
      name: campaignName,
      description: "Improve score.",
      projectPath: "",
      baseCommitSha,
      setup,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "session",
      workerTarget: 1,
      hypotheses: [
        {
          focus: "Try a new controller",
          statement: "A focused controller change can improve score.",
          startingPoints: ["src"],
          avoidList: ["onyx/"],
          successSignals: ["METRIC score improves"],
          giveUpSignals: [],
        },
      ],
    })
    const hypothesis = session.hypotheses[0]!
    await writeState(root, {
      projectPath: "",
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: campaign.id,
          projectPath: "",
          baseCommitSha,
          metricName: "score",
          metricUnit: null,
          metricDirection: "maximize",
          sessionId: session.session.id,
        },
      },
      sessions: {
        [session.session.id]: {
          campaignName,
          campaignId: campaign.id,
          status: "running",
        },
      },
    })

    const previousCwd = process.cwd()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }
    try {
      process.chdir(root)
      await commandResearchStatus({
        positional: ["research", "status"],
        options: { campaign: campaignName, json: "true" },
      })
      const firstStatus = JSON.parse(logs.pop() ?? "{}") as {
        launchSuggestions: Array<{ kind: string; hypothesisId?: string }>
      }
      expect(firstStatus.launchSuggestions).toEqual([
        expect.objectContaining({
          kind: "launch_worker",
          hypothesisId: hypothesis.id,
        }),
      ])

      await logLocalExperiment({
        root,
        record: {
          schemaVersion: 1,
          type: "campaign_experiment_logged",
          createdAt: "2026-06-20T00:00:00.000Z",
          runRef: "local/status-suggestion/1",
          campaignName,
          name: "worked",
          description: null,
          projectPath: "",
          baseCommitSha,
          resultCommitSha: baseCommitSha,
          resultRef: `refs/onyx/experiments/${campaign.id}/local/status-suggestion/1`,
          status: "succeeded",
          setupCompliance: {
            status: "passed",
            protectedPathsChanged: [],
            outOfScopePathsChanged: [],
            setupPathsChanged: [],
            notes: null,
          },
          primaryMetricName: "score",
          primaryMetricValue: 1,
          metrics: { score: 1 },
          agentNotes: {},
          checks: null,
          hypothesisId: hypothesis.id,
          sessionId: session.session.id,
        },
      })

      logs.length = 0
      await commandResearchStatus({
        positional: ["research", "status"],
        options: { campaign: campaignName, json: "true" },
      })
      const secondStatus = JSON.parse(logs.join("\n")) as {
        launchSuggestions: Array<{ kind: string }>
      }
      expect(secondStatus.launchSuggestions).toEqual([
        expect.objectContaining({ kind: "add_hypothesis" }),
      ])
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }
  })

  test("completed sessions refresh cached state and do not suggest workers", async () => {
    const { root, baseCommitSha, campaignName } = await writeResearchSmokeRepo()
    const setup = await readSetupFile(root, "")
    const campaign = await createLocalCampaign({
      root,
      name: campaignName,
      description: "Improve score.",
      projectPath: "",
      baseCommitSha,
      setup,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "session",
      workerTarget: 2,
      hypotheses: [
        {
          focus: "Try a new controller",
          statement: "A focused controller change can improve score.",
          startingPoints: ["src"],
          avoidList: ["onyx/"],
          successSignals: ["METRIC score improves"],
          giveUpSignals: [],
        },
      ],
      metadata: { agentKind: "claude", maxIterations: 10 },
    })
    const hypothesis = session.hypotheses[0]!
    await writeState(root, {
      projectPath: "",
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: campaign.id,
          projectPath: "",
          baseCommitSha,
          metricName: "score",
          metricUnit: null,
          metricDirection: "maximize",
          sessionId: session.session.id,
        },
      },
      sessions: {
        [session.session.id]: {
          campaignName,
          campaignId: campaign.id,
          maxIterations: 10,
          endTimeMs: Date.now() + 60_000,
          status: "running",
        },
      },
    })
    await upsertWorkflowRun({
      root,
      run: {
        id: "workflow-finish-blocked",
        campaignId: campaign.id,
        campaignName,
        projectPath: "",
        runRef: "local/smoke/finish-blocked",
        baseCommitSha,
        resultCommitSha: null,
        resultRef: `refs/onyx/experiments/${campaign.id}/local/smoke/finish-blocked`,
        setupHash: setupHash(setup),
        status: "blocked",
        currentStepIndex: 0,
        metrics: {},
        blockReason:
          "Workflow attempts must contain exactly one result commit over the base commit.",
        createdAt: "2026-06-20T00:00:00.000Z",
        startedAt: "2026-06-20T00:00:00.000Z",
        completedAt: null,
        updatedAt: "2026-06-20T00:00:00.000Z",
        sessionId: session.session.id,
        workerId: "77777777-7777-4777-8777-777777777777",
        hypothesisId: hypothesis.id,
      },
    })

    const previousCwd = process.cwd()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }
    try {
      process.chdir(root)
      await commandResearchFinish({
        positional: ["research", "finish"],
        options: {
          campaign: campaignName,
          session: session.session.id,
          offline: "true",
        },
      })

      const localSession = await getLocalSessionState(root, session.session.id)
      expect(localSession.session.status).toBe("completed")

      logs.length = 0
      await commandResearchStatus({
        positional: ["research", "status"],
        options: { campaign: campaignName, json: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const status = JSON.parse(logs.join("\n")) as {
      campaign: { status: string }
      session: { status: string; openSlots: number }
      launchSuggestions: Array<{ kind: string; command: string }>
    }
    expect(status.campaign.status).toBe("completed")
    expect(status.session.status).toBe("completed")
    expect(status.session.openSlots).toBe(2)
    expect(status.launchSuggestions).toEqual([])
    const abandoned = await readWorkflowRun(root, "workflow-finish-blocked")
    expect(abandoned?.status).toBe("abandoned")
    await expect(
      commandWorkflowStatus({
        positional: ["workflow", "status"],
        options: {
          cwd: root,
          campaign: campaignName,
          active: "true",
          json: "true",
        },
      })
    ).rejects.toThrow("No active workflow runs exist")
  })

  test("research finish promotes the earliest experiment that first reached a tied best metric", async () => {
    const { root, baseCommitSha } = await writeResearchSmokeRepo()
    const campaignName = "tie-finish"
    const setup = await readSetupFile(root, "")
    const campaign = await createLocalCampaign({
      root,
      name: campaignName,
      description: "Improve score.",
      projectPath: "",
      baseCommitSha,
      setup,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    })
    const session = await createLocalSession({
      root,
      campaignId: campaign.id,
      name: "session",
      workerTarget: 1,
      hypotheses: [
        {
          focus: "Try a new controller",
          statement: "A focused controller change can improve score.",
          startingPoints: ["src"],
          avoidList: ["onyx/"],
          successSignals: ["METRIC score improves"],
          giveUpSignals: [],
        },
      ],
      metadata: { agentKind: "custom" },
    })
    const hypothesis = session.hypotheses[0]!
    await writeState(root, {
      projectPath: "",
      activeCampaign: campaignName,
      campaigns: {
        [campaignStateKey("", campaignName)]: {
          campaignId: campaign.id,
          projectPath: "",
          baseCommitSha,
          metricName: "score",
          metricUnit: null,
          metricDirection: "maximize",
          sessionId: session.session.id,
        },
      },
      sessions: {
        [session.session.id]: {
          campaignName,
          campaignId: campaign.id,
          maxIterations: 10,
          endTimeMs: Date.now() + 60_000,
          status: "running",
        },
      },
    })

    await writeFile(join(root, "src", "first-best.txt"), "first best\n", "utf8")
    await commitAll(root, "first best")
    const firstBestCommit = (
      await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim()
    await writeFile(join(root, "src", "later-tie.txt"), "later tie\n", "utf8")
    await commitAll(root, "later tied best")
    const laterTieCommit = (
      await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim()

    const logExperiment = async ({
      suffix,
      resultCommitSha,
      metric,
      createdAt,
    }: {
      suffix: string
      resultCommitSha: string
      metric: number
      createdAt: string
    }) =>
      logLocalExperiment({
        root,
        record: {
          schemaVersion: 1,
          type: "campaign_experiment_logged",
          createdAt,
          runRef: `local/tie-finish/${suffix}`,
          campaignName,
          name: suffix,
          description: null,
          projectPath: "",
          baseCommitSha,
          resultCommitSha,
          resultRef: `refs/onyx/experiments/${campaign.id}/local/tie-finish/${suffix}`,
          status: "succeeded",
          setupCompliance: {
            status: "passed",
            protectedPathsChanged: [],
            outOfScopePathsChanged: [],
            setupPathsChanged: [],
            notes: null,
          },
          primaryMetricName: "score",
          primaryMetricValue: metric,
          metrics: { score: metric },
          agentNotes: {},
          checks: null,
          durationMs: null,
          startedAt: createdAt,
          completedAt: createdAt,
          outputSummary: null,
          sessionId: session.session.id,
          hypothesisId: hypothesis.id,
        },
      })

    await logExperiment({
      suffix: "baseline",
      resultCommitSha: baseCommitSha,
      metric: 1,
      createdAt: "2026-06-20T00:00:00.000Z",
    })
    await logExperiment({
      suffix: "first-best",
      resultCommitSha: firstBestCommit,
      metric: 2,
      createdAt: "2026-06-20T00:01:00.000Z",
    })
    await logExperiment({
      suffix: "later-tie",
      resultCommitSha: laterTieCommit,
      metric: 2,
      createdAt: "2026-06-20T00:02:00.000Z",
    })

    const projectedBeforeFinish = await localCampaignByName({
      root,
      projectPath: "",
      name: campaignName,
    })
    expect(projectedBeforeFinish?.bestCommitSha).toBe(firstBestCommit)

    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = () => {}
    try {
      process.chdir(root)
      await commandResearchFinish({
        positional: ["research", "finish"],
        options: {
          campaign: campaignName,
          session: session.session.id,
          offline: "true",
        },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const projectedAfterFinish = await localCampaignByName({
      root,
      projectPath: "",
      name: campaignName,
    })
    const promotedCommit = (
      await runProcess("git", ["rev-parse", `onyx/${campaignName}/best`], {
        cwd: root,
      })
    ).stdout.trim()
    const projectedBestCommit = projectedAfterFinish?.bestCommitSha
    if (!projectedBestCommit) throw new Error("expected projected best commit")
    expect(projectedBestCommit).toBe(firstBestCommit)
    expect(promotedCommit).toBe(projectedBestCommit)
    expect(promotedCommit).not.toBe(laterTieCommit)
  })
})

describe("research hypothesis add", () => {
  test("prints setup-aware hypothesis plan examples", async () => {
    const { root } = await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }

    try {
      process.chdir(root)
      await commandResearchHypotheses({
        positional: ["research", "hypotheses"],
        options: { example: "true" },
      })
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const plans = JSON.parse(logs.join("\n")) as Array<{
      focus: string
      successSignals: string[]
      avoidList: string[]
    }>
    expect(plans[0]?.focus).toContain("increase score")
    expect(plans[0]?.successSignals).toContain(
      "METRIC score moves in the desired direction."
    )
    expect(plans[0]?.avoidList).toContain("onyx/setup.json")
    expect(JSON.stringify(plans)).not.toContain("controller_error")
  })

  test("accepts inline plan fields and prints a ready worker command", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const sessionId = "22222222-2222-4222-8222-222222222222"
    const hypothesisId = "33333333-3333-4333-8333-333333333333"
    const campaign = {
      id: campaignId,
      projectId: "44444444-4444-4444-8444-444444444444",
      name: campaignName,
      description: "Improve score.",
      baseCommitSha,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: null,
    }
    const session = {
      id: sessionId,
      campaignId,
      name: "session",
      status: "running",
      workerTarget: 2,
      metadata: { agentKind: "claude", maxIterations: 10, maxMinutes: 5 },
    }
    const requests: Array<{ method: string; path: string; body: unknown }> = []
    const previousCwd = process.cwd()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }

    try {
      process.chdir(root)
      await withMockResearchApi(
        (request) => {
          requests.push(request)
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/sessions/${sessionId}/state`
          ) {
            return {
              body: {
                data: {
                  session,
                  campaign,
                  latestExperiments: [],
                  bestExperiment: null,
                  hypotheses: [],
                  workers: [],
                  summaries: [],
                  knowledge: [],
                  updatedAt: "2026-06-20T00:00:00.000Z",
                },
              },
            }
          }
          if (
            request.method === "POST" &&
            request.path ===
              `/api/v1/research/campaigns/${campaignId}/hypotheses`
          ) {
            return {
              status: 201,
              body: {
                data: {
                  hypothesis: {
                    id: hypothesisId,
                    campaignId,
                    createdBySessionId: null,
                    name: "hypothesis-3",
                    description: "Try scheduler smoothing",
                    status: "active",
                    baseCommitSha,
                    bestExperimentId: null,
                    bestMetricValue: null,
                    lastWorkedAt: null,
                    plan: (request.body as { plan: unknown }).plan,
                    metadata: {},
                    createdAt: "2026-06-20T00:00:00.000Z",
                    updatedAt: "2026-06-20T00:00:00.000Z",
                  },
                },
              },
            }
          }
          throw new Error(
            `Unexpected API call ${request.method} ${request.path}`
          )
        },
        () =>
          commandResearchHypothesisAdd({
            positional: ["research", "hypothesis", "add"],
            options: {
              session: sessionId,
              focus: "Try scheduler smoothing",
              hypothesis: "Smoothing can improve score.",
            },
            optionLists: {
              "starting-point": ["src/controller.ts", "src/simulator.ts"],
              avoid: ["onyx/setup.json"],
              success: ["METRIC score improves"],
              "give-up": ["Score regresses twice"],
            },
          })
      )
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    const createRequest = requests.find((request) =>
      request.path.endsWith("/hypotheses")
    )
    expect(createRequest).toBeUndefined()
    const hypothesisLine = logs.find((line) =>
      line.startsWith("Research hypothesis: ")
    )
    expect(hypothesisLine).toMatch(/^Research hypothesis: [0-9a-f-]{36}$/)
    const generatedHypothesisId = hypothesisLine?.replace(
      "Research hypothesis: ",
      ""
    )
    expect(logs).toContain(
      "Hypothesis: Try scheduler smoothing: Try scheduler smoothing"
    )
    expect(logs).toContain(
      `onyx worker run --session ${sessionId} --hypothesis ${generatedHypothesisId} --agent claude --max-iterations 10 --max-minutes 5`
    )
    const hypotheses = await listLocalHypotheses(root, campaignId)
    const stored = hypotheses.find(
      (hypothesis) => hypothesis.id === generatedHypothesisId
    )
    expect(stored?.plan.avoidList).toEqual(
      expect.arrayContaining([
        "onyx/setup.json",
        "onyx/validation.json",
        "onyx/onyx.md",
        "onyx/tools/",
      ])
    )
  })

  test("accepts a hypothesis plan file and command-line overrides", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const sessionId = "22222222-2222-4222-8222-222222222222"
    const hypothesisId = "55555555-5555-4555-8555-555555555555"
    const planPath = join(root, "onyx", "replacement-plan.json")
    await writeFile(
      planPath,
      `${JSON.stringify({
        focus: "Replacement search",
        statement: "A new focus can use the opened slot.",
        startingPoints: ["src/new.ts"],
        avoidList: [],
        successSignals: ["METRIC score improves"],
        giveUpSignals: [],
      })}\n`,
      "utf8"
    )
    const campaign = {
      id: campaignId,
      projectId: "44444444-4444-4444-8444-444444444444",
      name: campaignName,
      description: "Improve score.",
      baseCommitSha,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
      bestMetricValue: null,
      bestCommitSha: null,
      experimentCount: 0,
      promotionRefName: null,
    }
    const session = {
      id: sessionId,
      campaignId,
      name: "session",
      status: "running",
      workerTarget: 2,
      metadata: { agentKind: "claude", maxIterations: 10, maxMinutes: 5 },
    }
    let createBody: unknown = null
    const previousCwd = process.cwd()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }

    try {
      process.chdir(root)
      await withMockResearchApi(
        (request) => {
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/sessions/${sessionId}/state`
          ) {
            return {
              body: {
                data: {
                  session,
                  campaign,
                  latestExperiments: [],
                  bestExperiment: null,
                  hypotheses: [],
                  workers: [],
                  summaries: [],
                  knowledge: [],
                  updatedAt: "2026-06-20T00:00:00.000Z",
                },
              },
            }
          }
          if (
            request.method === "POST" &&
            request.path ===
              `/api/v1/research/campaigns/${campaignId}/hypotheses`
          ) {
            createBody = request.body
            return {
              status: 201,
              body: {
                data: {
                  hypothesis: {
                    id: hypothesisId,
                    campaignId,
                    createdBySessionId: null,
                    name: "replacement",
                    description: "Replacement search",
                    status: "active",
                    baseCommitSha,
                    bestExperimentId: null,
                    bestMetricValue: null,
                    lastWorkedAt: null,
                    plan: (request.body as { plan: unknown }).plan,
                    metadata: {},
                    createdAt: "2026-06-20T00:00:00.000Z",
                    updatedAt: "2026-06-20T00:00:00.000Z",
                  },
                },
              },
            }
          }
          throw new Error(
            `Unexpected API call ${request.method} ${request.path}`
          )
        },
        () =>
          commandResearchHypothesisAdd({
            positional: ["research", "hypothesis", "add"],
            options: {
              session: sessionId,
              plan: planPath,
              name: "replacement",
              base: baseCommitSha,
              agent: "codex",
            },
          })
      )
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }

    expect(createBody).toBeNull()
    const hypothesisLine = logs.find((line) =>
      line.startsWith("Research hypothesis: ")
    )
    expect(hypothesisLine).toMatch(/^Research hypothesis: [0-9a-f-]{36}$/)
    const generatedHypothesisId = hypothesisLine?.replace(
      "Research hypothesis: ",
      ""
    )
    expect(logs).toContain("Hypothesis: replacement: Replacement search")
    expect(logs).toContain(
      `onyx worker run --session ${sessionId} --hypothesis ${generatedHypothesisId} --agent codex --max-iterations 10 --max-minutes 5`
    )
  })
})

describe("setup workflow", () => {
  test("normalizes dot project path to repo root", () => {
    expect(normalizeProjectPath(".")).toBe("")
    expect(normalizeProjectPath("./")).toBe("")
    expect(normalizeProjectPath("packages/agent")).toBe("packages/agent")
    expect(() => normalizeProjectPath("packages/./agent")).toThrow(
      "without '.' or '..'"
    )
  })

  test("validates the new workflow setup contract", () => {
    const setup = normalizeSetupFile({
      schemaVersion: 1,
      goal: "Improve the target metric.",
      projectPath: "",
      scope: {
        editable: ["src"],
        protected: ["onyx/setup.json", "onyx/validation.json"],
      },
      metric: { name: "score", unit: null, direction: "maximize" },
      resources: {
        rig: { slots: 1, description: "test rig" },
      },
      tools: {
        "evaluation.run": {
          command: "printf 'METRIC score=1\\n'",
          args: [],
          shell: false,
          cwd: "project",
          env: {},
          resources: ["rig"],
          timeoutSeconds: 600,
          leaseTimeoutSeconds: 120,
          outputLimitBytes: 4000,
        },
      },
      workflow: [
        { id: "edit", agent: "Make one scoped code change." },
        { id: "evaluate", run: "evaluation.run", metric: true },
      ],
    })

    expect(setup.workflow[0]?.agent).toBeTruthy()
    expect(setup.workflow[1]?.metric).toBe(true)
    expect(setup.tools["evaluation.run"]?.resources).toContain("rig")
    expect(() =>
      normalizeSetupFile({
        ...setup,
        workflow: [{ id: "evaluate", run: "evaluation.run", metric: true }],
      })
    ).toThrow("leading agent")
  })

  test("setup init writes workflow files and removed module commands fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-setup-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })
      const evalSh = await readFile(
        join(root, "onyx", "tools", "evaluation", "run.sh"),
        "utf8"
      )
      expect(evalSh).toContain("TODO: replace onyx/tools/evaluation/run.sh")
      expect(evalSh).toContain("METRIC score=<number>")
      const setup = await readSetupFile(root, "")
      expect(setup.tools["evaluation.run"]).toBeTruthy()
      expect(setup.workflow.map((step) => step.id)).toEqual([
        "edit",
        "evaluate",
      ])
      const instructions = await readFile(join(root, "onyx", "onyx.md"), "utf8")
      expect(instructions).toContain("# Onyx Research Spec")
      expect(instructions).toContain("## Goal")
      expect(instructions).toContain("Improve score")
      expect(instructions).toContain("## Primary Metric")
      expect(instructions).toContain("METRIC score=<number>")
      expect(instructions).toContain("## Workflow And Tools")
      expect(instructions).toContain("The Onyx CLI enforces the workflow contract")
      expect(instructions).toContain("## Project Guidance")
      expect(instructions).toContain("## Setup Checklist")
      expect(instructions).not.toContain("onyx exp run")
      expect(USAGE).not.toContain("onyx setup require")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("setup init writes explicit editable scope and eval command without inference", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-setup-explicit-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: {
          goal: "Improve score",
          "metric-name": "score",
          "editable-scope": "src,tests/fixtures",
          "eval-command": "printf 'METRIC score=7\\n'",
        },
      })
      const setup = await readSetupFile(root, "")
      expect(setup.scope.editable).toEqual(["src", "tests/fixtures"])
      const evalSh = await readFile(
        join(root, "onyx", "tools", "evaluation", "run.sh"),
        "utf8"
      )
      expect(evalSh).toContain("printf 'METRIC score=7\\n'")
      expect(evalSh).not.toContain("TODO: replace")
      const instructions = await readFile(join(root, "onyx", "onyx.md"), "utf8")
      expect(instructions).toContain("- src")
      expect(instructions).toContain("- tests/fixtures")
      expect(instructions).toContain("printf 'METRIC score=7\\n'")
      expect(instructions).toContain("METRIC score=<number>")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("setup init keeps placeholder eval script for self-referential eval command", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-setup-self-eval-"))
    const previousCwd = process.cwd()
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (message?: unknown) => {
      warnings.push(String(message ?? ""))
    }
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: {
          goal: "Improve score",
          "metric-name": "score",
          "eval-command": "bash onyx/tools/evaluation/run.sh",
        },
      })
      const evalSh = await readFile(
        join(root, "onyx", "tools", "evaluation", "run.sh"),
        "utf8"
      )
      expect(evalSh).toContain("TODO: replace onyx/tools/evaluation/run.sh")
      expect(evalSh).toContain("METRIC score=<number>")
      expect(evalSh).not.toContain("\nbash onyx/tools/evaluation/run.sh\n")
      expect(warnings.join("\n")).toContain(
        "--eval-command points at onyx/tools/evaluation/run.sh"
      )
    } finally {
      process.chdir(previousCwd)
      console.warn = originalWarn
    }
  })

  test("setup init writes failed metric readiness without executing eval", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-validate-init-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })

      const validation = await readValidationFile(root, "")
      const readiness = validation?.checks.find(
        (item) => item.id === "metric_tool_readiness"
      )
      expect(validation?.status).toBe("failed")
      expect(readiness?.status).toBe("failed")
      expect(readiness?.evidence.toolId).toBe("evaluation.run")
      expect(readiness?.message).toContain("Run `onyx setup validate`")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("setup validate fails when eval exits nonzero", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-validate-exit-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })
      await writeFile(
        join(root, "onyx", "tools", "evaluation", "run.sh"),
        ["#!/usr/bin/env bash", "echo nope", "exit 42", ""].join("\n"),
        "utf8"
      )
      await commandSetupValidate({
        positional: ["setup", "validate"],
        options: {},
      })

      const validation = await readValidationFile(root, "")
      const readiness = validation?.checks.find(
        (item) => item.id === "metric_tool_readiness"
      )
      expect(validation?.status).toBe("failed")
      expect(readiness?.status).toBe("failed")
      expect(readiness?.message).toContain("exited with code 42")
      expect(readiness?.evidence.exitCode).toBe(42)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("setup validate fails when eval emits no primary metric", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-validate-no-metric-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })
      await writeFile(
        join(root, "onyx", "tools", "evaluation", "run.sh"),
        ["#!/usr/bin/env bash", "echo no metric here", ""].join("\n"),
        "utf8"
      )
      await commandSetupValidate({
        positional: ["setup", "validate"],
        options: {},
      })

      const validation = await readValidationFile(root, "")
      const readiness = validation?.checks.find(
        (item) => item.id === "metric_tool_readiness"
      )
      expect(validation?.status).toBe("failed")
      expect(readiness?.status).toBe("failed")
      expect(readiness?.message).toContain("found none")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("setup validate fails when eval emits duplicate primary metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-validate-duplicates-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })
      await writeFile(
        join(root, "onyx", "tools", "evaluation", "run.sh"),
        [
          "#!/usr/bin/env bash",
          "printf 'METRIC score=1\\nMETRIC score=2\\n'",
          "",
        ].join("\n"),
        "utf8"
      )
      await commandSetupValidate({
        positional: ["setup", "validate"],
        options: {},
      })

      const validation = await readValidationFile(root, "")
      const readiness = validation?.checks.find(
        (item) => item.id === "metric_tool_readiness"
      )
      expect(validation?.status).toBe("failed")
      expect(readiness?.status).toBe("failed")
      expect(readiness?.message).toContain("Duplicate METRIC score")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("setup validate passes with one primary metric and secondary metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-validate-ready-"))
    const previousCwd = process.cwd()
    await runProcess("git", ["init"], { cwd: root })
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })
      await writeFile(
        join(root, "onyx", "tools", "evaluation", "run.sh"),
        [
          "#!/usr/bin/env bash",
          "printf 'METRIC score=2\\nMETRIC control_effort=0.4\\n'",
          "",
        ].join("\n"),
        "utf8"
      )
      await commandSetupValidate({
        positional: ["setup", "validate"],
        options: {},
      })

      const validation = await readValidationFile(root, "")
      const readiness = validation?.checks.find(
        (item) => item.id === "metric_tool_readiness"
      )
      expect(readiness?.status).toBe("passed")
      expect(readiness?.evidence.primaryMetric).toEqual({
        name: "score",
        value: 2,
      })
      expect(readiness?.evidence.secondaryMetricNames).toEqual([
        "control_effort",
      ])
      expect(readiness?.evidence.outputSummary).toContain("METRIC score=2")
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("setup git readiness blocks dirty or missing setup surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-setup-git-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeFile(join(root, "README.md"), "test\n", "utf8")
    await commitAll(root, "init")
    const baseWithoutSetup = (
      await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim()

    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      await commandSetupInit({
        positional: ["setup", "init"],
        options: { goal: "Improve score", "metric-name": "score" },
      })
      await commandSetupValidate({
        positional: ["setup", "validate"],
        options: {},
      })

      await expect(
        assertSetupCommitted({ root, projectPath: "" })
      ).rejects.toThrow("uncommitted changes")

      await commitAll(root, "add setup")
      const baseWithSetup = (
        await runProcess("git", ["rev-parse", "HEAD"], { cwd: root })
      ).stdout.trim()

      await expect(
        assertSetupCommitted({ root, projectPath: "" })
      ).resolves.toBeUndefined()
      await writeFile(join(root, "onyx", "hypotheses.json"), "[]\n")
      await expect(
        assertSetupCommitted({ root, projectPath: "" })
      ).resolves.toBeUndefined()
      await mkdir(join(root, "onyx", "tools"), { recursive: true })
      await writeFile(join(root, "onyx", "tools", "helper.sh"), "echo helper\n")
      await expect(
        assertSetupCommitted({ root, projectPath: "" })
      ).rejects.toThrow("uncommitted changes")
      await commitAll(root, "add scratch and tool")
      await expect(
        assertSetupCommitted({
          root,
          projectPath: "",
          baseCommitSha: baseWithoutSetup,
        })
      ).rejects.toThrow("does not contain required Onyx setup")

      await writeFile(join(root, "onyx", "onyx.md"), "updated guidance\n")
      await commitAll(root, "update setup")
      await expect(
        assertSetupCommitted({
          root,
          projectPath: "",
          baseCommitSha: baseWithSetup,
          requireBaseMatchesHead: true,
        })
      ).rejects.toThrow("differs from campaign base")
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe("setup tools", () => {
  test("runs setup tools from the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-tools-"))
    await runProcess("git", ["init"], { cwd: root })
    await mkdir(join(root, "onyx"), { recursive: true })
    await writeSetupFile(
      root,
      "",
      normalizeSetupFile({
        schemaVersion: 1,
        goal: "Improve score.",
        projectPath: "",
        scope: {
          editable: [],
          protected: ["onyx/setup.json", "onyx/validation.json"],
        },
        metric: { name: "score", unit: null, direction: "maximize" },
        resources: {},
        tools: {
          "evaluation.run": {
            command: "printf 'METRIC score=2\\n'",
            args: [],
            shell: true,
            cwd: "project",
            env: {},
            resources: [],
            timeoutSeconds: 5,
            leaseTimeoutSeconds: 5,
            outputLimitBytes: 4000,
          },
        },
        workflow: [
          { id: "edit", agent: "Make one scoped code change." },
          { id: "evaluate", run: "evaluation.run", metric: true },
        ],
      })
    )

    const result = await runToolCommand({
      root,
      projectPath: "",
      name: "evaluation.run",
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain("METRIC score=2")
  })
})
