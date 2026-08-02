import { commandDeveloper } from "./commands/developer"
import { parseArgs } from "./lib/args"
import {
  ONYX_LAUNCHER_BYPASS,
  defaultDevCommandRunner,
  runLauncherCore,
  type DevCommandRunner,
} from "./lib/cli-launcher"
import { main } from "./main"

export { ONYX_LAUNCHER_BYPASS, defaultDevCommandRunner }
export type { DevCommandRunner }
export { runWorkerCli } from "./worker-cli"

/**
 * Launcher for the full `onyx` CLI (and the library/test surface, which may
 * pass `entrypoint: "onyx-worker"` with a custom `runMain`). The standalone
 * worker binary uses `src/worker-cli.ts` instead so it never bundles `main`.
 */
export async function runLauncher(
  options: {
    argv?: string[]
    env?: NodeJS.ProcessEnv
    runDev?: DevCommandRunner
    entrypoint?: "onyx" | "onyx-worker"
    runMain?: (argv?: string[]) => Promise<unknown>
  } = {}
) {
  return runLauncherCore({
    ...options,
    runMain: options.runMain ?? main,
    runDeveloperCommand: async (argv) => {
      await commandDeveloper(parseArgs(argv))
    },
  })
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
