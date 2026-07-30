import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"

import {
  researchSetupFileSchema,
  researchSetupValidationFileSchema,
  type ResearchSetupFile,
  type ResearchSetupId,
  type ResearchSetupTool,
  type ResearchSetupValidationFile,
  type ResearchSetupValidationCheck,
  type ResearchSetupWorkflowStep,
} from "../protocol"

import { onyxPath } from "./project"

export type {
  ResearchSetupFile,
  ResearchSetupId,
  ResearchSetupTool,
  ResearchSetupValidationCheck,
  ResearchSetupValidationFile,
  ResearchSetupWorkflowStep,
}

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

export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function setupHash(setup: ResearchSetupFile) {
  const normalized = normalizeSetupFile(setup)
  return `sha256:${createHash("sha256").update(sortedJson(normalized)).digest("hex")}`
}

export function validationMatchesSetup({
  setup,
  validation,
}: {
  setup: ResearchSetupFile
  validation: ResearchSetupValidationFile | null
}) {
  return validation?.setupHash === setupHash(setup)
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
