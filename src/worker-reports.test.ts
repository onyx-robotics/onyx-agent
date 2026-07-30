import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  readWorkerReportMarker,
  recordWorkerReportedExperiment,
} from "./lib/worker-reports"

describe("worker report marker", () => {
  test("tracks successful reports without double-counting an immediate retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onyx-worker-report-"))
    const contextPath = join(dir, "context.json")
    await writeFile(contextPath, "{}\n")
    try {
      const input = {
        contextPath,
        workerId: "worker-1",
        sessionId: "session-1",
        hypothesisId: "hypothesis-1",
      }
      await recordWorkerReportedExperiment({ ...input, runRef: "run-1" })
      await recordWorkerReportedExperiment({ ...input, runRef: "run-1" })
      await recordWorkerReportedExperiment({ ...input, runRef: "run-2" })

      expect(await readWorkerReportMarker(contextPath)).toMatchObject({
        schemaVersion: 1,
        workerId: "worker-1",
        sessionId: "session-1",
        hypothesisId: "hypothesis-1",
        reportedExperimentCount: 2,
        lastRunRef: "run-2",
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
