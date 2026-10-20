import { readFile, stat } from "node:fs/promises"

import { z } from "zod"

import type { Args } from "./args"
import { onyxPath } from "./project"

export const SANDBOX_CONFIG_FILE = "sandbox.json"
/** One-off escape hatch for debugging; recorded in session metadata. */
export const NO_SANDBOX_FLAG = "no-sandbox"

const sandboxPathSchema = z.string().trim().min(1).max(1024)

/**
 * `onyx/sandbox.json`: the user's OS-level confinement policy for supervised
 * workers and the evaluation tools they trigger. Its presence turns the
 * sandbox on; `{}` applies the defaults. Paths are absolute, `~/`
 * home-relative, or relative to the project root inside each worker's
 * worktree.
 */
export const sandboxConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** all: the whole worktree is writable except protected paths.
     * editable: only `scope.editable` from setup.json plus `write`. */
    worktreeWrites: z.enum(["all", "editable"]).default("all"),
    read: z.array(sandboxPathSchema).default([]),
    write: z.array(sandboxPathSchema).default([]),
    /** null: anything readable may be executed. A list restricts execution
     * to these paths plus the system and provider directories Onyx needs
     * (Landlock on Linux, Seatbelt on macOS). */
    exec: z.array(sandboxPathSchema).nullable().default(null),
    /** Device nodes passed through, e.g. /dev/ttyUSB0 or /dev/nvidia0. */
    devices: z.array(sandboxPathSchema).default([]),
  })
  .strict()

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>

export function defaultSandboxConfig(): SandboxConfig {
  return sandboxConfigSchema.parse({})
}

export function sandboxConfigPath(root: string, projectPath: string) {
  return onyxPath(root, projectPath, SANDBOX_CONFIG_FILE)
}

/**
 * Whether this session's workers are confined, and by which policy. The
 * policy is read from the supervisor's checkout, never from a worker
 * worktree. A malformed file is a hard error so a typo can never silently
 * disable confinement; only an explicit `--no-sandbox` turns it off.
 */
export type SandboxSelection =
  | { enabled: true; config: SandboxConfig }
  | { enabled: false; configPresent: boolean; disabledByFlag: boolean }

export function assertNoRemovedSandboxFlag(args: Args) {
  if (args.options.sandbox !== undefined) {
    throw new Error(
      "--sandbox was removed. Workers are sandboxed whenever onyx/sandbox.json exists ({} uses the defaults); pass --no-sandbox to run one session unconfined."
    )
  }
}

export async function selectSandbox({
  root,
  projectPath,
  args,
}: {
  root: string
  projectPath: string
  args: Args
}): Promise<SandboxSelection> {
  assertNoRemovedSandboxFlag(args)
  const path = sandboxConfigPath(root, projectPath)
  if (args.options[NO_SANDBOX_FLAG] === "true") {
    const configPresent = await stat(path).then(
      () => true,
      () => false
    )
    return { enabled: false, configPresent, disabledByFlag: true }
  }
  const config = await readSandboxConfig(path)
  return config
    ? { enabled: true, config }
    : { enabled: false, configPresent: false, disabledByFlag: false }
}

/** Parses a sandbox.json; null when the file does not exist. */
export async function readSandboxConfig(
  path: string
): Promise<SandboxConfig | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const result = sandboxConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Invalid ${path}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`
    )
  }
  return result.data
}
