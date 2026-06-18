import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"

import {
  researchSetupContractSchema,
  type ResearchSetupContract,
} from "../protocol"

export type { ResearchSetupContract }

import { onyxPath } from "./project"

export function contractPath(root: string, projectPath: string) {
  return onyxPath(root, projectPath, "contract.json")
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }

  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`
}

export function setupContractHash(contract: ResearchSetupContract) {
  const hashable = { ...contract } as Record<string, unknown>
  delete hashable.contractHash
  return `sha256:${createHash("sha256")
    .update(stableStringify(hashable))
    .digest("hex")}`
}

export function normalizeSetupContract(
  value: unknown,
  { repairHash = false }: { repairHash?: boolean } = {}
): ResearchSetupContract {
  const candidate =
    repairHash &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !("contractHash" in value)
      ? {
          ...(value as Record<string, unknown>),
          contractHash: "sha256:pending",
        }
      : value
  const parsed = researchSetupContractSchema.parse(candidate)
  const hash = setupContractHash(parsed)
  const next = repairHash ? { ...parsed, contractHash: hash } : parsed

  if (next.contractHash !== hash) {
    throw new Error(
      `onyx/contract.json contractHash is ${next.contractHash}; expected ${hash}`
    )
  }

  return next
}

export async function readSetupContract(
  root: string,
  projectPath: string
): Promise<ResearchSetupContract> {
  const path = contractPath(root, projectPath)
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  return normalizeSetupContract(parsed)
}

export async function writeSetupContract(
  root: string,
  projectPath: string,
  contract: ResearchSetupContract
) {
  await writeFile(
    contractPath(root, projectPath),
    `${JSON.stringify(contract, null, 2)}\n`,
    "utf8"
  )
}
