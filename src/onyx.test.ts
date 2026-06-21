import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { LocalResearchHistoryRecord } from "./protocol"
import {
  appendOutbox,
  assertSetupCommitted,
  campaignStateKey,
  clientRunRef,
  commandExpLog,
  commandExpRun,
  commandExpList,
  commandResearchStart,
  commandResearchHypothesisAdd,
  commandResearchHypotheses,
  commandResearchStatus,
  commandSummaryList,
  commandSummaryUpsert,
  commandSetupInit,
  commandSetupModules,
  commandSetupRequire,
  commandSetupValidate,
  lastRunPath,
  localResearchRecordSchema,
  mergeHistory,
  main,
  normalizeProjectPath,
  normalizeSetupFile,
  normalizeValidationFile,
  onyxStateDir,
  parseArgs,
  parseMetricLines,
  readOutbox,
  readState,
  readSetupFile,
  readLastRun,
  readLastRuns,
  readValidationFile,
  renderExperimentTable,
  runToolCommand,
  requiredSetupModules,
  setupModuleRequirement,
  summarizeWorkerOutput,
  updateState,
  USAGE,
  writeLastRun,
  writeSetupFile,
  writeState,
  writeValidationFile,
} from "./onyx"
import { listLocalExperimentHistory } from "./lib/research-db"
import { runProcess } from "./lib/process"

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
  await mkdir(join(root, "onyx"), { recursive: true })
  await writeFile(
    join(root, "onyx", "onyx.md"),
    "Use the configured eval command and keep changes small.\n",
    "utf8"
  )
  await writeFile(
    join(root, "onyx", "eval.sh"),
    "#!/usr/bin/env sh\nprintf 'METRIC score=1.25\\n'\n",
    "utf8"
  )
  await writeSetupFile(
    root,
    "",
    normalizeSetupFile({
      schemaVersion: 1,
      goal: "Improve score.",
      metric: { name: "score", unit: null, direction: "maximize" },
      projectPath: "",
      editableScope: ["src"],
      protectedPaths: [
        "onyx/setup.json",
        "onyx/validation.json",
        "onyx/onyx.md",
        "onyx/eval.sh",
        "onyx/checks.sh",
        "onyx/tools/*",
      ],
      commands: {
        evaluate: {
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
      resources: {},
      constraints: ["Stay inside editable scope."],
      modules: {},
    })
  )
  const now = new Date().toISOString()
  await writeValidationFile(
    root,
    "",
    normalizeValidationFile({
      schemaVersion: 1,
      status: "passed",
      generatedAt: now,
      summary: null,
      modules: ["setup_spec", "project_scope", "agent", "evaluation"].map(
        (moduleId) => ({
          moduleId,
          status: "passed",
          required: true,
          summary: null,
          outputSummary: null,
          durationMs: 1,
          validatedAt: now,
          evidence: {},
        })
      ),
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
    expect(USAGE).toContain("onyx setup require")
    expect(USAGE).toContain("onyx research start --campaign")
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

  test("exp list includes pending local outbox experiments", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-exp-list-outbox-"))
    await runProcess("git", ["init"], { cwd: root })
    await writeFile(join(root, "README.md"), "test\n", "utf8")
    await commitAll(root, "init")
    await appendOutbox(root, {
      schemaVersion: 1,
      type: "campaign_experiment_logged",
      createdAt: "2026-06-17T12:00:00.000Z",
      runRef: "local/fast-eval/outbox-only",
      campaignName: "fast-eval",
      name: "outbox-only",
      baseCommitSha: "abcdef1",
      resultCommitSha: "1234567",
      resultRef: "refs/onyx/experiments/campaign/local/fast-eval/outbox-only",
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
    expect(rows[0]?.runRef).toBe("local/fast-eval/outbox-only")
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

describe("exp run", () => {
  test("--no-log leaves no last-run.json when none existed", async () => {
    const { root } = await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    const previousExitCode = process.exitCode
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...items: unknown[]) => {
      logs.push(items.join(" "))
    }
    try {
      process.chdir(root)
      process.exitCode = undefined
      await commandExpRun({
        positional: ["exp", "run"],
        options: { "no-log": "true", timeout: "5" },
      })
      await expect(readFile(await lastRunPath(root), "utf8")).rejects.toThrow()
      expect(await readLastRun(root)).toBeNull()
    } finally {
      process.chdir(previousCwd)
      process.exitCode = previousExitCode
      console.log = originalLog
    }

    expect(JSON.parse(logs.join("\n")).metrics.score).toBe(1.25)
  })

  test("--no-log does not alter an existing last-run.json", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const previousCwd = process.cwd()
    const previousExitCode = process.exitCode
    const originalLog = console.log
    console.log = () => {}
    const existing = {
      schemaVersion: 1 as const,
      createdAt: "2026-06-20T00:00:00.000Z",
      runRef: "local/smoke/existing",
      campaignName,
      projectPath: "",
      baseCommitSha,
      resultCommitSha: baseCommitSha,
      resultRef: `refs/onyx/experiments/${campaignId}/local/smoke/existing`,
      status: "succeeded" as const,
      setupCompliance: {
        status: "passed" as const,
        protectedPathsChanged: [],
        outOfScopePathsChanged: [],
        setupPathsChanged: [],
        notes: null,
      },
      primaryMetricName: "score",
      primaryMetricValue: 0.5,
      metrics: { score: 0.5 },
      agentNotes: {},
      checks: null,
      durationMs: 1,
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: "2026-06-20T00:00:01.000Z",
      outputSummary: "existing",
    }
    await writeLastRun(root, existing)
    const before = await readFile(await lastRunPath(root), "utf8")

    try {
      process.chdir(root)
      process.exitCode = undefined
      await commandExpRun({
        positional: ["exp", "run"],
        options: { "no-log": "true", timeout: "5" },
      })
    } finally {
      process.chdir(previousCwd)
      process.exitCode = previousExitCode
      console.log = originalLog
    }

    expect(await readFile(await lastRunPath(root), "utf8")).toBe(before)
    expect((await readLastRun(root))?.runRef).toBe("local/smoke/existing")
  })
})

describe("exp log", () => {
  test("uses explicit scoped run refs without consuming another worker run", async () => {
    const { root, baseCommitSha, campaignId, campaignName } =
      await writeResearchSmokeRepo()
    const sessionId = "22222222-2222-4222-8222-222222222222"
    const workerOneId = "77777777-7777-4777-8777-777777777771"
    const workerTwoId = "77777777-7777-4777-8777-777777777772"
    const hypothesisOneId = "88888888-8888-4888-8888-888888888881"
    const hypothesisTwoId = "88888888-8888-4888-8888-888888888882"
    const makeRun = (workerId: string, hypothesisId: string, value: number) => ({
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
    await writeLastRun(root, workerOne)
    await writeLastRun(root, workerTwo)

    const previousCwd = process.cwd()
    const originalLog = console.log
    console.log = () => {}
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
          name: "worker-two-result",
          description: "logged the second worker",
        },
      })
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
    const remainingRuns = await readLastRuns(root)
    expect(remainingRuns.map((run) => run.runRef)).toEqual([workerOne.runRef])
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
            request.path ===
              `/api/v1/research/campaigns/${campaignId}/sessions`
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
            request.path === `/api/v1/research/campaigns/${campaignId}/brief`
          ) {
            return {
              body: {
                data: {
                  campaign,
                  bestExperiment: null,
                  recentExperiments: [],
                  hypotheses: [],
                  workers: [],
                  summaries: [],
                  knowledge: [],
                  recommendedContext: [],
                  markdown: "brief",
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

describe("summary CLI", () => {
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
    } finally {
      process.chdir(previousCwd)
      console.log = originalLog
    }
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
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/brief`
          ) {
            return {
              body: {
                data: {
                  campaign,
                  bestExperiment: null,
                  recentExperiments: [],
                  hypotheses: [],
                  workers: [],
                  summaries: [],
                  knowledge: [],
                  recommendedContext: [],
                  markdown: "brief",
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
    expect(logs).toContain("Hypothesis: Try scheduler smoothing: Try scheduler smoothing")
    expect(logs).toContain(
      `onyx worker run --session ${sessionId} --hypothesis ${generatedHypothesisId} --agent claude --max-iterations 10 --max-minutes 5`
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
          if (
            request.method === "GET" &&
            request.path === `/api/v1/research/campaigns/${campaignId}/brief`
          ) {
            return {
              body: {
                data: {
                  campaign,
                  bestExperiment: null,
                  recentExperiments: [],
                  hypotheses: [],
                  workers: [],
                  summaries: [],
                  knowledge: [],
                  recommendedContext: [],
                  markdown: "brief",
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

describe("setup modules", () => {
  test("normalizes dot project path to repo root", () => {
    expect(normalizeProjectPath(".")).toBe("")
    expect(normalizeProjectPath("./")).toBe("")
    expect(normalizeProjectPath("packages/agent")).toBe("packages/agent")
    expect(() => normalizeProjectPath("packages/./agent")).toThrow(
      "without '.' or '..'"
    )
  })

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
      const evalSh = await readFile(join(root, "onyx", "eval.sh"), "utf8")
      expect(evalSh).toContain("TODO: replace onyx/eval.sh")
      expect(evalSh).toContain("METRIC score=<number>")
      expect(evalSh).toContain("exit 1")
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
