import { describe, expect, test } from "bun:test"

import { uniqueWorkerWarnings } from "./commands/research"
import type { WorkerLaunchManifest } from "./lib/worker-launcher"

function manifest(values: Partial<WorkerLaunchManifest>): WorkerLaunchManifest {
  return values as WorkerLaunchManifest
}

describe("worker warning presentation", () => {
  test("hides expected provider socket errors after a harness stop", () => {
    const warnings = uniqueWorkerWarnings(
      manifest({
        status: "stopped",
        signal: "SIGTERM",
        warnings: [
          "provider stream/API error detected: socket connection was closed",
          "piped Onyx mutation command detected: onyx exp log | tee output",
        ],
      })
    )

    expect(warnings).toEqual([
      "piped Onyx mutation command detected: onyx exp log | tee output",
    ])
  })

  test("retains provider errors for failed workers", () => {
    const warning =
      "provider stream/API error detected: socket connection was closed"
    expect(
      uniqueWorkerWarnings(
        manifest({ status: "failed", signal: "SIGTERM", warnings: [warning] })
      )
    ).toEqual([warning])
  })
})
