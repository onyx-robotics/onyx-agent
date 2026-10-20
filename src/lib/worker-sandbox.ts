import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ResearchSetupFile } from "./contract"
import { gitCommonDir, gitDir } from "./git"
import type { SandboxConfig } from "./sandbox-config"
import type { SimConfig } from "./sim-config"
import {
  probeSandbox,
  resolveSandboxPolicy,
  sandboxCommand,
  type ResolvedSandboxPolicy,
} from "./sandbox"
import { defaultProtectedToolPaths, ONYX_WORKER_SANDBOX_POLICY } from "./tools"
import {
  ONYX_WORKER_BROKER_SOCKET,
  ONYX_WORKER_BROKER_TOKEN,
  startWorkerBroker,
  type WorkerBroker,
} from "./worker-broker"
import {
  workerClientSandboxPaths,
  type SandboxWrapper,
  type WorkerCliWrapper,
  type WorkerRuntimePaths,
} from "./worker-launcher"

export type WorkerSandbox = {
  backend: "bubblewrap" | "seatbelt"
  agentPolicy: ResolvedSandboxPolicy
  /** Environment for the sandboxed provider: the broker replaces direct
   * access to the worker context and `.git/onyx`. */
  agentEnv: NodeJS.ProcessEnv
  wrap: SandboxWrapper
  /** Stops the broker and any worker CLI commands it is still running. */
  close(): Promise<void>
}

export function sandboxBackend(platform: NodeJS.Platform = process.platform) {
  return platform === "darwin" ? ("seatbelt" as const) : ("bubblewrap" as const)
}

function projectProtectedPaths(
  setup: ResearchSetupFile,
  sim: SimConfig | null = null
) {
  return [
    ...defaultProtectedToolPaths(""),
    ...setup.scope.protected.map((path) => path.replace(/\/+$/, "")),
    ...(sim?.paths ?? []),
  ]
}

/** With a hardware queue, only the supervisor's hardware jobs get devices. */
function withoutDevices(config: SandboxConfig): SandboxConfig {
  return { ...config, devices: [] }
}

/**
 * Prepares confinement for one supervised worker after its worktree and
 * runtime context exist. A failed probe is fatal: the worker never runs
 * unconfined when the policy says enforce.
 */
export async function prepareWorkerSandbox({
  config,
  setup,
  worktree,
  projectRoot,
  runtimePaths,
  wrapper,
  workerEnv,
  agentKind,
  providerExecutable,
  sim = null,
}: {
  config: SandboxConfig
  setup: ResearchSetupFile
  /** Set when the session runs a hardware queue: device access is removed
   * from the worker and its tools, and simulator sources are read-only. */
  sim?: SimConfig | null
  worktree: string
  projectRoot: string
  runtimePaths: WorkerRuntimePaths
  wrapper: WorkerCliWrapper
  workerEnv: NodeJS.ProcessEnv
  agentKind: string
  providerExecutable: string | null
}): Promise<WorkerSandbox> {
  const [workerGitDir, commonDir] = await Promise.all([
    gitDir(worktree),
    gitCommonDir(worktree),
  ])
  const toolPolicyPath = join(runtimePaths.dir, "sandbox-tool-policy.json")
  const broker: WorkerBroker = await startWorkerBroker({
    workerCliPath: wrapper.workerPath,
    allowedRoot: worktree,
    env: { ...workerEnv, [ONYX_WORKER_SANDBOX_POLICY]: toolPolicyPath },
  })
  try {
    const shared = {
      config: sim ? withoutDevices(config) : config,
      env: workerEnv,
      worktreeRoot: worktree,
      projectRoot,
      gitDir: workerGitDir,
      gitCommonDir: commonDir,
      tempDir: runtimePaths.tempDir,
      protectedPaths: projectProtectedPaths(setup, sim),
      editablePaths: setup.scope.editable,
    }
    const agentPolicy = await resolveSandboxPolicy({
      ...shared,
      role: "agent",
      binDir: wrapper.binDir,
      brokerSocket: broker.socketPath,
      agentKind,
      providerExecutable,
      workerClientPaths: await workerClientSandboxPaths(wrapper, workerEnv),
    })
    const toolPolicy = await resolveSandboxPolicy({ ...shared, role: "tool" })
    await writeFile(toolPolicyPath, `${JSON.stringify(toolPolicy, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    const agentEnv = {
      ...workerEnv,
      [ONYX_WORKER_BROKER_SOCKET]: broker.socketPath,
      [ONYX_WORKER_BROKER_TOKEN]: broker.token,
    }
    const wrap: SandboxWrapper = (invocation) =>
      sandboxCommand(agentPolicy, invocation, agentEnv)

    await probeSandbox(agentPolicy, projectRoot, agentEnv)

    return {
      backend: sandboxBackend(agentPolicy.platform),
      agentPolicy,
      agentEnv,
      wrap,
      close: () => broker.close(),
    }
  } catch (error) {
    await broker.close()
    throw error
  }
}

/**
 * Session-level gate before any worker launches: the backend must work, and
 * a built-in provider must answer its model probe from inside the sandbox
 * (in an empty scratch directory, so repository instructions are not read).
 */
export async function preflightSessionSandbox({
  config,
  env,
  agentKind,
  providerExecutable,
  runProviderProbe,
}: {
  config: SandboxConfig
  env: NodeJS.ProcessEnv
  agentKind: string
  providerExecutable: string | null
  runProviderProbe?: (options: {
    cwd: string
    sandbox: SandboxWrapper
  }) => Promise<unknown>
}) {
  const scratch = await mkdtemp(join(tmpdir(), "onyx-sandbox-probe-"))
  try {
    const policy = await resolveSandboxPolicy({
      config,
      role: "agent",
      env,
      worktreeRoot: scratch,
      projectRoot: scratch,
      gitDir: scratch,
      gitCommonDir: scratch,
      tempDir: scratch,
      protectedPaths: [],
      editablePaths: [],
      agentKind,
      providerExecutable,
    })
    await probeSandbox(policy, scratch, env)
    await runProviderProbe?.({
      cwd: scratch,
      sandbox: (invocation) => sandboxCommand(policy, invocation, env),
    })
    return { backend: sandboxBackend(policy.platform), probe: "passed" as const }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Tool policy for one supervisor hardware job: the same confinement a
 * worker's tools get, rooted at the job's own worktree, and the only policy
 * that passes the configured devices through.
 */
export async function writeHardwareToolPolicy({
  config,
  setup,
  sim,
  worktree,
  projectRoot,
  tempDir,
  env,
  path,
}: {
  config: SandboxConfig
  setup: ResearchSetupFile
  sim: SimConfig | null
  worktree: string
  projectRoot: string
  tempDir: string
  env: NodeJS.ProcessEnv
  path: string
}) {
  const [jobGitDir, commonDir] = await Promise.all([
    gitDir(worktree),
    gitCommonDir(worktree),
  ])
  const policy = await resolveSandboxPolicy({
    config,
    env,
    role: "tool",
    worktreeRoot: worktree,
    projectRoot,
    gitDir: jobGitDir,
    gitCommonDir: commonDir,
    tempDir,
    protectedPaths: projectProtectedPaths(setup, sim),
    editablePaths: setup.scope.editable,
  })
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  return policy
}
