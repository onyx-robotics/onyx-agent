import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"

import type { Args } from "../lib/args"
import {
  FUNDAMENTAL_SETUP_MODULE_IDS,
  SETUP_MODULE_IDS,
  isFundamentalSetupModule,
  parseSetupModuleId,
  readSetupFile,
  readValidationFile,
  requiredSetupModules,
  setupModuleRequirement,
  setupPath,
  validationPath,
  writeSetupFile,
  writeValidationFile,
  type ResearchSetupFile,
  type ResearchSetupModuleId,
  type ResearchSetupValidationFile,
  type ResearchSetupValidationModuleResult,
} from "../lib/contract"
import { currentCommit, repoRoot } from "../lib/git"
import { parseMetricLines } from "../lib/metrics"
import { onyxPath, resolveProjectPath, scopedRoot } from "../lib/project"
import { pathExists, runProcess } from "../lib/process"
import { hasToolCommand, runToolCommand } from "../lib/tools"

const PROTECTED_SETUP_PATHS = [
  "onyx/setup.json",
  "onyx/validation.json",
  "onyx/onyx.md",
  "onyx/eval.sh",
  "onyx/checks.sh",
  "onyx/tools/*",
]

function splitList(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseModuleList(value?: string): ResearchSetupModuleId[] | null {
  const items = splitList(value)
  if (items.length === 0) return null
  return [...new Set(items.map(parseSetupModuleId))]
}

function defaultSetupFile(projectPath: string, args: Args): ResearchSetupFile {
  const metricDirection = args.options["metric-direction"] ?? "maximize"
  if (metricDirection !== "maximize" && metricDirection !== "minimize") {
    throw new Error("--metric-direction must be maximize or minimize")
  }

  return {
    schemaVersion: 1,
    goal:
      args.options.goal ??
      "Improve the target metric without changing protected setup files.",
    metric: {
      name: args.options["metric-name"] ?? "score",
      unit: args.options["metric-unit"] ?? null,
      direction: metricDirection,
    },
    projectPath,
    editableScope: splitList(args.options["editable-scope"]),
    protectedPaths: PROTECTED_SETUP_PATHS,
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
    resources: {},
    constraints: [],
    riskModel: { risks: [], antiGamingChecks: [] },
    measurement: {
      metricLine: "METRIC",
      trials: 1,
      aggregation: "single",
      notes: null,
    },
    stopPolicy: { maxIterations: null, maxMinutes: null, patience: null },
    modules: Object.fromEntries(
      FUNDAMENTAL_SETUP_MODULE_IDS.map((id) => [
        id,
        { required: true, reason: "Required for Onyx auto research." },
      ])
    ),
  }
}

async function writeIfMissing(path: string, content: string, mode?: number) {
  if (await pathExists(path)) return false
  await writeFile(path, content, "utf8")
  if (mode !== undefined) await chmod(path, mode)
  return true
}

export async function commandSetupInit(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const dir = onyxPath(root, projectPath)
  await mkdir(onyxPath(root, projectPath, "tools"), { recursive: true })

  const setupFile = defaultSetupFile(projectPath, args)
  const wroteSetup = await writeIfMissing(
    setupPath(root, projectPath),
    `${JSON.stringify(setupFile, null, 2)}\n`
  )
  const wroteInstructions = await writeIfMissing(
    onyxPath(root, projectPath, "onyx.md"),
    [
      "# Onyx Worker Instructions",
      "",
      "Read onyx/setup.json and onyx/validation.json before starting work.",
      "Do not edit protected setup files during research.",
      "Run onyx exp run before logging a measured result.",
      "",
    ].join("\n")
  )
  const wroteEval = await writeIfMissing(
    onyxPath(root, projectPath, "eval.sh"),
    ["#!/usr/bin/env bash", "set -euo pipefail", "echo \"METRIC score=0\"", ""].join("\n"),
    0o755
  )

  console.log(`setup: ${dir}`)
  console.log(wroteSetup ? "created onyx/setup.json" : "kept onyx/setup.json")
  console.log(
    wroteInstructions ? "created onyx/onyx.md" : "kept onyx/onyx.md"
  )
  console.log(wroteEval ? "created onyx/eval.sh" : "kept onyx/eval.sh")
}

function result({
  moduleId,
  status,
  required,
  summary,
  outputSummary = null,
  durationMs = null,
  evidence = {},
}: {
  moduleId: ResearchSetupModuleId
  status: ResearchSetupValidationModuleResult["status"]
  required: boolean
  summary: string | null
  outputSummary?: string | null
  durationMs?: number | null
  evidence?: Record<string, unknown>
}) {
  return {
    moduleId,
    status,
    required,
    summary,
    outputSummary,
    durationMs,
    validatedAt: new Date().toISOString(),
    evidence,
  }
}

async function validateModule({
  root,
  projectPath,
  setup,
  setupReadError,
  moduleId,
  required,
  evalCache,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile | null
  setupReadError: unknown
  moduleId: ResearchSetupModuleId
  required: boolean
  evalCache: { value?: Awaited<ReturnType<typeof runToolCommand>> }
}): Promise<ResearchSetupValidationModuleResult> {
  const startedAt = Date.now()
  const done = (
    status: ResearchSetupValidationModuleResult["status"],
    summary: string,
    extras: Partial<ResearchSetupValidationModuleResult> = {}
  ) =>
    result({
      moduleId,
      status,
      required,
      summary,
      durationMs: Date.now() - startedAt,
      ...extras,
    })

  if (moduleId === "setup_spec") {
    if (!setup) {
      return done(
        "failed",
        setupReadError instanceof Error
          ? setupReadError.message
          : "onyx/setup.json is missing or invalid."
      )
    }
    return done("passed", "onyx/setup.json exists and matches the setup schema.")
  }

  if (!setup) {
    return done(
      required ? "failed" : "skipped",
      "Skipped because onyx/setup.json could not be read."
    )
  }

  if (moduleId === "project_scope") {
    if (setup.projectPath !== projectPath) {
      return done(
        "failed",
        `setup projectPath "${setup.projectPath}" does not match active project path "${projectPath}".`
      )
    }
    return done("passed", "Project path, editable scope, and protected paths are schema-valid.")
  }

  if (moduleId === "metric") {
    return done(
      "passed",
      `Metric ${setup.metric.name} is defined with ${setup.metric.direction} direction.`
    )
  }

  if (moduleId === "evaluation_definition") {
    return done(
      "passed",
      `Evaluation command is declared: ${setup.commands.evaluate.command}.`
    )
  }

  if (moduleId === "agent_handoff") {
    const path = onyxPath(root, projectPath, "onyx.md")
    if (!(await pathExists(path))) {
      return done("failed", "onyx/onyx.md is missing.")
    }
    const text = await readFile(path, "utf8")
    return text.trim().length >= 20
      ? done("passed", "onyx/onyx.md exists and contains worker instructions.")
      : done("failed", "onyx/onyx.md is too sparse to guide workers.")
  }

  if (moduleId === "resources") {
    const count = Object.keys(setup.resources).length
    if (count === 0) {
      return done(required ? "failed" : "skipped", "No resources are declared.")
    }
    return done("passed", `${count} resource declaration(s) are schema-valid.`)
  }

  if (moduleId === "reset") {
    if (!setup.commands.reset) {
      return done(required ? "failed" : "skipped", "No reset command is declared.")
    }
    const run = await runToolCommand({ root, projectPath, name: "reset" })
    return done(run.code === 0 && !run.timedOut ? "passed" : "failed", "Reset command executed.", {
      outputSummary: run.outputSummary,
    })
  }

  if (moduleId === "evaluation_run" || moduleId === "metric_parsing") {
    evalCache.value ??= await runToolCommand({
      root,
      projectPath,
      name: "evaluate",
    })
    const run = evalCache.value
    if (moduleId === "evaluation_run") {
      return done(
        run.code === 0 && !run.timedOut ? "passed" : "failed",
        "Evaluation command executed.",
        { outputSummary: run.outputSummary }
      )
    }
    const metrics = parseMetricLines(run.stdout, setup.metric.name)
    const hasMetric = Object.hasOwn(metrics, setup.metric.name)
    return done(
      hasMetric ? "passed" : "failed",
      hasMetric
        ? `Evaluation output contains METRIC ${setup.metric.name}=<number>.`
        : `Evaluation output did not contain METRIC ${setup.metric.name}=<number>.`,
      { outputSummary: run.outputSummary, evidence: { metrics } }
    )
  }

  if (moduleId === "checks") {
    const hasCheck =
      (await hasToolCommand({ root, projectPath, name: "check" })) ||
      (await pathExists(onyxPath(root, projectPath, "checks.sh")))
    if (!hasCheck) {
      return done(required ? "failed" : "skipped", "No checks command is declared.")
    }
    const run = await runToolCommand({ root, projectPath, name: "check" })
    return done(run.code === 0 && !run.timedOut ? "passed" : "failed", "Checks command executed.", {
      outputSummary: run.outputSummary,
    })
  }

  if (moduleId === "git_remote") {
    const remote = await runProcess("git", ["remote", "get-url", "origin"], {
      cwd: scopedRoot(root, projectPath),
      timeoutMs: 10_000,
    })
    const head = await currentCommit(root).catch(() => null)
    if (remote.code !== 0 || !head) {
      return done(required ? "failed" : "warning", "Could not resolve origin remote and current commit.", {
        outputSummary: [remote.stdout.trim(), remote.stderr.trim()].filter(Boolean).join("\n") || null,
      })
    }
    return done("passed", "Origin remote and current commit are available.", {
      evidence: { remote: remote.stdout.trim(), head },
    })
  }

  if (moduleId === "repeatability") {
    const trials = setup.measurement.trials
    if (trials < 2) {
      return done(required ? "failed" : "skipped", "Repeatability requires measurement.trials >= 2.")
    }
    const values: number[] = []
    let outputSummary: string | null = null
    for (let index = 0; index < trials; index += 1) {
      const run = await runToolCommand({ root, projectPath, name: "evaluate" })
      outputSummary = run.outputSummary
      const metrics = parseMetricLines(run.stdout, setup.metric.name)
      const value = metrics[setup.metric.name]
      if (typeof value !== "number") {
        return done("failed", `Trial ${index + 1} did not emit ${setup.metric.name}.`, {
          outputSummary,
        })
      }
      values.push(value)
    }
    return done("passed", `${trials} evaluation trials emitted ${setup.metric.name}.`, {
      evidence: { values },
      outputSummary,
    })
  }

  return done(
    required ? "failed" : "skipped",
    `${moduleId} requires a project-specific validator and was not checked.`
  )
}

function validationStatus(
  modules: ResearchSetupValidationModuleResult[]
): ResearchSetupValidationFile["status"] {
  if (
    modules.some(
      (item) =>
        item.required &&
        (item.status === "failed" ||
          item.status === "skipped" ||
          item.status === "not_run")
    )
  ) {
    return "failed"
  }
  if (modules.some((item) => item.status === "failed")) return "warning"
  if (modules.some((item) => item.status === "warning")) return "warning"
  return "passed"
}

export async function commandSetupValidate(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  let setup: ResearchSetupFile | null = null
  let setupReadError: unknown = null
  try {
    setup = await readSetupFile(root, projectPath)
  } catch (error) {
    setupReadError = error
  }

  const selected =
    parseModuleList(args.options.modules) ??
    (setup ? requiredSetupModules(setup) : [...FUNDAMENTAL_SETUP_MODULE_IDS])
  const existing = await readValidationFile(root, projectPath)
  const byModule = new Map(
    (existing?.modules ?? []).map((item) => [item.moduleId, item])
  )
  const evalCache: { value?: Awaited<ReturnType<typeof runToolCommand>> } = {}

  for (const moduleId of selected) {
    const required = setup
      ? setupModuleRequirement(setup, moduleId).required
      : isFundamentalSetupModule(moduleId)
    byModule.set(
      moduleId,
      await validateModule({
        root,
        projectPath,
        setup,
        setupReadError,
        moduleId,
        required,
        evalCache,
      })
    )
  }

  const modules = SETUP_MODULE_IDS.map(
    (moduleId) =>
      byModule.get(moduleId) ??
      result({
        moduleId,
        status: "not_run",
        required: setup
          ? setupModuleRequirement(setup, moduleId).required
          : isFundamentalSetupModule(moduleId),
        summary: "Not run.",
      })
  )
  const status = validationStatus(modules)
  const failedRequired = modules.filter(
    (item) =>
      item.required &&
      (item.status === "failed" ||
        item.status === "skipped" ||
        item.status === "not_run")
  )
  const validation: ResearchSetupValidationFile = {
    schemaVersion: 1,
    status,
    generatedAt: new Date().toISOString(),
    modules,
    summary:
      failedRequired.length > 0
        ? `${failedRequired.length} required setup module(s) are not passing.`
        : "Required setup modules are passing.",
  }
  await writeValidationFile(root, projectPath, validation)

  console.log(`setup validation: ${status}`)
  for (const item of modules.filter((module) => selected.includes(module.moduleId))) {
    console.log(
      `${item.moduleId}: ${item.status}${item.required ? " required" : " optional"} - ${item.summary ?? ""}`
    )
  }
  console.log(`wrote ${validationPath(root, projectPath)}`)
}

export async function commandSetupModules(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const setup = await readSetupFile(root, projectPath)
  const validation = await readValidationFile(root, projectPath)

  for (const moduleId of SETUP_MODULE_IDS) {
    const requirement = setupModuleRequirement(setup, moduleId)
    const latest = validation?.modules.find((item) => item.moduleId === moduleId)
    console.log(
      `${moduleId}: ${requirement.required ? "required" : "optional"}; latest=${latest?.status ?? "not_run"}`
    )
  }
}

async function setModuleRequirement({
  args,
  required,
}: {
  args: Args
  required: boolean
}) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const moduleId = parseSetupModuleId(args.positional[2] ?? "")
  if (!required && isFundamentalSetupModule(moduleId)) {
    throw new Error(`${moduleId} is fundamental for Onyx and cannot be optional.`)
  }
  const setup = await readSetupFile(root, projectPath)
  setup.modules = {
    ...setup.modules,
    [moduleId]: {
      required,
      reason:
        args.options.reason ??
        (required ? "Required by local setup policy." : null),
    },
  }
  await writeSetupFile(root, projectPath, setup)
  console.log(`${moduleId}: ${required ? "required" : "optional"}`)
}

export function commandSetupRequire(args: Args) {
  return setModuleRequirement({ args, required: true })
}

export function commandSetupOptional(args: Args) {
  return setModuleRequirement({ args, required: false })
}
