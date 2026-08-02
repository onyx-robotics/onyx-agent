import { join } from "node:path"

import type { Args } from "./args"
import { normalizeProjectPath } from "./project-path"
import { readState } from "./runtime-state"
import { getWorkerRuntimeContextCached } from "./worker-context"

export const ONYX_DIR = "onyx"

export { normalizeProjectPath } from "./project-path"

export async function resolveProjectPath(root: string, args: Args) {
  const context = await getWorkerRuntimeContextCached()
  if (args.options["project-path"] !== undefined) {
    const flagPath = normalizeProjectPath(args.options["project-path"])
    if (context && flagPath !== normalizeProjectPath(context.projectPath)) {
      throw new Error(
        `--project-path conflicts with supervised worker context project path "${context.projectPath}"`
      )
    }
    return flagPath
  }
  if (context) return normalizeProjectPath(context.projectPath)

  const state = await readState(root)
  return normalizeProjectPath(state.projectPath)
}

export function scopedRoot(root: string, projectPath: string) {
  return projectPath ? join(root, projectPath) : root
}

export function onyxPath(
  root: string,
  projectPath: string,
  ...segments: string[]
) {
  return join(scopedRoot(root, projectPath), ONYX_DIR, ...segments)
}

export function campaignStateKey(projectPath: string, campaignName: string) {
  return projectPath ? `${projectPath}:${campaignName}` : campaignName
}
