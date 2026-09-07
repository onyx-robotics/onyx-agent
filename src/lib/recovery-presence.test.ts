import { expect, test } from "bun:test"
import { publishRecoveredRuntime } from "./recovery-presence"
import type { ApiSessionLive, ApiResearchPresenceResponse } from "./api"
import type { WorkerLaunchManifest } from "./worker-launcher"

function fixture() {
  const site = {
    siteId: "site",
    supervisorRunId: "run",
    runtimeStatus: "active",
    lastSequence: 17,
    cleanupRevision: 9,
    activeWorkerCount: 1,
    cleanupStartedAt: null,
    launchedWorkerCount: 1,
    failedLaunchCount: 0,
  } as ApiSessionLive["sites"][number]
  const live = {
    session: { id: "session", campaignId: "campaign", endedAt: null },
    sites: [site],
  } as Pick<ApiSessionLive, "session" | "sites">
  const sent: Parameters<
    NonNullable<Parameters<typeof publishRecoveredRuntime>[0]["api"]>["publish"]
  >[0][] = []
  const input = {
    sessionId: "session",
    campaignId: "campaign",
    siteId: "site",
    supervisorRunId: "run",
    manifests: [
      {
        workerId: "worker",
        sessionId: "session",
        supervisorRunId: "run",
        status: "failed",
        teardown: { worktreeCleanup: "removed" },
      } as WorkerLaunchManifest,
    ],
    args: { positional: [], options: {} },
    api: {
      getLive: async () => live,
      publish: async (body: (typeof sent)[number]) => {
        sent.push(body)
        return {
          siteAccepted: true,
          ignoredCount: 0,
        } as ApiResearchPresenceResponse
      },
    },
  }
  return { input, live, site, sent }
}

test("dead runtime clears stale server capacity with exact revision and keeps cutoff open", async () => {
  const { input, site, live, sent } = fixture()
  await publishRecoveredRuntime(input)
  expect(sent[0]).toMatchObject({
    sessionId: "session",
    siteId: "site",
    supervisorRunId: "run",
    sequence: 18,
    site: {
      cleanupRevision: 9,
      activeWorkerCount: 0,
      runtimeStatus: "draining",
    },
    workers: [{ id: "worker", status: "failed" }],
  })
  expect(live.session.endedAt).toBeNull()
  site.lastSequence = 18
  site.cleanupRevision = 10
  await publishRecoveredRuntime(input)
  expect(sent[1]).toMatchObject({ sequence: 19, site: { cleanupRevision: 10 } })
  site.runtimeStatus = "complete"
  await publishRecoveredRuntime(input)
  expect(sent).toHaveLength(2)
})

test("recovery refuses foreign ownership, unfinished cleanup, and revision conflicts", async () => {
  const { input, site, sent } = fixture()
  site.supervisorRunId = "other-run"
  await expect(publishRecoveredRuntime(input)).rejects.toThrow(
    "Matching remote site/run"
  )
  expect(sent).toHaveLength(0)
  site.supervisorRunId = "run"
  input.manifests[0]!.status = "running"
  await expect(publishRecoveredRuntime(input)).rejects.toThrow(
    "cleanup is incomplete"
  )
  expect(sent).toHaveLength(0)
  input.manifests[0]!.status = "failed"
  input.api.publish = async () =>
    ({ siteAccepted: false, ignoredCount: 1 }) as ApiResearchPresenceResponse
  await expect(publishRecoveredRuntime(input)).rejects.toThrow("conflicted")
})
