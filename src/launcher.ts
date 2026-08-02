import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"

import type { DeveloperCheckout } from "./lib/config"

import {
  commandDeveloper,
  validateDeveloperCheckout,
} from "./commands/developer"
import { parseArgs } from "./lib/args"
import { readConfig } from "./lib/config"
import { pathExists } from "./lib/process"
import { main } from "./main"
import { workerMain } from "./worker-main"

export const ONYX_LAUNCHER_BYPASS = "ONYX_LAUNCHER_BYPASS"
const ONYX_WORKER_CLI_REDIRECTED = "ONYX_WORKER_CLI_REDIRECTED"

/**
 * Inside a supervised worker runtime, every `onyx-worker` entrypoint defers to
 * the supervisor-pinned wrapper recorded in the runtime context. This keeps
 * bare `onyx-worker` calls correct even when a login shell reorders PATH in
 * front of the per-worker wrapper bin directory (e.g. a globally installed
 * release binary shadowing a developer-mode checkout).
 */
async function pinnedWorkerCliPath(env: NodeJS.ProcessEnv) {
  const contextPath = env.ONYX_WORKER_CONTEXT?.trim()
  if (!contextPath) return null
  try {
    const parsed: unknown = JSON.parse(await readFile(contextPath, "utf8"))
    if (!parsed || typeof parsed !== "object") return null
    const workerCliPath = (parsed as Record<string, unknown>).workerCliPath
    if (typeof workerCliPath !== "string" || !workerCliPath) return null
    return (await pathExists(workerCliPath)) ? workerCliPath : null
  } catch {
    return null
  }
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

export async function runLauncher({
  argv = process.argv.slice(2),
  env = process.env,
  runDev = defaultDevCommandRunner,
  entrypoint = "onyx",
  runMain = main,
}: {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  runDev?: DevCommandRunner
  entrypoint?: "onyx" | "onyx-worker"
  runMain?: (argv?: string[]) => Promise<unknown>
} = {}) {
  if (entrypoint === "onyx" && argv[0] === "developer") {
    if (env.ONYX_WORKER_CONTEXT) {
      throw new Error(
        "The full `onyx` CLI is not available inside a worker runtime. Use `onyx-worker` for worker-safe research commands."
      )
    }
    await commandDeveloper(parseArgs(argv))
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

export async function runCli() {
  try {
    const code = await runLauncher()
    if (code !== 0) process.exit(code)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export async function runWorkerCli() {
  try {
    const code = await runLauncher({
      entrypoint: "onyx-worker",
      runMain: workerMain,
    })
    if (code !== 0) process.exit(code)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
