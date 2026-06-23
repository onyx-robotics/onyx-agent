import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"

import type { Args } from "../lib/args"
import {
  readSetupFile,
  setupHash,
  setupPath,
  validationPath,
  writeValidationFile,
  type ResearchSetupFile,
  type ResearchSetupValidationCheck,
  type ResearchSetupValidationFile,
} from "../lib/contract"
import { repoRoot } from "../lib/git"
import { onyxPath, resolveProjectPath } from "../lib/project"
import { pathExists } from "../lib/process"

const PROTECTED_SETUP_PATHS = [
  "onyx/setup.json",
  "onyx/validation.json",
  "onyx/onyx.md",
  "onyx/tools/",
]

function splitList(value?: string) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function markdownList(items: string[], empty: string) {
  return items.length > 0
    ? items.map((item) => `- ${item}`).join("\n")
    : `- ${empty}`
}

function check(
  id: string,
  status: ResearchSetupValidationCheck["status"],
  message: string,
  evidence: Record<string, unknown> = {}
): ResearchSetupValidationCheck {
  return { id, status, message, evidence }
}

function validationStatus(
  checks: ResearchSetupValidationCheck[]
): ResearchSetupValidationFile["status"] {
  if (checks.some((item) => item.status === "failed")) return "failed"
  if (checks.some((item) => item.status === "warning")) return "warning"
  return "passed"
}

function defaultSetupFile(projectPath: string, args: Args): ResearchSetupFile {
  const metricDirection = args.options["metric-direction"] ?? "maximize"
  if (metricDirection !== "maximize" && metricDirection !== "minimize") {
    throw new Error("--metric-direction must be maximize or minimize")
  }
  const metricName = args.options["metric-name"] ?? "score"

  return {
    schemaVersion: 1,
    goal:
      args.options.goal ??
      "Improve the target metric without changing protected setup files.",
    projectPath,
    scope: {
      editable: splitList(args.options["editable-scope"]),
      protected: PROTECTED_SETUP_PATHS,
    },
    metric: {
      name: metricName,
      unit: args.options["metric-unit"] ?? null,
      direction: metricDirection,
    },
    resources: {},
    tools: {
      "evaluation.run": {
        description: "Run the canonical metric evaluation.",
        command: "bash",
        args: ["onyx/tools/evaluation/run.sh"],
        shell: false,
        cwd: "project",
        env: {},
        resources: [],
        timeoutSeconds: 600,
        leaseTimeoutSeconds: 120,
        outputLimitBytes: 4000,
      },
    },
    workflow: [
      {
        id: "edit",
        agent: "Make one scoped code change, commit it, then resume.",
        optional: false,
      },
      {
        id: "evaluate",
        run: "evaluation.run",
        metric: true,
        optional: false,
      },
    ],
  }
}

async function writeIfMissing(path: string, content: string, mode?: number) {
  if (await pathExists(path)) return false
  await writeFile(path, content, "utf8")
  if (mode !== undefined) await chmod(path, mode)
  return true
}

function toolFileReferences(setup: ResearchSetupFile) {
  const refs = new Set<string>()
  for (const tool of Object.values(setup.tools)) {
    for (const candidate of [tool.command, ...tool.args]) {
      const normalized = candidate.replace(/^\.?\//, "")
      if (normalized.startsWith("onyx/tools/")) refs.add(normalized)
    }
  }
  return [...refs].sort()
}

function defaultEvalScript(setup: ResearchSetupFile, args: Args) {
  const evalCommand = args.options["eval-command"]
  if (evalCommand) {
    return ["#!/usr/bin/env bash", "set -euo pipefail", evalCommand, ""].join(
      "\n"
    )
  }
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `echo ${shellQuote(`TODO: replace onyx/tools/evaluation/run.sh with a real eval that emits METRIC ${setup.metric.name}=<number>`)} >&2`,
    'echo "Setup validation is static; configure this tool before running a workflow." >&2',
    "exit 1",
    "",
  ].join("\n")
}

function defaultInstructions(setup: ResearchSetupFile, args: Args) {
  const metric = `${setup.metric.name}${setup.metric.unit ? ` (${setup.metric.unit})` : ""}`
  const evalCommand =
    args.options["eval-command"] ??
    "onyx/tools/evaluation/run.sh currently exits nonzero until you replace it with the real eval."
  const editable = setup.scope.editable.length
    ? setup.scope.editable
    : ["No editable scope was provided. Add one before real research."]
  const toolIds = Object.keys(setup.tools).sort()
  const workflow = setup.workflow.map((step) => {
    if (step.agent) return `- ${step.id}: agent step - ${step.agent}`
    if (step.run) {
      return `- ${step.id}: run ${step.run}${step.metric ? ` and capture METRIC ${setup.metric.name}=<number>` : ""}`
    }
    return `- ${step.id}: ${JSON.stringify(step)}`
  })

  return [
    "# Onyx Worker Instructions",
    "",
    "## Goal",
    "",
    setup.goal,
    "",
    "## Primary Metric",
    "",
    `- Name: ${metric}`,
    `- Direction: ${setup.metric.direction}`,
    "- Required output: the evaluation workflow must emit exactly one primary metric line shaped as `METRIC " +
      `${setup.metric.name}=<number>\`.`,
    "",
    "## Editable Scope",
    "",
    markdownList(editable, "No editable scope configured yet."),
    "",
    "Workers may edit only the scoped project files above. They must not edit protected setup files during Research.",
    "",
    "## Protected Setup Surface",
    "",
    markdownList(setup.scope.protected, "onyx/setup.json, onyx/validation.json, onyx/onyx.md, and onyx/tools/"),
    "",
    "## Evaluation",
    "",
    `- Canonical tool: evaluation.run`,
    `- Command configured from setup init: ${evalCommand}`,
    "- Preflight before committing setup: `onyx tools run evaluation.run`",
    "",
    "## Workflow Contract",
    "",
    workflow.join("\n"),
    "",
    "Every experiment attempt should start with `onyx exp run`, pause at the agent step, make exactly one clean result commit, resume the workflow, then log the terminal attempt with `onyx exp log`.",
    "",
    "## Tools",
    "",
    markdownList(toolIds, "No tools configured."),
    "",
    "## First-Run Checklist",
    "",
    "- Confirm the editable scope is complete and narrow.",
    "- Replace the evaluation tool if the scaffolded script is still a TODO.",
    "- Run `onyx setup validate` and fix failed checks.",
    "- Run `onyx tools run evaluation.run` and confirm it emits the primary metric.",
    "- Commit `onyx/setup.json`, `onyx/validation.json`, `onyx/onyx.md`, and `onyx/tools/*` before campaign setup or research start.",
    "",
  ].join("\n")
}

async function buildValidation({
  root,
  projectPath,
  setup,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
}): Promise<ResearchSetupValidationFile> {
  const checks: ResearchSetupValidationCheck[] = []

  checks.push(
    check("setup_schema", "passed", "onyx/setup.json matches the setup schema.")
  )
  checks.push(
    setup.projectPath === projectPath
      ? check("project_path", "passed", "setup projectPath matches.")
      : check(
          "project_path",
          "failed",
          `setup projectPath "${setup.projectPath}" does not match active project path "${projectPath}".`
        )
  )

  const instructionsPath = onyxPath(root, projectPath, "onyx.md")
  if (!(await pathExists(instructionsPath))) {
    checks.push(check("agent_context", "failed", "onyx/onyx.md is missing."))
  } else {
    const text = await readFile(instructionsPath, "utf8")
    const hasContext = text.trim().length >= 40
    checks.push(
      hasContext
        ? check("agent_context", "passed", "onyx/onyx.md contains context.")
        : check("agent_context", "failed", "onyx/onyx.md is too sparse.")
    )
    if (hasContext) {
      const missingHints = [
        text.includes(setup.metric.name) ? null : setup.metric.name,
        text.includes("onyx exp run") ? null : "onyx exp run",
        text.includes("editable") || text.includes("Editable")
          ? null
          : "editable scope",
      ].filter(Boolean)
      if (missingHints.length > 0) {
        checks.push(
          check(
            "agent_context_quality",
            "warning",
            `onyx/onyx.md is present but should mention ${missingHints.join(", ")} for first-run workers.`
          )
        )
      }
    }
  }

  const metricStep = setup.workflow.find((step) => step.metric)
  checks.push(
    metricStep?.run
      ? check(
          "metric_capture",
          "passed",
          `Step ${metricStep.id} captures ${setup.metric.name}.`
        )
      : check(
          "metric_capture",
          "failed",
          `Workflow must include one required metric step for ${setup.metric.name}.`
        )
  )

  for (const path of [
    "onyx/setup.json",
    "onyx/onyx.md",
    "onyx/tools/",
    ...toolFileReferences(setup),
  ]) {
    const exists = path.endsWith("/")
      ? await pathExists(
          onyxPath(root, projectPath, path.slice("onyx/".length))
        )
      : await pathExists(
          onyxPath(root, projectPath, path.slice("onyx/".length))
        )
    checks.push(
      exists
        ? check(
            `path_${path
              .replace(/[^a-z0-9]+/gi, "_")
              .replace(/^_|_$/g, "")
              .toLowerCase()}`,
            "passed",
            `${path} exists.`
          )
        : check(
            `path_${path
              .replace(/[^a-z0-9]+/gi, "_")
              .replace(/^_|_$/g, "")
              .toLowerCase()}`,
            "failed",
            `${path} is missing.`
          )
    )
  }

  const ids = [
    ...Object.keys(setup.tools),
    ...setup.workflow.map((step) => step.id),
  ]
  const hasSafety = ids.some((id) => id.includes("safety"))
  const hasReadiness = ids.some(
    (id) => id.includes("readiness") || id.includes("reset")
  )
  const hasReliability = ids.some(
    (id) => id.includes("reliability") || id.includes("check")
  )
  if (!hasSafety) {
    checks.push(
      check(
        "safety_warning",
        "warning",
        "No safety-style workflow or tool step is declared."
      )
    )
  }
  if (!hasReadiness) {
    checks.push(
      check(
        "readiness_warning",
        "warning",
        "No readiness/reset-style workflow or tool step is declared."
      )
    )
  }
  if (!hasReliability) {
    checks.push(
      check(
        "reliability_warning",
        "warning",
        "No reliability/check-style workflow or tool step is declared."
      )
    )
  }

  const status = validationStatus(checks)
  return {
    schemaVersion: 1,
    status,
    setupHash: setupHash(setup),
    generatedAt: new Date().toISOString(),
    checks,
    summary:
      status === "failed"
        ? "One or more required setup checks failed."
        : status === "warning"
          ? "Setup checks passed with warnings."
          : "Setup checks passed.",
  }
}

async function validateAndWrite(root: string, projectPath: string) {
  const setup = await readSetupFile(root, projectPath)
  const validation = await buildValidation({ root, projectPath, setup })
  await writeValidationFile(root, projectPath, validation)
  return validation
}

export async function commandSetupInit(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const dir = onyxPath(root, projectPath)
  await mkdir(onyxPath(root, projectPath, "tools", "evaluation"), {
    recursive: true,
  })

  const setupFile = defaultSetupFile(projectPath, args)
  const wroteSetup = await writeIfMissing(
    setupPath(root, projectPath),
    `${JSON.stringify(setupFile, null, 2)}\n`
  )
  const wroteInstructions = await writeIfMissing(
    onyxPath(root, projectPath, "onyx.md"),
    defaultInstructions(setupFile, args)
  )
  const wroteEval = await writeIfMissing(
    onyxPath(root, projectPath, "tools", "evaluation", "run.sh"),
    defaultEvalScript(setupFile, args),
    0o755
  )
  const validation = await validateAndWrite(root, projectPath)

  console.log(`setup: ${dir}`)
  console.log(wroteSetup ? "created onyx/setup.json" : "kept onyx/setup.json")
  console.log(wroteInstructions ? "created onyx/onyx.md" : "kept onyx/onyx.md")
  console.log(
    wroteEval
      ? "created onyx/tools/evaluation/run.sh"
      : "kept onyx/tools/evaluation/run.sh"
  )
  console.log(`wrote ${validationPath(root, projectPath)}`)
  console.log(`setup validation: ${validation.status}`)
  console.log(
    "next: edit onyx/setup.json, onyx/onyx.md, and onyx/tools/* for this repository, then run `onyx tools run evaluation.run` for a transient eval preflight."
  )
}

export async function commandSetupValidate(args: Args) {
  if (args.options.modules || args.options.required) {
    throw new Error(
      "Setup modules were removed. Run `onyx setup validate` to validate the workflow contract."
    )
  }
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const validation = await validateAndWrite(root, projectPath)

  console.log(`setup validation: ${validation.status}`)
  const groups = [
    ["blocking", validation.checks.filter((item) => item.status === "failed")],
    ["warnings", validation.checks.filter((item) => item.status === "warning")],
    ["passed", validation.checks.filter((item) => item.status === "passed")],
  ] as const
  for (const [label, items] of groups) {
    if (items.length === 0) continue
    console.log(`${label}:`)
    for (const item of items) {
      console.log(`- ${item.id}: ${item.status} - ${item.message}`)
    }
  }
  console.log(`wrote ${validationPath(root, projectPath)}`)
  console.log(
    "preflight: run `onyx tools run evaluation.run` to execute the eval tool; setup validation is static."
  )
}
