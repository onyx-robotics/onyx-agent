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
import { parseWorkflowMetricLines, summarizeOutput } from "../lib/metrics"
import { runToolCommand, type ToolRunResult } from "../lib/tools"

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

function stripShellQuotes(value: string) {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  return (first === "'" && last === "'") || (first === '"' && last === '"')
    ? value.slice(1, -1)
    : value
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
    schemaVersion: 2,
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

function normalizedEvalScriptPath(value: string, projectPath: string) {
  let normalized = stripShellQuotes(value.trim())
  while (normalized.startsWith("./")) normalized = normalized.slice(2)
  const projectPrefix = projectPath
    ? `${projectPath.replace(/^\.?\//, "")}/`
    : ""
  if (projectPrefix && normalized.startsWith(projectPrefix)) {
    normalized = normalized.slice(projectPrefix.length)
  }
  return normalized
}

function isShellInterpreter(value: string) {
  const executable = stripShellQuotes(value).split("/").pop()
  return executable === "bash" || executable === "sh" || executable === "zsh"
}

function isSelfReferentialEvalCommand(
  evalCommand: string | undefined,
  projectPath: string
) {
  if (!evalCommand) return false
  const target = "onyx/tools/evaluation/run.sh"
  const tokens = evalCommand.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const command = tokens[0]
  if (!command) return false
  const normalizedTokens = tokens.map((token) =>
    normalizedEvalScriptPath(token, projectPath)
  )
  if (normalizedTokens[0] === target) return true
  if (isShellInterpreter(command)) {
    return normalizedTokens.slice(1).some((token) => token === target)
  }
  return false
}

function placeholderEvalScript(setup: ResearchSetupFile) {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `echo ${shellQuote(`TODO: replace onyx/tools/evaluation/run.sh with a real eval that emits METRIC ${setup.metric.name}=<number>`)} >&2`,
    'echo "Setup validation executes this tool; configure it before starting research." >&2',
    "exit 1",
    "",
  ].join("\n")
}

function defaultEvalScript(setup: ResearchSetupFile, args: Args) {
  const evalCommand = args.options["eval-command"]
  if (
    evalCommand &&
    !isSelfReferentialEvalCommand(evalCommand, setup.projectPath)
  ) {
    return ["#!/usr/bin/env bash", "set -euo pipefail", evalCommand, ""].join(
      "\n"
    )
  }
  return placeholderEvalScript(setup)
}

function defaultInstructions(setup: ResearchSetupFile, args: Args) {
  const metric = `${setup.metric.name}${setup.metric.unit ? ` (${setup.metric.unit})` : ""}`
  const metricStep = setup.workflow.find((step) => step.metric && step.run)
  const metricTool = metricStep?.run ? setup.tools[metricStep.run] : undefined
  const metricToolCommand = metricTool
    ? [metricTool.command, ...(metricTool.args ?? [])].join(" ")
    : undefined
  const evalCommand =
    args.options["eval-command"] ??
    metricToolCommand ??
    metricStep?.run ??
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
    "# Onyx Research Spec",
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
    "- Interpretation notes: describe what metric movement means for this project, including noise, tradeoffs, and anti-gaming constraints.",
    "",
    "## Editable Scope",
    "",
    markdownList(editable, "No editable scope configured yet."),
    "",
    "Research changes should stay inside the editable scope above. Setup and tool changes require a new setup version.",
    "",
    "## Protected Setup Surface",
    "",
    markdownList(
      setup.scope.protected,
      "onyx/setup.json, onyx/validation.json, onyx/onyx.md, and onyx/tools/"
    ),
    "",
    "## Evaluation",
    "",
    `- Canonical tool: evaluation.run`,
    `- Configured metric command: ${evalCommand}`,
    "- Caveats: document project-specific assumptions, hardware limits, flaky checks, required services, and invalid shortcuts here.",
    "",
    "## Workflow And Tools",
    "",
    workflow.join("\n"),
    "",
    "The Onyx CLI enforces the workflow contract during research attempts.",
    "",
    "## Declared Tools",
    "",
    markdownList(toolIds, "No tools configured."),
    "",
    "## Project Guidance",
    "",
    "- Known risky areas: add files, subsystems, or behaviors that require extra care.",
    "- Useful starting points: add source paths, tests, dashboards, traces, or papers worth checking first.",
    "- Preserve: add product, safety, reliability, or interface constraints that metric wins must not break.",
    "- Avoid: add project-specific shortcuts, hacks, or previously failed ideas.",
    "",
  ].join("\n")
}

async function buildValidation({
  root,
  projectPath,
  setup,
  executeMetricTool,
}: {
  root: string
  projectPath: string
  setup: ResearchSetupFile
  executeMetricTool: boolean
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
    checks.push(check("research_spec", "failed", "onyx/onyx.md is missing."))
  } else {
    const text = await readFile(instructionsPath, "utf8")
    const hasContext = text.trim().length >= 40
    checks.push(
      hasContext
        ? check(
            "research_spec",
            "passed",
            "onyx/onyx.md contains research spec context."
          )
        : check(
            "research_spec",
            "failed",
            "onyx/onyx.md research spec is too sparse."
          )
    )
    if (hasContext) {
      const missingHints = [
        text.includes(setup.metric.name) ? null : setup.metric.name,
        text.includes("Evaluation") || text.includes("evaluation")
          ? null
          : "evaluation guidance",
        text.includes("editable") || text.includes("Editable")
          ? null
          : "editable scope",
      ].filter(Boolean)
      if (missingHints.length > 0) {
        checks.push(
          check(
            "research_spec_quality",
            "warning",
            `onyx/onyx.md is present but should mention ${missingHints.join(", ")} for research workers.`
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
  if (metricStep?.run) {
    if (!executeMetricTool) {
      checks.push(
        check(
          "metric_tool_readiness",
          "failed",
          `Run \`onyx setup validate\` after configuring ${metricStep.run}; it must emit exactly one primary METRIC ${setup.metric.name}=<number> line before research can start.`,
          {
            toolId: metricStep.run,
            exitCode: null,
            timedOut: false,
            primaryMetric: null,
            secondaryMetricNames: [],
            outputSummary: null,
            checkedAt: new Date().toISOString(),
            error: "metric tool has not been executed by setup validation",
          }
        )
      )
    } else {
      let result: ToolRunResult | null = null
      let parsed: ReturnType<typeof parseWorkflowMetricLines> = {
        metrics: {},
        error: null,
      }
      try {
        result = await runToolCommand({
          root,
          projectPath,
          name: metricStep.run,
        })
        parsed = parseWorkflowMetricLines(result.stdout, setup.metric.name)
      } catch (error) {
        checks.push(
          check(
            "metric_tool_readiness",
            "failed",
            `Metric tool ${metricStep.run} could not be executed: ${error instanceof Error ? error.message : String(error)}`,
            {
              toolId: metricStep.run,
              exitCode: null,
              timedOut: false,
              primaryMetric: null,
              secondaryMetricNames: [],
              outputSummary: null,
              checkedAt: new Date().toISOString(),
              error: error instanceof Error ? error.message : String(error),
            }
          )
        )
        parsed = { metrics: {}, error: null }
      }
      if (result) {
        const primaryMetricValue = parsed.metrics[setup.metric.name] ?? null
        const secondaryMetricNames = Object.keys(parsed.metrics)
          .filter((name) => name !== setup.metric.name)
          .sort()
        const failed =
          result.timedOut || result.code !== 0 || parsed.error !== null
        checks.push(
          failed
            ? check(
                "metric_tool_readiness",
                "failed",
                [
                  result.timedOut
                    ? `Metric tool ${metricStep.run} timed out.`
                    : result.code !== 0
                      ? `Metric tool ${metricStep.run} exited with code ${result.code}.`
                      : null,
                  parsed.error,
                ]
                  .filter(Boolean)
                  .join(" ") ||
                  `Metric tool ${metricStep.run} did not prove readiness.`,
                {
                  toolId: metricStep.run,
                  exitCode: result.code,
                  timedOut: result.timedOut,
                  primaryMetric:
                    primaryMetricValue === null
                      ? null
                      : { name: setup.metric.name, value: primaryMetricValue },
                  secondaryMetricNames,
                  outputSummary: summarizeOutput(result.stdout, result.stderr),
                  checkedAt: new Date().toISOString(),
                  error: parsed.error,
                }
              )
            : check(
                "metric_tool_readiness",
                "passed",
                `Metric tool ${metricStep.run} emitted primary METRIC ${setup.metric.name}=${primaryMetricValue}.`,
                {
                  toolId: metricStep.run,
                  exitCode: result.code,
                  timedOut: result.timedOut,
                  primaryMetric: {
                    name: setup.metric.name,
                    value: primaryMetricValue,
                  },
                  secondaryMetricNames,
                  outputSummary: summarizeOutput(result.stdout, result.stderr),
                  checkedAt: new Date().toISOString(),
                  error: null,
                }
              )
        )
      }
    }
  }

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
        "Recommendation: add a safety-style workflow or tool step for long-running or real-world research."
      )
    )
  }
  if (!hasReadiness) {
    checks.push(
      check(
        "readiness_warning",
        "warning",
        "Recommendation: add a readiness/reset-style workflow or tool step when experiments need environment cleanup."
      )
    )
  }
  if (!hasReliability) {
    checks.push(
      check(
        "reliability_warning",
        "warning",
        "Recommendation: add a reliability/check-style workflow or tool step when metric wins need extra guardrails."
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

async function validateAndWrite({
  root,
  projectPath,
  executeMetricTool,
}: {
  root: string
  projectPath: string
  executeMetricTool: boolean
}) {
  const setup = await readSetupFile(root, projectPath)
  const validation = await buildValidation({
    root,
    projectPath,
    setup,
    executeMetricTool,
  })
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
  const validation = await validateAndWrite({
    root,
    projectPath,
    executeMetricTool: false,
  })

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
  if (isSelfReferentialEvalCommand(args.options["eval-command"], projectPath)) {
    console.warn(
      "warning: --eval-command points at onyx/tools/evaluation/run.sh, which would make the generated script call itself; kept the placeholder eval script instead."
    )
  }
  console.log(
    "next: edit onyx/setup.json, onyx/onyx.md, and onyx/tools/* for this repository, then run `onyx setup validate` to execute the metric tool and prove readiness."
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
  const validation = await validateAndWrite({
    root,
    projectPath,
    executeMetricTool: true,
  })

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
    "metric readiness: `onyx setup validate` executed the canonical metric tool and recorded readiness evidence in validation.json."
  )
}
