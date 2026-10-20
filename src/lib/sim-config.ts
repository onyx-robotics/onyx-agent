import { readFile } from "node:fs/promises"

import { z } from "zod"

import type { ResearchSetupFile } from "./contract"
import { gitResult } from "./git"
import { onyxPath } from "./project"

export const SIM_CONFIG_FILE = "sim.json"

const simPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .transform((value) => value.replace(/\\/g, "/").replace(/^\.\/+|\/+$/g, ""))
  .refine(
    (value) =>
      value.length > 0 &&
      !value.startsWith("/") &&
      !value.split("/").includes(".."),
    "must be a project-relative path"
  )

/**
 * `onyx/sim.json`: the simulation gate in front of shared hardware. Its
 * presence turns on the hardware queue. Every experiment must pass `tool`
 * (exit code 0) on the result commit before it may queue for hardware, and
 * the supervisor then runs the hardware workflow one experiment at a time.
 * Simulation results are local screening data and never campaign
 * experiments. This file is local to the project and is not part of the
 * server setup contract, so it does not change the setup hash.
 */
export const simConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** Tool id in onyx/setup.json `tools`. Must not declare resources. */
    tool: z.string().trim().min(1).max(120),
    /** Project-relative simulator sources. Workers may not edit them. */
    paths: z.array(simPathSchema).min(1),
    /** Who built the simulator: the setup agent, or the user (pre-made). */
    source: z.enum(["agent", "user"]).default("agent"),
    /** Sim-passed experiments one worker may have waiting for hardware. */
    maxQueuedPerWorker: z.number().int().min(1).max(10).default(1),
  })
  .strict()

export type SimConfig = z.infer<typeof simConfigSchema>

export function simConfigPath(root: string, projectPath: string) {
  return onyxPath(root, projectPath, SIM_CONFIG_FILE)
}

function simConfigRepoPath(projectPath: string) {
  return [projectPath, "onyx", SIM_CONFIG_FILE].filter(Boolean).join("/")
}

export function parseSimConfig(raw: string, source: string): SimConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Invalid ${source}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const result = simConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Invalid ${source}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`
    )
  }
  return result.data
}

/** Reads the working-tree sim.json; null when the file does not exist. */
export async function readSimConfig(
  root: string,
  projectPath: string
): Promise<SimConfig | null> {
  const path = simConfigPath(root, projectPath)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  return parseSimConfig(raw, path)
}

/**
 * Reads sim.json as committed at `commitSha`; null when that commit has no
 * sim.json. Experiments use the copy in their base commit, like setup.json.
 */
export async function readSimConfigFromCommit({
  root,
  projectPath,
  commitSha,
}: {
  root: string
  projectPath: string
  commitSha: string
}): Promise<SimConfig | null> {
  const path = simConfigRepoPath(projectPath)
  const exists = await gitResult(["cat-file", "-e", `${commitSha}:${path}`], root)
  if (exists.code !== 0) return null
  const shown = await gitResult(["show", `${commitSha}:${path}`], root)
  if (shown.code !== 0) {
    throw new Error(`Could not read ${path} at ${commitSha}: ${shown.stderr}`)
  }
  return parseSimConfig(shown.stdout, `${path}@${commitSha.slice(0, 12)}`)
}

/** Resources used by any command step of the workflow, sorted. */
export function workflowHardwareResources(setup: ResearchSetupFile) {
  const resources = new Set<string>()
  for (const step of setup.workflow) {
    if (!step.run) continue
    for (const resource of setup.tools[step.run]?.resources ?? []) {
      resources.add(resource)
    }
  }
  return [...resources].sort()
}

/** True when the tool declares a shared resource (hardware). */
export function isHardwareTool(setup: ResearchSetupFile, toolId: string) {
  return (setup.tools[toolId]?.resources.length ?? 0) > 0
}

/**
 * Hardware jobs that may run at once: the smallest slot count among the
 * resources the workflow uses (1 unless every resource has more slots).
 */
export function hardwareConcurrency(setup: ResearchSetupFile) {
  const resources = workflowHardwareResources(setup)
  if (resources.length === 0) return 1
  return Math.max(
    1,
    Math.min(...resources.map((id) => setup.resources[id]?.slots ?? 1))
  )
}

/** Problems that make a sim.json unusable with this setup. */
export function simConfigProblems(setup: ResearchSetupFile, sim: SimConfig) {
  const problems: string[] = []
  const tool = setup.tools[sim.tool]
  if (!tool) {
    problems.push(
      `sim.json tool "${sim.tool}" is not declared in onyx/setup.json tools.`
    )
  } else if (tool.resources.length > 0) {
    problems.push(
      `sim.json tool "${sim.tool}" declares resources (${tool.resources.join(", ")}); the simulator must not use hardware.`
    )
  }
  if (setup.workflow.some((step) => step.run === sim.tool)) {
    problems.push(
      `sim.json tool "${sim.tool}" is also a workflow step; the sim gate runs on its own before hardware and must not be part of the measured workflow.`
    )
  }
  for (const path of sim.paths) {
    const overlapping = setup.scope.editable.find((scope) =>
      pathsOverlap(path, scope)
    )
    if (overlapping) {
      problems.push(
        `Simulator path ${path} overlaps editable scope ${overlapping}; workers must not be able to change the gate they are judged by.`
      )
    }
  }
  return problems
}

function pathsOverlap(left: string, right: string) {
  const a = left.replace(/^\.\/+|\/+$/g, "")
  const b = right.replace(/^\.\/+|\/+$/g, "")
  if (!a || !b) return true
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
