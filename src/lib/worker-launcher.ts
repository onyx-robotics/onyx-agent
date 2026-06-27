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
import { fileURLToPath } from "node:url"

import { onyxStateDir } from "./outbox"
import { readConfig, type BuiltInWorkerAgent } from "./config"
import { gitCommonDir, gitDir } from "./git"
import { pathExists, runProcess } from "./process"
import type { WorkerRuntimeContext } from "./worker-context"

const ONYX_LAUNCHER_BYPASS = "ONYX_LAUNCHER_BYPASS"

export type WorkerAgentKind = BuiltInWorkerAgent | "custom"

export type WorkerInvocation = {
  agentKind: WorkerAgentKind
  command: string
  args: string[]
  redactedArgs: string[]
  stdin?: string
  preflightArgs?: string[]
  addedWritableRoots: string[]
  workerModel?: string | null
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

export type WorkerCliWrapper = {
  binDir: string
  workerPath: string
  mode: "dev" | "release" | "source"
  target: string
}

export type WorkerRuntimePaths = {
  dir: string
  contextPath: string
  homeDir: string
  binDir: string
  tempDir: string
}

export type WorkerFinalizationStatus =
  | "none"
  | "already_logged"
  | "measured_and_logged"
  | "salvaged_unmeasured"
  | "salvaged_unmeasured_budget_exhausted"
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
  warnings?: string[]
}

export type WorkerLaunchManifest = {
  schemaVersion: 1
  agentKind: WorkerAgentKind
  workerModel: string | null
  command: string
  args: string[]
  onyxWorkerPath: string | null
  workerContextPath: string | null
  addedWritableRoots: string[]
  cwd: string
  promptPath: string
  logPath: string
  activityLogPath: string
  activityJsonlPath: string
  latestStatePath: string
  manifestPath: string
  sessionId: string
  hypothesisId: string
  hypothesisName: string
  workerId: string
  workerName: string
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
  warnings?: string[]
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

function compactPreflightOutput(value: string, limit = 2048) {
  const compacted = value.replace(/\s+/g, " ").trim()
  return compacted.length > limit
    ? `${compacted.slice(0, Math.max(0, limit - 3))}...`
    : compacted
}

function opencodeModelIds(output: string) {
  return [
    ...new Set(
      output
        .match(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/@+-]+\b/g)
        ?.filter((value) => !value.startsWith("http")) ?? []
    ),
  ].sort()
}

function modelSimilarity(left: string, right: string) {
  const leftParts = new Set(left.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const rightParts = new Set(
    right.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  )
  let overlap = 0
  for (const part of leftParts) {
    if (rightParts.has(part)) overlap += 1
  }
  return overlap
}

function closestModelIds(requested: string, candidates: string[]) {
  return candidates
    .map((candidate) => ({
      candidate,
      score: modelSimilarity(requested, candidate),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((item) => item.candidate)
}

async function sourceCheckoutOnyxWorkerBin() {
  const binPath = fileURLToPath(
    new URL("../../bin/onyx-worker.js", import.meta.url)
  )
  return (await pathExists(binPath)) ? binPath : null
}

export async function workerGitWritableRoots(worktree: string) {
  return unique([await gitDir(worktree), await gitCommonDir(worktree)])
}

export async function workerRuntimePaths({
  root,
  sessionId,
  workerId,
}: {
  root: string
  sessionId: string
  workerId: string
}): Promise<WorkerRuntimePaths> {
  const dir = join(
    await onyxStateDir(root),
    "worker-runtime",
    safeSegment(sessionId),
    safeSegment(workerId)
  )
  return {
    dir,
    contextPath: join(dir, "context.json"),
    homeDir: join(dir, "home"),
    binDir: join(dir, "bin"),
    tempDir: join(dir, "tmp"),
  }
}

export async function writeWorkerRuntimeContext({
  paths,
  context,
}: {
  paths: WorkerRuntimePaths
  context: WorkerRuntimeContext
}) {
  await Promise.all([
    mkdir(paths.dir, { recursive: true }),
    mkdir(paths.homeDir, { recursive: true }),
    mkdir(paths.tempDir, { recursive: true }),
  ])
  await writeFile(paths.contextPath, `${JSON.stringify(context, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
}

export async function writeWorkerCliWrapper({
  paths,
}: {
  paths: WorkerRuntimePaths
}): Promise<WorkerCliWrapper> {
  await mkdir(paths.binDir, { recursive: true })
  const workerPath = join(paths.binDir, "onyx-worker")
  const config = await readConfig()

  let mode: WorkerCliWrapper["mode"] = "release"
  let target = "onyx-worker"
  let script: string
  if (config.developer.mode === "dev" && config.developer.checkout) {
    const checkout = config.developer.checkout
    if (!(await pathExists(checkout.workerBinPath))) {
      throw new Error(
        `Onyx developer mode is active, but the linked worker CLI entrypoint is missing: ${checkout.workerBinPath}. Run \`onyx developer link <path>\` again or switch back with \`onyx developer use release\`.`
      )
    }
    mode = "dev"
    target = checkout.workerBinPath
    script = [
      "#!/usr/bin/env sh",
      "set -eu",
      `exec env ${ONYX_LAUNCHER_BYPASS}=1 bun ${shellQuote(target)} "$@"`,
      "",
    ].join("\n")
  } else {
    const sourceBinPath = await sourceCheckoutOnyxWorkerBin()
    if (sourceBinPath) {
      mode = "source"
      target = sourceBinPath
      script = [
        "#!/usr/bin/env sh",
        "set -eu",
        `exec env ${ONYX_LAUNCHER_BYPASS}=1 bun ${shellQuote(target)} "$@"`,
        "",
      ].join("\n")
    } else {
      const resolved = await runProcess("sh", ["-lc", "command -v onyx-worker"], {
        timeoutMs: 5000,
      })
      const resolvedPath = resolved.stdout.trim().split("\n")[0]
      if (resolved.code === 0 && resolvedPath) {
        target = resolvedPath
        script = [
          "#!/usr/bin/env sh",
          "set -eu",
          `exec env ${ONYX_LAUNCHER_BYPASS}=1 ${shellQuote(target)} "$@"`,
          "",
        ].join("\n")
      } else {
        throw new Error(
          "Unable to resolve the Onyx worker CLI on PATH for worker launch. Install `onyx-worker`, run from an Onyx agent source checkout, or use developer mode with `onyx developer link <path>`."
        )
      }
    }
  }

  await writeFile(workerPath, script, "utf8")
  await chmod(workerPath, 0o755)
  return { binDir: paths.binDir, workerPath, mode, target }
}

export function workerRuntimeEnvironment({
  baseEnv,
  wrapper,
  paths,
}: {
  baseEnv: NodeJS.ProcessEnv
  wrapper: WorkerCliWrapper
  paths: WorkerRuntimePaths
}) {
  return {
    ...baseEnv,
    PATH: [wrapper.binDir, baseEnv.PATH ?? ""].filter(Boolean).join(delimiter),
    ONYX_WORKER_CONTEXT: paths.contextPath,
    ONYX_HOME: paths.homeDir,
    TMPDIR: paths.tempDir,
    TMP: paths.tempDir,
    TEMP: paths.tempDir,
  }
}

export function buildWorkerInvocation({
  agentKind,
  workerCommand,
  worktree,
  prompt,
  addedWritableRoots = [],
  workerModel = null,
  workerTitle,
}: {
  agentKind: string
  workerCommand?: string
  worktree: string
  prompt: string
  addedWritableRoots?: string[]
  workerModel?: string | null
  workerTitle?: string
}): WorkerInvocation {
  if (workerCommand) {
    return {
      agentKind: "custom",
      command: "sh",
      args: ["-lc", workerCommand],
      redactedArgs: ["-lc", "<worker-command>"],
      addedWritableRoots: [],
      workerModel: null,
    }
  }

  if (agentKind === "codex") {
    const modelArgs = workerModel ? ["--model", workerModel] : []
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
      ...modelArgs,
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
      workerModel,
    }
  }

  if (agentKind === "claude") {
    const modelArgs = workerModel ? ["--model", workerModel] : []
    const writableArgs = unique([worktree, ...addedWritableRoots]).flatMap(
      (root) => ["--add-dir", root]
    )
    const args = [
      "--verbose",
      "--print",
      ...modelArgs,
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
      workerModel,
    }
  }

  if (agentKind === "opencode") {
    const modelArgs = workerModel ? ["--model", workerModel] : []
    const args = [
      "run",
      "--dir",
      worktree,
      "--format",
      "json",
      "--title",
      workerTitle ?? "onyx-worker",
      ...modelArgs,
      "--dangerously-skip-permissions",
    ]
    return {
      agentKind,
      command: "opencode",
      args,
      redactedArgs: args,
      preflightArgs: ["run", "--help"],
      stdin: prompt,
      addedWritableRoots: [],
      workerModel,
    }
  }

  throw new Error(
    `Unknown --agent ${agentKind}. Use codex, claude, opencode, or pass --worker-command.`
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
        : invocation.agentKind === "claude"
          ? "Install or authenticate Claude Code before using `--agent claude`."
          : "Install or authenticate OpenCode before using `--agent opencode`."
    throw new Error(
      `${invocation.command} preflight failed. ${install} ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  const checks: WorkerPreflightCheck[] = []

  if (invocation.agentKind === "opencode" && invocation.workerModel) {
    const modelsResult = await runProcess(invocation.command, ["models"], {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 10_000,
    })
    const output = [modelsResult.stdout.trim(), modelsResult.stderr.trim()]
      .filter(Boolean)
      .join("\n")
    const unavailable =
      modelsResult.timedOut ||
      modelsResult.code !== 0 ||
      /Unknown command|not found/i.test(output)
    if (!unavailable) {
      const models = opencodeModelIds(output)
      if (models.length > 0 && !models.includes(invocation.workerModel)) {
        const suggestions = closestModelIds(invocation.workerModel, models)
        const suggestionText =
          suggestions.length > 0
            ? ` Nearby model id(s): ${suggestions.join(", ")}.`
            : ""
        throw new Error(
          `OpenCode model "${invocation.workerModel}" was not found in \`opencode models\`.${suggestionText} Run \`opencode models\` to choose an exact provider/model id.`
        )
      }
      checks.push({
        name: "opencode model",
        status: "passed",
        output: null,
      })
    }
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
      output: passed ? null : output ? compactPreflightOutput(output) : null,
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

  for (const probe of [
    {
      name: "onyx-worker exp run help",
      args: ["exp", "run", "--help"],
    },
    {
      name: "onyx-worker research brief help",
      args: ["research", "brief", "--help"],
    },
    {
      name: "onyx-worker research should-stop help",
      args: ["research", "should-stop", "--help"],
    },
    {
      name: "onyx-worker knowledge add help",
      args: ["knowledge", "add", "--help"],
    },
    {
      name: "onyx-worker tools run help",
      args: ["tools", "run", "--help"],
    },
    {
      name: "onyx-worker summary upsert help",
      args: ["summary", "upsert", "--help"],
    },
    {
      name: "onyx-worker sync status help",
      args: ["sync", "status", "--help"],
    },
  ]) {
    await runCheck(probe.name, "onyx-worker", probe.args)
  }
  checks.push({
    name: "onyx-worker capability surface",
    status: "passed",
    output: null,
  })

  const versionResult = await runCheck("onyx-worker version", "onyx-worker", [
    "--version",
  ])
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
      "onyx-worker should-stop",
      "onyx-worker",
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
    activityJsonlPath: join(dir, `${base}.activity.jsonl`),
    latestStatePath: join(dir, `${base}.latest.json`),
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
