import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { delimiter } from "node:path"
import { dirname, join } from "node:path"

import { onyxStateDir } from "./outbox"
import { readConfig } from "./config"
import { gitCommonDir, gitDir } from "./git"
import { pathExists, runProcess } from "./process"

const ONYX_LAUNCHER_BYPASS = "ONYX_LAUNCHER_BYPASS"

export type BuiltInWorkerAgent = "codex" | "claude"
export type WorkerAgentKind = BuiltInWorkerAgent | "custom"

export type WorkerInvocation = {
  agentKind: WorkerAgentKind
  command: string
  args: string[]
  redactedArgs: string[]
  stdin?: string
  preflightArgs?: string[]
  addedWritableRoots: string[]
}

export type WorkerPreflightCheck = {
  name: string
  status: "passed" | "failed"
  output: string | null
}

export type WorkerPreflightResult = {
  version: string | null
  onyxVersion: string | null
  checks: WorkerPreflightCheck[]
}

export type WorkerOnyxShim = {
  binDir: string
  onyxPath: string
  mode: "dev" | "release"
  target: string
}

export type WorkerFinalizationStatus =
  | "none"
  | "already_logged"
  | "measured_and_logged"
  | "salvaged_unmeasured"
  | "failed"

export type WorkerFinalizationManifest = {
  attempted: boolean
  salvaged: boolean
  finalizationStatus: WorkerFinalizationStatus
  commitSha: string | null
  measurementBaseCommitSha: string | null
  unloggedCommitCount: number
  workerBranchPushStatus: "not_attempted" | "pushed" | "failed"
  rootDriftStatus: "not_checked" | "clean" | "dirty"
  error: string | null
}

export type WorkerLaunchManifest = {
  schemaVersion: 1
  agentKind: WorkerAgentKind
  command: string
  args: string[]
  onyxShimPath: string | null
  addedWritableRoots: string[]
  cwd: string
  promptPath: string
  logPath: string
  activityLogPath: string
  manifestPath: string
  sessionId: string
  hypothesisId: string
  hypothesisName: string
  workerId: string
  version: string | null
  startedAt: string
  lastOutputAt: string | null
  completedAt: string | null
  status: "starting" | "running" | "completed" | "failed" | "stopped"
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  startupTimedOut: boolean
  error: string | null
  preflight: WorkerPreflightResult | null
  finalization: WorkerFinalizationManifest | null
}

function safeSegment(value: string) {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "worker"
  )
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

export async function workerGitWritableRoots(worktree: string) {
  return unique([await gitDir(worktree), await gitCommonDir(worktree)])
}

export async function writeWorkerOnyxShim({
  root,
  sessionId,
}: {
  root: string
  sessionId: string
}): Promise<WorkerOnyxShim> {
  const dir = join(await onyxStateDir(root), "worker-bin", sessionId)
  await mkdir(dir, { recursive: true })
  const onyxPath = join(dir, "onyx")
  const config = await readConfig()

  let mode: WorkerOnyxShim["mode"] = "release"
  let target = "onyx"
  let script: string
  if (config.developer.mode === "dev" && config.developer.checkout) {
    const checkout = config.developer.checkout
    if (!(await pathExists(checkout.binPath))) {
      throw new Error(
        `Onyx developer mode is active, but the linked CLI entrypoint is missing: ${checkout.binPath}. Run \`onyx developer link <path>\` again or switch back with \`onyx developer use release\`.`
      )
    }
    mode = "dev"
    target = checkout.binPath
    script = [
      "#!/usr/bin/env sh",
      "set -eu",
      `exec env ${ONYX_LAUNCHER_BYPASS}=1 bun ${shellQuote(checkout.binPath)} "$@"`,
      "",
    ].join("\n")
  } else {
    const resolved = await runProcess("sh", ["-lc", "command -v onyx"], {
      timeoutMs: 5000,
    })
    if (resolved.code !== 0 || !resolved.stdout.trim()) {
      throw new Error(
        "Unable to resolve the Onyx CLI on PATH for worker launch. Install `onyx`, or use developer mode with `onyx developer link <path>`."
      )
    }
    target = resolved.stdout.trim().split("\n")[0]!
    script = [
      "#!/usr/bin/env sh",
      "set -eu",
      `exec env ${ONYX_LAUNCHER_BYPASS}=1 ${shellQuote(target)} "$@"`,
      "",
    ].join("\n")
  }

  await writeFile(onyxPath, script, "utf8")
  await chmod(onyxPath, 0o755)
  return { binDir: dir, onyxPath, mode, target }
}

export function workerEnvironment({
  baseEnv,
  shim,
}: {
  baseEnv: NodeJS.ProcessEnv
  shim: WorkerOnyxShim
}) {
  return {
    ...baseEnv,
    PATH: [shim.binDir, baseEnv.PATH ?? ""].filter(Boolean).join(delimiter),
  }
}

export function buildWorkerInvocation({
  agentKind,
  workerCommand,
  worktree,
  prompt,
  addedWritableRoots = [],
}: {
  agentKind: string
  workerCommand?: string
  worktree: string
  prompt: string
  addedWritableRoots?: string[]
}): WorkerInvocation {
  if (workerCommand) {
    return {
      agentKind: "custom",
      command: "sh",
      args: ["-lc", workerCommand],
      redactedArgs: ["-lc", "<worker-command>"],
      addedWritableRoots: [],
    }
  }

  if (agentKind === "codex") {
    const writableArgs = addedWritableRoots.flatMap((root) => [
      "--add-dir",
      root,
    ])
    const args = [
      "--search",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "exec",
      "--cd",
      worktree,
      ...writableArgs,
      "--json",
      "--color",
      "never",
      "--ephemeral",
      "-",
    ]
    return {
      agentKind,
      command: "codex",
      args,
      redactedArgs: args,
      preflightArgs: args.slice(0, -1).concat("--help"),
      stdin: prompt,
      addedWritableRoots,
    }
  }

  if (agentKind === "claude") {
    const writableArgs = unique([worktree, ...addedWritableRoots]).flatMap(
      (root) => ["--add-dir", root]
    )
    const args = [
      "--verbose",
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "auto",
      ...writableArgs,
      "--no-session-persistence",
    ]
    return {
      agentKind,
      command: "claude",
      args,
      redactedArgs: args,
      preflightArgs: args.concat("--help"),
      stdin: prompt,
      addedWritableRoots,
    }
  }

  throw new Error(
    `Unknown --agent ${agentKind}. Use codex, claude, or pass --worker-command.`
  )
}

export async function preflightWorkerInvocation(
  invocation: WorkerInvocation,
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    campaignName?: string
    sessionId?: string
  }
): Promise<WorkerPreflightResult> {
  if (invocation.agentKind === "custom") {
    return { version: null, onyxVersion: null, checks: [] }
  }

  let version: string | null = null
  try {
    const versionResult = await runProcess(invocation.command, ["--version"], {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 10_000,
    })
    if (versionResult.code !== 0 || versionResult.timedOut) {
      throw new Error(
        versionResult.timedOut
          ? "version check timed out"
          : versionResult.stderr.trim() ||
              versionResult.stdout.trim() ||
              "version check failed"
      )
    }
    version =
      [versionResult.stdout.trim(), versionResult.stderr.trim()]
        .filter(Boolean)
        .join("\n") || null
  } catch (error) {
    const install =
      invocation.agentKind === "codex"
        ? "Install or authenticate the Codex CLI before using `--agent codex`."
        : "Install or authenticate Claude Code before using `--agent claude`."
    throw new Error(
      `${invocation.command} preflight failed. ${install} ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  if (invocation.preflightArgs) {
    const result = await runProcess(
      invocation.command,
      invocation.preflightArgs,
      {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs ?? 10_000,
      }
    )
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        `${invocation.command} argument preflight failed: ${
          result.timedOut
            ? "timed out"
            : result.stderr.trim() || result.stdout.trim() || "no output"
        }`
      )
    }
  }

  const checks: WorkerPreflightCheck[] = []
  let onyxVersion: string | null = null
  const runCheck = async (
    name: string,
    command: string,
    args: string[],
    optionsOverride: { allowExitCodes?: number[] } = {}
  ) => {
    const result = await runProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 10_000,
    })
    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n")
    const allowed = optionsOverride.allowExitCodes ?? [0]
    const passed =
      !result.timedOut &&
      result.code !== null &&
      allowed.includes(result.code) &&
      !output.includes("Unknown command:")
    checks.push({
      name,
      status: passed ? "passed" : "failed",
      output: output || null,
    })
    if (!passed) {
      throw new Error(
        `Worker environment preflight failed (${name}): ${
          result.timedOut ? "timed out" : output || `exit ${result.code}`
        }`
      )
    }
    return result
  }

  await runCheck("onyx developer status", "onyx", [
    "developer",
    "status",
    "--json",
  ])
  await runCheck("onyx status", "onyx", ["status", "--json"])
  for (const probe of [
    {
      name: "onyx exp run help",
      args: ["exp", "run", "--help"],
    },
    {
      name: "onyx worker run help",
      args: ["worker", "run", "--help"],
    },
    {
      name: "onyx research should-stop help",
      args: ["research", "should-stop", "--help"],
    },
    {
      name: "onyx knowledge add help",
      args: ["knowledge", "add", "--help"],
    },
    {
      name: "onyx knowledge list help",
      args: ["knowledge", "list", "--help"],
    },
    {
      name: "onyx summary upsert help",
      args: ["summary", "upsert", "--help"],
    },
  ]) {
    await runCheck(probe.name, "onyx", probe.args)
  }
  checks.push({
    name: "onyx capability surface",
    status: "passed",
    output: null,
  })

  const versionResult = await runCheck("onyx version", "onyx", ["--version"])
  onyxVersion =
    [versionResult.stdout.trim(), versionResult.stderr.trim()]
      .filter(Boolean)
      .join("\n") || null

  await runCheck("git metadata write", "git", [
    "update-index",
    "-q",
    "--refresh",
  ])

  if (options.sessionId) {
    await runCheck(
      "onyx should-stop",
      "onyx",
      [
        "research",
        "should-stop",
        "--session",
        options.sessionId,
        "--iteration",
        "0",
        "--json",
      ],
      { allowExitCodes: [0] }
    )
  }

  if (options.campaignName) {
    await runCheck(
      "onyx evaluation tool",
      "onyx",
      ["tools", "run", "evaluation.run", "--timeout", "120"],
      { allowExitCodes: [0, 1] }
    )
  }

  return { version, onyxVersion, checks }
}

export async function workerLaunchPaths({
  root,
  sessionId,
  hypothesisId,
  hypothesisName,
  workerId,
}: {
  root: string
  sessionId: string
  hypothesisId: string
  hypothesisName: string
  workerId?: string
}) {
  const dir = join(await onyxStateDir(root), "worker-logs", sessionId)
  const base = [
    safeSegment(hypothesisName),
    safeSegment(hypothesisId).slice(0, 8),
    workerId ? safeSegment(workerId).slice(0, 12) : null,
  ]
    .filter(Boolean)
    .join("-")
  return {
    dir,
    logPath: join(dir, `${base}.log`),
    activityLogPath: join(dir, `${base}.activity.log`),
    manifestPath: join(dir, `${base}.manifest.json`),
  }
}

export async function writeWorkerLaunchManifest(
  manifest: WorkerLaunchManifest
) {
  await mkdir(dirname(manifest.manifestPath), { recursive: true })
  const tmp = `${manifest.manifestPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await rename(tmp, manifest.manifestPath)
}

export async function readWorkerLaunchManifests(
  root: string,
  sessionId: string
) {
  const dir = join(await onyxStateDir(root), "worker-logs", sessionId)
  if (!(await pathExists(dir))) return []
  const entries = await readdir(dir)
  const manifests: WorkerLaunchManifest[] = []
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".manifest.json"))
      .map(async (entry) => {
        try {
          const parsed: unknown = JSON.parse(
            await readFile(join(dir, entry), "utf8")
          )
          if (
            parsed &&
            typeof parsed === "object" &&
            "schemaVersion" in parsed &&
            parsed.schemaVersion === 1
          ) {
            manifests.push(parsed as WorkerLaunchManifest)
          }
        } catch {
          // Ignore stale or partially-written local manifest files.
        }
      })
  )
  return manifests
}
