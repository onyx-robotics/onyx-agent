import {
  getResearchSessionLive,
  heartbeatWorkersBatch,
  upsertResearchPresence,
  type ApiSessionLive,
} from "./api"
import type { Args } from "./args"
import type { WorkerLaunchManifest } from "./worker-launcher"

/** Called only after local reconciliation has proved every managed process
 * dead and removed its worktree and credential context. Never ends a session. */
export async function publishRecoveredRuntime({
  sessionId,
  campaignId,
  siteId,
  supervisorRunId,
  manifests,
  args,
  api = {
    getLive: getResearchSessionLive,
    publish: upsertResearchPresence,
    releaseWorkers: heartbeatWorkersBatch,
  },
}: {
  sessionId: string
  campaignId: string
  siteId: string
  supervisorRunId: string
  manifests: WorkerLaunchManifest[]
  args: Args
  api?: {
    getLive: (
      id: string,
      args: Args
    ) => Promise<Pick<ApiSessionLive, "session" | "sites">>
    publish: typeof upsertResearchPresence
    releaseWorkers: typeof heartbeatWorkersBatch
  }
}) {
  if (
    manifests.length > 250 ||
    manifests.some(
      (manifest) =>
        manifest.sessionId !== sessionId ||
        manifest.supervisorRunId !== supervisorRunId ||
        !["completed", "failed", "stopped"].includes(manifest.status) ||
        manifest.teardown?.worktreeCleanup !== "removed"
    )
  )
    throw new Error("Recovered worker ownership or cleanup is incomplete")
  const live = await api.getLive(sessionId, args)
  if (live.session.id !== sessionId || live.session.campaignId !== campaignId)
    throw new Error("Remote session identity differs from local runtime")
  const site = live.sites.find(
    (entry) =>
      entry.siteId === siteId && entry.supervisorRunId === supervisorRunId
  )
  if (!site)
    throw new Error(
      "Matching remote site/run is unavailable; retain recovery evidence"
    )
  if (manifests.length) {
    const terminal = await api.releaseWorkers(
      {
        sessionId,
        siteId,
        supervisorRunId,
        heartbeats: manifests.map((manifest) => ({
          workerId: manifest.workerId,
          status: manifest.status as "completed" | "failed" | "stopped",
          phase: manifest.status,
          metadata: { teardown: manifest.teardown },
        })),
      },
      args
    )
    if (
      terminal.results.length !== manifests.length ||
      manifests.some((manifest) => {
        const matches = terminal.results.filter(
          (entry) => entry.workerId === manifest.workerId
        )
        return (
          matches.length !== 1 ||
          !matches[0]?.ok ||
          !["completed", "failed", "stopped"].includes(matches[0].worker.status)
        )
      })
    )
      throw new Error(
        "Recovered worker lease release was not acknowledged; retain evidence and retry runtime recovery"
      )
  }
  if (site.runtimeStatus === "complete") return
  const observedAt = new Date().toISOString()
  const response = await api.publish(
    {
      sessionId,
      siteId,
      supervisorRunId,
      sequence: site.lastSequence + 1,
      site: {
        cleanupRevision: site.cleanupRevision,
        runtimeStatus: "draining",
        cleanupStartedAt: site.cleanupStartedAt ?? observedAt,
        activeWorkerCount: 0,
        launchedWorkerCount: site.launchedWorkerCount,
        failedLaunchCount: site.failedLaunchCount,
        cleanupSummary: { recovered: true, activeProcessCount: 0 },
        lastUploadAt: observedAt,
      },
      workers: manifests.map((manifest) => ({
        id: manifest.workerId,
        status: manifest.status as "completed" | "failed" | "stopped",
        phase: manifest.status,
        metadata: { teardown: manifest.teardown },
        observedAt,
      })),
    },
    args
  )
  if (!response.siteAccepted || response.ignoredCount > 0)
    throw new Error(
      "Remote recovery presence conflicted; retain evidence and retry runtime recovery"
    )
}
