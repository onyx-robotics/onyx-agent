import { readFile } from "node:fs/promises"

import type { Args } from "../lib/args"
import {
  contractPath,
  normalizeSetupContract,
  writeSetupContract,
} from "../lib/contract"
import { repoRoot } from "../lib/git"
import { resolveProjectPath } from "../lib/project"

export async function commandContractHash(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const path = contractPath(root, projectPath)
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  const contract = normalizeSetupContract(parsed, { repairHash: true })

  if (args.options.write === "true") {
    await writeSetupContract(root, projectPath, contract)
  }

  console.log(contract.contractHash)
}
