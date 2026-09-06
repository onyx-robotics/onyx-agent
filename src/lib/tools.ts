import { resolve } from "node:path"

import type { Args } from "./args"
import {
  readSetupFile,
  setupPath,
  validationPath,
  type ResearchSetupFile,
  type ResearchSetupTool,
} from "./contract"
import { onyxPath, resolveProjectPath, scopedRoot } from "./project"
import { runProcess, type ProcessResult } from "./process"
import { acquireFileResourceLease } from "./resource-locks"

export type ToolCommand = ResearchSetupTool
export type ToolApi = Pick<
  ResearchSetupFile,
  "schemaVersion" | "resources" | "tools"
>

export type ToolRunResult = ProcessResult & {
  commandName: string
  outputSummary: string | null
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function defaultProtectedToolPaths(projectPath: string) {
  const prefix = projectPath ? `${projectPath}/` : ""
  return [
    `${prefix}onyx/onyx.md`,
    `${prefix}onyx/setup.json`,
    `${prefix}onyx/validation.json`,
    `${prefix}onyx/tools`,
  ]
}

export async function protectedToolPaths(root: string, projectPath: string) {
  const setup = await readSetupFile(root, projectPath).catch(() => null)
  const explicit = setup?.scope.protected ?? []
  const prefix = projectPath ? `${projectPath}/` : ""
  return [
    ...new Set([
      ...defaultProtectedToolPaths(projectPath),
      ...explicit.map((path) => `${prefix}${path}`),
    ]),
  ]
}

async function readCanonicalToolApi(root: string, projectPath: string) {
  const setup = await readSetupFile(root, projectPath)
  return {
    schemaVersion: setup.schemaVersion,
    resources: setup.resources,
    tools: setup.tools,
  }
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
  return Boolean(api.tools[name])
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
  return api.tools[name] ?? null
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
  return acquireFileResourceLease({
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
  api: ToolApi
  command: ToolCommand
}) {
  const releases: Array<() => Promise<void>> = []
  try {
    for (const resourceName of [...new Set(command.resources)].sort()) {
      const resource = api.resources[resourceName]
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
    throw new Error(`Tool command "${name}" is not declared in onyx/setup.json`)
  }

  const release = await acquireResources({ root, api, command })
  let protectionUncertain = false
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
    protectionUncertain = result.protectionUncertain ?? false
    if (protectionUncertain)
      throw new Error(
        "Tool process termination is uncertain; retaining resource locks for explicit idle reset"
      )
    return {
      ...result,
      commandName: name,
      outputSummary: summarizeToolOutput(result, command.outputLimitBytes),
    }
  } finally {
    if (!protectionUncertain) await release()
  }
}

export async function resolveToolApiPath(root: string, args: Args) {
  const projectPath = await resolveProjectPath(root, args)
  return setupPath(root, projectPath)
}
