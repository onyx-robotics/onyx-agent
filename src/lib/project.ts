import { join } from "node:path"

import type { Args } from "./args"
import { readState } from "./outbox"

export const ONYX_DIR = "onyx"

export function normalizeProjectPath(value?: string | null) {
  const path = (value ?? "").trim().replace(/^\/+|\/+$/g, "")
  if (
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("--project-path must be a relative path without '..'")
  }
  return path
}

export async function resolveProjectPath(root: string, args: Args) {
  if (args.options["project-path"] !== undefined) {
    return normalizeProjectPath(args.options["project-path"])
  }

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
