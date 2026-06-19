import { readFile, writeFile } from "node:fs/promises"

import {
  researchSetupFileSchema,
  researchSetupModuleIdSchema,
  researchSetupValidationFileSchema,
  type ResearchSetupFile,
  type ResearchSetupModuleId,
  type ResearchSetupValidationFile,
  type ResearchSetupValidationModuleResult,
} from "../protocol"

import { onyxPath } from "./project"

export type {
  ResearchSetupFile,
  ResearchSetupModuleId,
  ResearchSetupValidationFile,
  ResearchSetupValidationModuleResult,
}

export const FUNDAMENTAL_SETUP_MODULE_IDS = [
  "setup_spec",
  "project_scope",
  "agent",
  "evaluation",
] as const satisfies readonly ResearchSetupModuleId[]

export const CONDITIONAL_SETUP_MODULE_IDS = [
  "safety",
  "reliability",
  "reset",
  "resources",
] as const satisfies readonly ResearchSetupModuleId[]

export const SETUP_MODULE_IDS = [
  ...FUNDAMENTAL_SETUP_MODULE_IDS,
  ...CONDITIONAL_SETUP_MODULE_IDS,
] as const satisfies readonly ResearchSetupModuleId[]

export function setupPath(root: string, projectPath: string) {
  return onyxPath(root, projectPath, "setup.json")
}

export function validationPath(root: string, projectPath: string) {
  return onyxPath(root, projectPath, "validation.json")
}

export function normalizeSetupFile(value: unknown): ResearchSetupFile {
  return researchSetupFileSchema.parse(value)
}

export function normalizeValidationFile(
  value: unknown
): ResearchSetupValidationFile {
  return researchSetupValidationFileSchema.parse(value)
}

export function parseSetupModuleId(value: string): ResearchSetupModuleId {
  return researchSetupModuleIdSchema.parse(normalizeSetupModuleId(value))
}

export function normalizeSetupModuleId(value: string) {
  const legacy: Record<string, ResearchSetupModuleId> = {
    metric: "evaluation",
    evaluation_definition: "evaluation",
    evaluation_run: "evaluation",
    metric_parsing: "evaluation",
    agent_handoff: "agent",
    checks: "reliability",
    repeatability: "reliability",
    environment: "resources",
    hardware: "resources",
    git_remote: "resources",
  }
  return legacy[value] ?? value
}

export async function readSetupFile(
  root: string,
  projectPath: string
): Promise<ResearchSetupFile> {
  const parsed: unknown = JSON.parse(
    await readFile(setupPath(root, projectPath), "utf8")
  )
  return normalizeSetupFile(parsed)
}

export async function writeSetupFile(
  root: string,
  projectPath: string,
  setup: ResearchSetupFile
) {
  const normalized = normalizeSetupFile(setup)
  await writeFile(
    setupPath(root, projectPath),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  )
}

export async function readValidationFile(
  root: string,
  projectPath: string
): Promise<ResearchSetupValidationFile | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(validationPath(root, projectPath), "utf8")
    )
    return normalizeValidationFile(parsed)
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null
    }
    throw error
  }
}

export async function writeValidationFile(
  root: string,
  projectPath: string,
  validation: ResearchSetupValidationFile
) {
  const normalized = normalizeValidationFile(validation)
  await writeFile(
    validationPath(root, projectPath),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  )
}

export function isFundamentalSetupModule(id: ResearchSetupModuleId) {
  return FUNDAMENTAL_SETUP_MODULE_IDS.includes(
    id as (typeof FUNDAMENTAL_SETUP_MODULE_IDS)[number]
  )
}

export function setupModuleRequirement(
  setup: ResearchSetupFile,
  id: ResearchSetupModuleId
) {
  if (isFundamentalSetupModule(id)) {
    return {
      required: true,
      reason: "Required for Onyx auto research.",
    }
  }
  return setup.modules[id] ?? { required: false, reason: null }
}

export function requiredSetupModules(setup: ResearchSetupFile) {
  return SETUP_MODULE_IDS.filter(
    (id) => setupModuleRequirement(setup, id).required
  )
}
