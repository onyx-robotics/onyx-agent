import { spawn } from "node:child_process"
import { access, constants } from "node:fs/promises"

import type { DeveloperCheckout } from "./config"

import { validateDeveloperCheckout } from "../commands/developer"
import { readConfig } from "./config"
import { parseWorkerRuntimeContext } from "./worker-context"

export const ONYX_LAUNCHER_BYPASS = "ONYX_LAUNCHER_BYPASS"
const ONYX_WORKER_CLI_REDIRECTED = "ONYX_WORKER_CLI_REDIRECTED"

/**
 * Inside a supervised worker runtime, every `onyx-worker` entrypoint defers to
 * the supervisor-pinned wrapper recorded in the runtime context. This keeps
 * bare `onyx-worker` calls correct even when a login shell reorders PATH in
 * front of the per-worker wrapper bin directory (e.g. a globally installed
 * release binary shadowing a developer-mode checkout).
 *
 * This resolution is fail-closed: with ONYX_WORKER_CONTEXT set, an unreadable
 * or invalid context and a missing or non-executable wrapper are hard errors —
 * a supervised process must never fall through to developer configuration or
 * an unpinned CLI. Returns null only when no worker context is present.
 */
async function pinnedWorkerCliPath(env: NodeJS.ProcessEnv) {
  const contextPath = env.ONYX_WORKER_CONTEXT?.trim()
  if (!contextPath) return null
  const context = await parseWorkerRuntimeContext(contextPath)
  try {
    await access(context.workerCliPath, constants.X_OK)
  } catch {
    throw new Error(
      `Supervised worker CLI wrapper at ${context.workerCliPath} is missing or not executable. Stop this worker and let the supervisor relaunch it.`
    )
  }
  return context.workerCliPath
}

async function runPinnedWorkerCli(
  workerCliPath: string,
  argv: string[],
  env: NodeJS.ProcessEnv
) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(workerCliPath, argv, {
      env: { ...env, [ONYX_WORKER_CLI_REDIRECTED]: "1" },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

export type DevCommandRunner = (
  checkout: DeveloperCheckout,
  argv: string[],
  env: NodeJS.ProcessEnv,
  entrypoint?: "onyx" | "onyx-worker"
) => Promise<number>

export async function defaultDevCommandRunner(
  checkout: DeveloperCheckout,
  argv: string[],
  env: NodeJS.ProcessEnv,
  entrypoint: "onyx" | "onyx-worker" = "onyx"
) {
  return new Promise<number>((resolve, reject) => {
    const binPath =
      entrypoint === "onyx-worker" ? checkout.workerBinPath : checkout.binPath
    const child = spawn("bun", [binPath, ...argv], {
      env: {
        ...env,
        [ONYX_LAUNCHER_BYPASS]: "1",
      },
      stdio: "inherit",
    })

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "Onyx developer mode requires Bun to run the linked source checkout. Install Bun or switch back with `onyx developer use release`."
          )
        )
        return
      }
      reject(error)
    })
    child.on("close", (code) => resolve(code ?? 1))
  })
}

/**
 * Shared launcher engine. The `onyx` entrypoint wraps this with the full CLI
 * `main` and the developer command in `src/launcher.ts`; the `onyx-worker`
 * binary uses `src/worker-cli.ts`, which passes only `workerMain` so the
 * compiled worker binary never bundles the full CLI or its analytics.
 */
export async function runLauncherCore({
  argv = process.argv.slice(2),
  env = process.env,
  runDev = defaultDevCommandRunner,
  entrypoint = "onyx",
  runMain,
  runDeveloperCommand,
}: {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  runDev?: DevCommandRunner
  entrypoint?: "onyx" | "onyx-worker"
  runMain: (argv?: string[]) => Promise<unknown>
  runDeveloperCommand?: (argv: string[]) => Promise<void>
}) {
  if (
    entrypoint === "onyx" &&
    argv[0] === "developer" &&
    runDeveloperCommand
  ) {
    if (env.ONYX_WORKER_CONTEXT) {
      throw new Error(
        "The full `onyx` CLI is not available inside a worker runtime. Use `onyx-worker` for worker-safe research commands."
      )
    }
    await runDeveloperCommand(argv)
    return 0
  }

  if (env[ONYX_LAUNCHER_BYPASS] === "1") {
    await runMain(argv)
    return 0
  }

  if (
    entrypoint === "onyx-worker" &&
    env[ONYX_WORKER_CLI_REDIRECTED] !== "1"
  ) {
    const workerCliPath = await pinnedWorkerCliPath(env)
    if (workerCliPath) {
      return runPinnedWorkerCli(workerCliPath, argv, env)
    }
  }

  const config = await readConfig()
  if (config.developer.mode === "dev") {
    const checkout = config.developer.checkout
    if (!checkout) {
      throw new Error(
        "Onyx developer mode is active, but no checkout is linked. Run `onyx developer link <path>` or switch back with `onyx developer use release`."
      )
    }
    await validateDeveloperCheckout(checkout)
    return runDev(checkout, argv, env, entrypoint)
  }

  await runMain(argv)
  return 0
}
