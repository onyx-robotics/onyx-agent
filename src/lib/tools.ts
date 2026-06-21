import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { z } from "zod"

import type { Args } from "./args"
import { readSetupFile, setupPath, validationPath } from "./contract"
import { onyxPath, resolveProjectPath, scopedRoot } from "./project"
import { pathExists, runProcess, type ProcessResult } from "./process"
import { acquireLocalResourceLease } from "./research-db"

export const TOOL_API_FILE = "tool-api.json"

const toolCommandSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  shell: z.boolean().default(true),
  cwd: z.string().trim().min(1).default("project"),
  env: z.record(z.string(), z.string()).default({}),
  resources: z.array(z.string().trim().min(1)).default([]),
  timeoutSeconds: z.number().positive().default(600),
  leaseTimeoutSeconds: z.number().positive().default(120),
  outputLimitBytes: z.number().int().positive().default(4000),
})

const toolResourceSchema = z.object({
  slots: z.number().int().positive().default(1),
  description: z.string().trim().optional(),
})

const toolApiSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  commands: z.record(z.string().min(1), toolCommandSchema).default({}),
  resources: z.record(z.string().min(1), toolResourceSchema).default({}),
  protectedPaths: z.array(z.string().trim().min(1)).default([]),
})

export type ToolCommand = z.infer<typeof toolCommandSchema>
export type ToolApi = z.infer<typeof toolApiSchema>

export type ToolRunResult = ProcessResult & {
  commandName: string
  outputSummary: string | null
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function toolApiPath(root: string, projectPath: string) {
  return onyxPath(root, projectPath, TOOL_API_FILE)
}

export async function readToolApi(
  root: string,
  projectPath: string
): Promise<ToolApi | null> {
  const path = toolApiPath(root, projectPath)
  if (!(await pathExists(path))) return null
  const parsed = JSON.parse(await readFile(path, "utf8"))
  return toolApiSchema.parse(parsed)
}

export async function resolveToolApiPath(root: string, args: Args) {
  return toolApiPath(root, await resolveProjectPath(root, args))
}

export function defaultProtectedToolPaths(projectPath: string) {
  const prefix = projectPath ? `${projectPath}/` : ""
  return [
    `${prefix}onyx/onyx.md`,
    `${prefix}onyx/setup.json`,
    `${prefix}onyx/validation.json`,
    `${prefix}onyx/eval.sh`,
    `${prefix}onyx/checks.sh`,
    `${prefix}onyx/tools`,
  ]
}

export async function protectedToolPaths(root: string, projectPath: string) {
  const setup = await readSetupFile(root, projectPath).catch(() => null)
  const api = setup ? null : await readToolApi(root, projectPath)
  const explicit = setup?.protectedPaths ?? api?.protectedPaths ?? []
  return [...new Set([...defaultProtectedToolPaths(projectPath), ...explicit])]
}

async function readCanonicalToolApi(
  root: string,
  projectPath: string
): Promise<ToolApi | null> {
  const setup = await readSetupFile(root, projectPath).catch(() => null)
  if (setup) {
    return {
      schemaVersion: 1,
      commands: {
        ...(setup.commands.reset ? { reset: setup.commands.reset } : {}),
        evaluate: setup.commands.evaluate,
        eval: setup.commands.evaluate,
        ...(setup.commands.check
          ? { check: setup.commands.check, checks: setup.commands.check }
          : {}),
      },
      resources: setup.resources,
      protectedPaths: setup.protectedPaths,
    }
  }
  return readToolApi(root, projectPath)
}

export async function hasToolCommand({
  root,
  projectPath,
  name,
}: {
  root: string
  projectPath: string
  name: string
}) {
  const api = await readCanonicalToolApi(root, projectPath)
  return Boolean(api?.commands[name])
}

async function fallbackToolCommand({
  root,
  projectPath,
  name,
}: {
  root: string
  projectPath: string
  name: string
}): Promise<ToolCommand | null> {
  if (name === "evaluate" || name === "eval") {
    const evalSh = onyxPath(root, projectPath, "eval.sh")
    if (await pathExists(evalSh)) {
      return {
        command: "bash",
        args: [evalSh],
        shell: false,
        cwd: "project",
        env: {},
        resources: [],
        timeoutSeconds: 600,
        leaseTimeoutSeconds: 120,
        outputLimitBytes: 4000,
      }
    }
  }

  if (name === "check" || name === "checks") {
    const checksSh = onyxPath(root, projectPath, "checks.sh")
    if (await pathExists(checksSh)) {
      return {
        command: "bash",
        args: [checksSh],
        shell: false,
        cwd: "project",
        env: {},
        resources: [],
        timeoutSeconds: 300,
        leaseTimeoutSeconds: 120,
        outputLimitBytes: 4000,
      }
    }
  }

  return null
}

async function getToolCommand({
  root,
  projectPath,
  name,
}: {
  root: string
  projectPath: string
  name: string
}) {
  const api = await readCanonicalToolApi(root, projectPath)
  return api?.commands[name] ?? fallbackToolCommand({ root, projectPath, name })
}

function resolveCwd(root: string, projectPath: string, cwd: string) {
  if (cwd === "repo") return root
  if (cwd === "project") return scopedRoot(root, projectPath)
  if (cwd === "onyx") return onyxPath(root, projectPath)

  const projectRoot = scopedRoot(root, projectPath)
  const target = resolve(projectRoot, cwd)
  if (target !== projectRoot && !target.startsWith(`${projectRoot}/`)) {
    throw new Error(`Tool cwd escapes project path: ${cwd}`)
  }
  return target
}

async function acquireResourceSlot({
  root,
  resourceName,
  slots,
  timeoutMs,
  leaseMs,
}: {
  root: string
  resourceName: string
  slots: number
  timeoutMs: number
  leaseMs: number
}) {
  return acquireLocalResourceLease({
    root,
    resourceName,
    slots,
    timeoutMs,
    leaseMs,
    ownerId: `${process.pid}:${Date.now()}:${Math.random()}`,
    metadata: { pid: process.pid },
  })
}

async function acquireResources({
  root,
  api,
  command,
}: {
  root: string
  api: ToolApi | null
  command: ToolCommand
}) {
  const releases: Array<() => Promise<void>> = []
  try {
    for (const resourceName of command.resources) {
      const resource = api?.resources[resourceName]
      releases.push(
        await acquireResourceSlot({
          root,
          resourceName,
          slots: resource?.slots ?? 1,
          timeoutMs: command.leaseTimeoutSeconds * 1000,
          leaseMs: command.leaseTimeoutSeconds * 1000,
        })
      )
    }
    return async () => {
      for (const release of releases.reverse()) await release()
    }
  } catch (error) {
    for (const release of releases.reverse()) await release().catch(() => {})
    throw error
  }
}

function summarizeToolOutput(
  result: Pick<ProcessResult, "stdout" | "stderr">,
  limit: number
) {
  const combined = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n")
  if (!combined) return null
  return combined.length > limit ? combined.slice(-limit) : combined
}

export async function runToolCommand({
  root,
  projectPath,
  name,
  extraArgs = [],
  env = {},
  timeoutSeconds,
}: {
  root: string
  projectPath: string
  name: string
  extraArgs?: string[]
  env?: NodeJS.ProcessEnv
  timeoutSeconds?: number
}): Promise<ToolRunResult> {
  const api = await readCanonicalToolApi(root, projectPath)
  const command = await getToolCommand({ root, projectPath, name })
  if (!command) {
    throw new Error(
      `Tool command "${name}" is not declared in onyx/setup.json`
    )
  }

  const release = await acquireResources({ root, api, command })
  try {
    const cwd = resolveCwd(root, projectPath, command.cwd)
    const toolEnv = {
      ...process.env,
      ...command.env,
      ...env,
      ONYX_TOOL_NAME: name,
      ONYX_REPO_ROOT: root,
      ONYX_PROJECT_ROOT: scopedRoot(root, projectPath),
      ONYX_PROJECT_PATH: projectPath,
      ONYX_SETUP_FILE: setupPath(root, projectPath),
      ONYX_VALIDATION_FILE: validationPath(root, projectPath),
      ONYX_TOOL_API_FILE: toolApiPath(root, projectPath),
    }
    const timeoutMs = (timeoutSeconds ?? command.timeoutSeconds) * 1000
    const result =
      command.shell === false
        ? await runProcess(command.command, [...command.args, ...extraArgs], {
            cwd,
            env: toolEnv,
            timeoutMs,
          })
        : await runProcess(
            "sh",
            [
              "-lc",
              [
                command.command,
                ...command.args.map(quoteShellArg),
                ...extraArgs.map(quoteShellArg),
              ].join(" "),
            ],
            {
              cwd,
              env: toolEnv,
              timeoutMs,
            }
          )
    return {
      ...result,
      commandName: name,
      outputSummary: summarizeToolOutput(result, command.outputLimitBytes),
    }
  } finally {
    await release()
  }
}
