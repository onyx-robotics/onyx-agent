import { spawn } from "node:child_process"

import { validateDeveloperCheckout } from "./commands/developer"
import { readConfig, type DeveloperCheckout } from "./lib/config"
import { workerMain } from "./worker-main"

const ONYX_LAUNCHER_BYPASS = "ONYX_LAUNCHER_BYPASS"

async function runWorkerDev(
  checkout: DeveloperCheckout,
  argv: string[],
  env: NodeJS.ProcessEnv
) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("bun", [checkout.workerBinPath, ...argv], {
      env: { ...env, [ONYX_LAUNCHER_BYPASS]: "1" },
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

async function runWorkerLauncher(argv = process.argv.slice(2)) {
  if (process.env[ONYX_LAUNCHER_BYPASS] === "1") {
    await workerMain(argv)
    return 0
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
    return runWorkerDev(checkout, argv, process.env)
  }
  await workerMain(argv)
  return 0
}

export async function runWorkerCli() {
  try {
    const code = await runWorkerLauncher()
    if (code !== 0) process.exit(code)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
