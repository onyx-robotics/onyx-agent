import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { onyxStateDir } from "./outbox"
import { pathExists, runProcess } from "./process"

export type BuiltInWorkerAgent = "codex" | "claude"
export type WorkerAgentKind = BuiltInWorkerAgent | "custom"

export type WorkerInvocation = {
  agentKind: WorkerAgentKind
  command: string
  args: string[]
  redactedArgs: string[]
  stdin?: string
  preflightArgs?: string[]
}

export type WorkerLaunchManifest = {
  schemaVersion: 1
  agentKind: WorkerAgentKind
  command: string
  args: string[]
  cwd: string
  promptPath: string
  logPath: string
  manifestPath: string
  sessionId: string
  laneId: string
  laneName: string
  workerId: string
  version: string | null
  startedAt: string
  lastOutputAt: string | null
  completedAt: string | null
  status: "starting" | "running" | "completed" | "failed"
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  startupTimedOut: boolean
  error: string | null
}

function safeSegment(value: string) {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "worker"
  )
}

export function buildWorkerInvocation({
  agentKind,
  workerCommand,
  worktree,
  prompt,
}: {
  agentKind: string
  workerCommand?: string
  worktree: string
  prompt: string
}): WorkerInvocation {
  if (workerCommand) {
    return {
      agentKind: "custom",
      command: "sh",
      args: ["-lc", workerCommand],
      redactedArgs: ["-lc", "<worker-command>"],
    }
  }

  if (agentKind === "codex") {
    const args = [
      "--search",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "exec",
      "--cd",
      worktree,
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
    }
  }

  if (agentKind === "claude") {
    const args = [
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "auto",
      "--add-dir",
      worktree,
      "--no-session-persistence",
    ]
    return {
      agentKind,
      command: "claude",
      args,
      redactedArgs: args,
      preflightArgs: args.concat("--help"),
      stdin: prompt,
    }
  }

  throw new Error(
    `Unknown --agent ${agentKind}. Use codex, claude, or pass --worker-command.`
  )
}

export async function preflightWorkerInvocation(
  invocation: WorkerInvocation,
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) {
  if (invocation.agentKind === "custom") {
    return { version: null }
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
    const result = await runProcess(invocation.command, invocation.preflightArgs, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 10_000,
    })
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

  return { version }
}

export async function workerLaunchPaths({
  root,
  sessionId,
  laneId,
  laneName,
}: {
  root: string
  sessionId: string
  laneId: string
  laneName: string
}) {
  const dir = join(await onyxStateDir(root), "worker-logs", sessionId)
  const base = `${safeSegment(laneName)}-${safeSegment(laneId).slice(0, 8)}`
  return {
    dir,
    logPath: join(dir, `${base}.log`),
    manifestPath: join(dir, `${base}.manifest.json`),
  }
}

export async function writeWorkerLaunchManifest(
  manifest: WorkerLaunchManifest
) {
  await writeFile(
    manifest.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  )
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
