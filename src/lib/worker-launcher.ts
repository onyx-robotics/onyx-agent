import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  rename,
  writeFile,
  realpath,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { delimiter } from "node:path"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { onyxStateDir } from "./runtime-state"
import { readConfig, type BuiltInWorkerAgent } from "./config"
import {
  ONYX_AGENT_PROTOCOL_VERSION,
  ONYX_WORKER_CONTEXT_SCHEMA_VERSION,
} from "./version"
import { gitCommonDir, gitDir } from "./git"
import { activityLinesForOutput, pathExists, runProcess } from "./process"
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

type WorkerInvocationOptions = {
  worktree: string
  /** Directory the provider process starts in — the project root inside the
   * worktree. Defaults to the worktree root when omitted. */
  launchDir?: string
  prompt: string
  addedWritableRoots: string[]
  workerModel: string | null
  workerTitle?: string
  providerExecutable?: string
}

export type ProviderFailureClass =
  | "auth"
  | "quota"
  | "rate_limit"
  | "overloaded"
  | "unavailable"
  | "model_unsupported"
  | "other"

/** One deterministic boundary for every built-in provider CLI. */
export interface ProviderAdapter {
  readonly kind: BuiltInWorkerAgent
  readonly executable: string
  buildInvocation(options: WorkerInvocationOptions): WorkerInvocation
  parseStructuredEvents(output: string): string[]
  classifyFailure(output: string): ProviderFailureClass
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

export async function resolveProviderExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env
) {
  if (command.includes("/")) return realpath(command)
  const result = await runProcess("which", [command], {
    env,
    timeoutMs: 5_000,
  })
  const resolved = result.stdout.trim().split("\n")[0]
  if (result.code !== 0 || result.timedOut || !resolved) {
    throw new Error(`Provider executable ${command} was not found on PATH.`)
  }
  return realpath(resolved)
}

export async function preflightProviderModel({
  invocation,
  cwd,
  env,
  timeoutMs = 90_000,
}: {
  invocation: WorkerInvocation
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}) {
  if (invocation.agentKind === "custom") {
    return { skipped: true, version: null, marker: null }
  }
  const marker = `ONYX_PREFLIGHT_READY_${randomUUID()}`
  const probe = buildWorkerInvocation({
    agentKind: invocation.agentKind,
    worktree: cwd,
    prompt: `This is a capability probe. Do not use tools. Respond with exactly: ${marker}`,
    workerModel: invocation.workerModel ?? null,
    providerExecutable: invocation.command,
  })
  const [versionResult, probeResult] = await Promise.all([
    runProcess(invocation.command, ["--version"], {
      cwd,
      env,
      timeoutMs: 10_000,
    }),
    runProcess(probe.command, probe.args, {
      cwd,
      env,
      stdin: probe.stdin,
      timeoutMs,
    }),
  ])
  const output = `${probeResult.stdout}\n${probeResult.stderr}`
  if (
    versionResult.code !== 0 ||
    versionResult.timedOut ||
    probeResult.code !== 0 ||
    probeResult.timedOut ||
    !providerAdapter(invocation.agentKind)
      .parseStructuredEvents(probeResult.stdout)
      .some((line) => line.includes(marker))
  ) {
    throw new Error(
      `Provider/model preflight failed before session creation: ${compactPreflightOutput(output || versionResult.stderr || versionResult.stdout)}`
    )
  }
  return {
    skipped: false,
    version: `${versionResult.stdout}\n${versionResult.stderr}`.trim() || null,
    marker,
  }
}

export async function preflightWorkerProtocol({ root }: { root: string }) {
  const preflightId = `preflight-${randomUUID()}`
  const paths = await workerRuntimePaths({
    root,
    sessionId: "preflight",
    workerId: preflightId,
  })
  try {
    const wrapper = await writeWorkerCliWrapper({ paths })
    const result = await runProcess(
      wrapper.workerPath,
      ["diagnostics", "handshake", "--json"],
      { cwd: root, timeoutMs: 10_000 }
    )
    if (result.code !== 0 || result.timedOut) {
      throw new Error(result.stderr || result.stdout || "handshake failed")
    }
    const payload = JSON.parse(result.stdout) as {
      protocolVersion?: number
      workerContextSchemas?: number[]
    }
    if (
      payload.protocolVersion !== ONYX_AGENT_PROTOCOL_VERSION ||
      !payload.workerContextSchemas?.includes(
        ONYX_WORKER_CONTEXT_SCHEMA_VERSION
      )
    ) {
      throw new Error(
        `expected protocol ${ONYX_AGENT_PROTOCOL_VERSION}/context ${ONYX_WORKER_CONTEXT_SCHEMA_VERSION}, received ${compactPreflightOutput(result.stdout)}`
      )
    }
    return { ...payload, workerPath: wrapper.workerPath, mode: wrapper.mode }
  } finally {
    await rm(paths.dir, { recursive: true, force: true }).catch(() => {})
  }
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

export type WorkerAttemptDeliveryStatus =
  | "none"
  | "delivered"
  | "duplicate"
  | "failed"
  | "ambiguous_discarded"

export type WorkerTerminalReasonCode =
  | "completed"
  | "provider_failure"
  | "startup_failure"
  | "timeout"
  | "stopped"
  | "worker_protocol_violation"
  | "terminal_attempt_delivery_failed"
  | "cleanup_failure"

export type WorkerTeardownManifest = {
  attemptDelivery: WorkerAttemptDeliveryStatus
  runRef: string | null
  resultCommitSha: string | null
  resultRefPushStatus: "not_attempted" | "pushed" | "failed"
  resultRefPushError: string | null
  headCommitSha: string | null
  commitsAhead: number
  dirty: boolean
  changedPaths: string[]
  diffStat: string | null
  worktreeCleanup: "pending" | "removed" | "failed"
  providerExitCode: number | null
  providerSignal: string | null
  timedOut: boolean
  startupTimedOut: boolean
  phase: "completed" | "failed" | "stopped"
  providerError: string | null
  reasonCode: WorkerTerminalReasonCode
  error: string | null
  warnings?: string[]
}

export type WorkerLaunchManifest = {
  schemaVersion: 2
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
  startingCommitSha: string
  hypothesisId: string
  hypothesisName: string
  workerId: string
  workerName: string
  supervisorRunId?: string | null
  pid?: number | null
  processStartedAt?: string | null
  commandIdentity?: string | null
  /** Stable 1-based supervisor capacity slot; null on manifests written
   * before slots existed or outside a supervised run. */
  slotIndex?: number | null
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
  teardown: WorkerTeardownManifest | null
}

/** Smallest 1-based slot index not currently in use. */
export function lowestFreeSlot(used: Iterable<number>) {
  const taken = new Set(used)
  let slot = 1
  while (taken.has(slot)) slot += 1
  return slot
}

/** True once the launched worker process has terminally exited. */
export function manifestIsTerminal(manifest: {
  status: WorkerLaunchManifest["status"]
  completedAt: string | null
}) {
  return (
    manifest.completedAt !== null ||
    manifest.status === "completed" ||
    manifest.status === "failed" ||
    manifest.status === "stopped"
  )
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
  const leftParts = new Set(
    left
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  )
  const rightParts = new Set(
    right
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
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
    mkdir(paths.dir, { recursive: true, mode: 0o700 }),
    mkdir(paths.homeDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.tempDir, { recursive: true, mode: 0o700 }),
  ])
  await Promise.all([
    chmod(paths.dir, 0o700),
    chmod(paths.homeDir, 0o700),
    chmod(paths.tempDir, 0o700),
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
      const resolved = await runProcess(
        "sh",
        ["-lc", "command -v onyx-worker"],
        {
          timeoutMs: 5000,
        }
      )
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

const PROVIDER_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const

export function providerRuntimeEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env
) {
  return Object.fromEntries(
    PROVIDER_ENV_ALLOWLIST.flatMap((name) =>
      baseEnv[name] === undefined ? [] : [[name, baseEnv[name]]]
    )
  )
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
    ...providerRuntimeEnvironment(baseEnv),
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
  launchDir,
  prompt,
  addedWritableRoots = [],
  workerModel = null,
  workerTitle,
  providerExecutable,
}: {
  agentKind: string
  workerCommand?: string
  worktree: string
  launchDir?: string
  prompt: string
  addedWritableRoots?: string[]
  workerModel?: string | null
  workerTitle?: string
  providerExecutable?: string
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

  return providerAdapter(agentKind).buildInvocation({
    worktree,
    launchDir,
    prompt,
    addedWritableRoots,
    workerModel,
    workerTitle,
    providerExecutable,
  })
}

export function classifyProviderFailure(output: string): ProviderFailureClass {
  if (/unsupported model|model .*not found|unknown model/i.test(output)) {
    return "model_unsupported"
  }
  if (
    /authentication|unauthorized|invalid api key|login required|not logged in|\b401\b|\b403\b/i.test(
      output
    )
  ) {
    return "auth"
  }
  if (
    /session limit|usage limit|out[_ -]?of[_ -]?credits|credit balance|insufficient credits|overage|spending limit|billing limit|quota exceeded/i.test(
      output
    )
  ) {
    return "quota"
  }
  if (/rate limit|too many requests|\b429\b|throttl/i.test(output)) {
    return "rate_limit"
  }
  if (/overloaded|capacity|server busy|\b529\b/i.test(output)) {
    return "overloaded"
  }
  if (/service unavailable|upstream|gateway|\b50[0234]\b/i.test(output)) {
    return "unavailable"
  }
  return "other"
}

function structuredActivity(output: string) {
  return activityLinesForOutput("stdout", output)
}

const providerAdapters: Record<BuiltInWorkerAgent, ProviderAdapter> = {
  codex: {
    kind: "codex",
    executable: "codex",
    parseStructuredEvents: structuredActivity,
    classifyFailure: classifyProviderFailure,
    buildInvocation({
      worktree,
      launchDir,
      prompt,
      addedWritableRoots,
      workerModel,
      providerExecutable,
    }) {
      const modelArgs = workerModel ? ["--model", workerModel] : []
      // The workspace-write sandbox scopes writes to the --cd directory, so
      // the worktree root must stay writable when launching from a project
      // subdirectory.
      const writableArgs = unique([worktree, ...addedWritableRoots]).flatMap(
        (root) => ["--add-dir", root]
      )
      const args = [
        "--search",
        "--ask-for-approval",
        "never",
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "--config",
        "sandbox_workspace_write.network_access=true",
        "--sandbox",
        "workspace-write",
        ...modelArgs,
        "--cd",
        launchDir ?? worktree,
        ...writableArgs,
        "--json",
        "--color",
        "never",
        "--ephemeral",
        "-",
      ]
      return {
        agentKind: "codex",
        command: providerExecutable ?? "codex",
        args,
        redactedArgs: args,
        preflightArgs: args.slice(0, -1).concat("--help"),
        stdin: prompt,
        addedWritableRoots,
        workerModel,
      }
    },
  },
  claude: {
    kind: "claude",
    executable: "claude",
    parseStructuredEvents: structuredActivity,
    classifyFailure: classifyProviderFailure,
    buildInvocation({
      worktree,
      prompt,
      addedWritableRoots,
      workerModel,
      providerExecutable,
    }) {
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
        agentKind: "claude",
        command: providerExecutable ?? "claude",
        args,
        redactedArgs: args,
        preflightArgs: args.concat("--help"),
        stdin: prompt,
        addedWritableRoots,
        workerModel,
      }
    },
  },
  opencode: {
    kind: "opencode",
    executable: "opencode",
    parseStructuredEvents: structuredActivity,
    classifyFailure: classifyProviderFailure,
    buildInvocation({
      worktree,
      launchDir,
      prompt,
      workerModel,
      workerTitle,
      providerExecutable,
    }) {
      const modelArgs = workerModel ? ["--model", workerModel] : []
      const args = [
        "run",
        "--pure",
        "--dir",
        launchDir ?? worktree,
        "--format",
        "json",
        "--title",
        workerTitle ?? "onyx-worker",
        ...modelArgs,
        "--print-logs",
        "--log-level",
        "ERROR",
        "--dangerously-skip-permissions",
      ]
      return {
        agentKind: "opencode",
        command: providerExecutable ?? "opencode",
        args,
        redactedArgs: args,
        preflightArgs: ["run", "--help"],
        stdin: prompt,
        addedWritableRoots: [],
        workerModel,
      }
    },
  },
}

export function providerAdapter(agentKind: string): ProviderAdapter {
  if (
    agentKind === "codex" ||
    agentKind === "claude" ||
    agentKind === "opencode"
  ) {
    return providerAdapters[agentKind]
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
    assignmentId?: string
    workerId?: string
    onyxWorkerPath: string
  }
): Promise<WorkerPreflightResult> {
  let version: string | null = null
  if (invocation.agentKind !== "custom") {
    try {
      const versionResult = await runProcess(
        invocation.command,
        ["--version"],
        {
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeoutMs ?? 10_000,
        }
      )
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

  // Workers invoke bare `onyx-worker` through PATH (the wrapper bin dir is
  // prepended by workerRuntimeEnvironment, and any modern onyx-worker
  // entrypoint re-execs the pinned wrapper inside a worker runtime). Verify
  // the effective binary through a login shell, since provider shells may
  // source profile files that reorder PATH in front of the wrapper.
  const bareResolution = await runProcess(
    "sh",
    ["-lc", "onyx-worker diagnostics handshake --json"],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 10_000,
    }
  )
  let barePayload: Record<string, unknown> | null = null
  try {
    barePayload = JSON.parse(bareResolution.stdout) as Record<string, unknown>
  } catch {
    barePayload = null
  }
  const bareResolutionOk =
    bareResolution.code === 0 &&
    !bareResolution.timedOut &&
    barePayload?.protocolVersion === ONYX_AGENT_PROTOCOL_VERSION &&
    Array.isArray(barePayload.workerContextSchemas) &&
    barePayload.workerContextSchemas.includes(
      ONYX_WORKER_CONTEXT_SCHEMA_VERSION
    )
  checks.push({
    name: "onyx-worker PATH resolution",
    status: bareResolutionOk ? "passed" : "failed",
    output: bareResolutionOk
      ? null
      : compactPreflightOutput(
          [bareResolution.stdout.trim(), bareResolution.stderr.trim()]
            .filter(Boolean)
            .join("\n")
        ) || null,
  })
  if (!bareResolutionOk) {
    throw new Error(
      `Worker environment preflight failed (onyx-worker PATH resolution): bare \`onyx-worker\` in a login shell did not answer the protocol ${ONYX_AGENT_PROTOCOL_VERSION}/context ${ONYX_WORKER_CONTEXT_SCHEMA_VERSION} handshake. A shell profile is likely resolving an outdated onyx-worker install ahead of the supervised wrapper (${options.onyxWorkerPath}); upgrade or remove that install.`
    )
  }

  const handshake = await runCheck(
    "onyx-worker protocol handshake",
    options.onyxWorkerPath,
    ["diagnostics", "handshake", "--json"]
  )
  let handshakePayload: Record<string, unknown>
  try {
    handshakePayload = JSON.parse(handshake.stdout) as Record<string, unknown>
  } catch {
    throw new Error("Worker protocol handshake did not return JSON")
  }
  if (
    handshakePayload.protocolVersion !== ONYX_AGENT_PROTOCOL_VERSION ||
    !Array.isArray(handshakePayload.workerContextSchemas) ||
    !handshakePayload.workerContextSchemas.includes(
      ONYX_WORKER_CONTEXT_SCHEMA_VERSION
    )
  ) {
    throw new Error(
      `Worker protocol mismatch: expected protocol ${ONYX_AGENT_PROTOCOL_VERSION}/context ${ONYX_WORKER_CONTEXT_SCHEMA_VERSION}, received ${compactPreflightOutput(handshake.stdout)}`
    )
  }
  checks.push({
    name: "onyx-worker capability surface",
    status: "passed",
    output: null,
  })

  const versionResult = await runCheck(
    "onyx-worker version",
    options.onyxWorkerPath,
    ["--version", "--json"]
  )
  onyxVersion =
    [versionResult.stdout.trim(), versionResult.stderr.trim()]
      .filter(Boolean)
      .join("\n") || null

  const contextResult = await runCheck(
    "onyx-worker real context",
    options.onyxWorkerPath,
    ["research", "session-state-brief", "--json"]
  )
  try {
    const context = JSON.parse(contextResult.stdout) as {
      schemaVersion?: number
      worker?: {
        id?: string
        sessionId?: string
        assignment?: { id?: string }
      }
    }
    if (
      context.schemaVersion !== 1 ||
      (options.workerId && context.worker?.id !== options.workerId) ||
      (options.sessionId && context.worker?.sessionId !== options.sessionId) ||
      (options.assignmentId &&
        context.worker?.assignment?.id !== options.assignmentId)
    ) {
      throw new Error("identity mismatch")
    }
  } catch (error) {
    throw new Error(
      `Worker real-context handshake failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  await runCheck("git metadata write", "git", [
    "update-index",
    "-q",
    "--refresh",
  ])

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
            parsed.schemaVersion === 2 &&
            "startingCommitSha" in parsed &&
            typeof parsed.startingCommitSha === "string" &&
            parsed.startingCommitSha.length > 0
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
