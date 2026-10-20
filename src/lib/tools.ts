import { assertWslExecutable } from "./linux-environment"
import { assertWslResearchEnvironment } from "./git"
import { readFile } from "node:fs/promises"
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
import { sandboxCommand, type ResolvedSandboxPolicy } from "./sandbox"

export const ONYX_WORKER_SANDBOX_POLICY = "ONYX_WORKER_SANDBOX_POLICY"

async function toolSandboxPolicy(
  env: NodeJS.ProcessEnv,
  override?: string | null
) {
  const path = (override ?? env[ONYX_WORKER_SANDBOX_POLICY])?.trim()
  if (!path) return null
  const policy = JSON.parse(
    await readFile(path, "utf8")
  ) as ResolvedSandboxPolicy
  if (policy?.schemaVersion !== 1 || policy.role !== "tool") {
    throw new Error(`Invalid worker tool sandbox policy at ${path}`)
  }
  return policy
}

/** A tool's processes could not be proven stopped; its resource locks are
 * deliberately kept until an explicit idle reset. */
export class ToolProtectionUncertainError extends Error {
  constructor() {
    super(
      "Tool process termination is uncertain; retaining resource locks for explicit idle reset"
    )
    this.name = "ToolProtectionUncertainError"
  }
}

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
    `${prefix}onyx/sandbox.json`,
    `${prefix}onyx/sim.json`,
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

/**
 * Leases every named resource, in sorted order so two holders can never
 * deadlock, and returns one release for all of them.
 */
export async function acquireNamedResources({
  root,
  resources,
  resourceNames,
  timeoutMs,
}: {
  root: string
  resources: ResearchSetupFile["resources"]
  resourceNames: string[]
  timeoutMs: number
}) {
  const releases: Array<() => Promise<void>> = []
  try {
    for (const resourceName of [...new Set(resourceNames)].sort()) {
      releases.push(
        await acquireResourceSlot({
          root,
          resourceName,
          slots: resources[resourceName]?.slots ?? 1,
          timeoutMs,
          leaseMs: timeoutMs,
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

async function acquireResources({
  root,
  api,
  command,
}: {
  root: string
  api: ToolApi
  command: ToolCommand
}) {
  return acquireNamedResources({
    root,
    resources: api.resources,
    resourceNames: command.resources,
    timeoutMs: command.leaseTimeoutSeconds * 1000,
  })
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
  resourcesHeld = false,
  sandboxPolicyPath = null,
}: {
  root: string
  projectPath: string
  name: string
  extraArgs?: string[]
  env?: NodeJS.ProcessEnv
  timeoutSeconds?: number
  /** The caller already leases every resource this tool declares. */
  resourcesHeld?: boolean
  /** Tool sandbox policy to use instead of the worker's default one. */
  sandboxPolicyPath?: string | null
}): Promise<ToolRunResult> {
  const api = await readCanonicalToolApi(root, projectPath)
  const command = await getToolCommand({ root, projectPath, name })
  if (!command) {
    throw new Error(`Tool command "${name}" is not declared in onyx/setup.json`)
  }

  await assertWslResearchEnvironment(root, [
    resolveCwd(root, projectPath, command.cwd),
  ])
  const release = resourcesHeld
    ? async () => {}
    : await acquireResources({ root, api, command })
  let protectionUncertain = false
  try {
    const cwd = resolveCwd(root, projectPath, command.cwd)
    const toolEnv: NodeJS.ProcessEnv = {
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
    await assertWslExecutable(
      command.shell === false ? command.command : "sh",
      toolEnv,
      cwd
    )
    const timeoutMs = (timeoutSeconds ?? command.timeoutSeconds) * 1000
    const invocation =
      command.shell === false
        ? { command: command.command, args: [...command.args, ...extraArgs] }
        : {
            command: "sh",
            args: [
              "-lc",
              [
                command.command,
                ...command.args.map(quoteShellArg),
                ...extraArgs.map(quoteShellArg),
              ].join(" "),
            ],
          }
    const sandbox = await toolSandboxPolicy(process.env, sandboxPolicyPath)
    if (sandbox) delete toolEnv[ONYX_WORKER_SANDBOX_POLICY]
    const launched = sandbox
      ? await sandboxCommand(sandbox, { ...invocation, cwd }, toolEnv)
      : invocation
    const result = await runProcess(launched.command, launched.args, {
      cwd,
      env: toolEnv,
      timeoutMs,
    })
    protectionUncertain = result.protectionUncertain ?? false
    if (protectionUncertain) throw new ToolProtectionUncertainError()
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
