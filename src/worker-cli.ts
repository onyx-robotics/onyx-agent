import { runLauncherCore } from "./lib/cli-launcher"
import { workerMain } from "./worker-main"

/**
 * Entry for the standalone `onyx-worker` binary. Deliberately built on the
 * launcher core with only `workerMain` so the compiled worker binary never
 * bundles the full CLI, its analytics, or the telemetry token — the release
 * pipeline verifies that boundary (`scripts/verify-release-analytics.ts`).
 */
export async function runWorkerCli() {
  try {
    const code = await runLauncherCore({
      entrypoint: "onyx-worker",
      runMain: workerMain,
    })
    if (code !== 0) process.exit(code)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
