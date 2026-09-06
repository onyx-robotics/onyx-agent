import {
  acquireFileResourceLease,
  ResourceLockContentionError,
} from "./resource-locks"
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import type { CreateResearchCampaignExperimentRequest } from "../protocol"
import type { Args } from "./args"
import type { CachedAttemptRecord } from "./local-attempt-cache"
import { ApiError, apiData, callApi, reportCampaignExperiment } from "./api"
import { apiBaseUrl, readConfig, selectedProfileWithName } from "./config"
import { git, gitResult } from "./git"
import { runProcess } from "./process"
import { onyxStateDir } from "./runtime-state"
import {
  clearLocalAttempt,
  listLocalAttempts,
  readLocalAttempt,
  writeLocalAttempt,
} from "./research-runtime"

export type DeliveryDestination = {
  apiUrl: string
  teamId: string
  campaignId: string
  siteId?: string
  supervisorRunId?: string
}
export type PendingDelivery = {
  version: 1
  destination: DeliveryDestination
  body: CreateResearchCampaignExperimentRequest
  sealed: boolean
  attempts: number
  nextAttemptAt: number
  state: "pending" | "blocked" | "rejected"
  reason?: string
  reportAcknowledged?: boolean
  pushCompleted?: boolean
}

/** Separate from the frozen HTTP body: later pushes must not alter report retries. */
export async function acknowledgeReport(
  root: string,
  record: CachedAttemptRecord
) {
  const delivery = record.delivery!
  delivery.reportAcknowledged = true
  if (
    delivery.pushCompleted ||
    delivery.body.resultRefPushStatus === "pushed"
  ) {
    await clearLocalAttempt(root, { runRef: record.runRef })
  } else {
    delivery.state = "blocked"
    delivery.reason =
      "Report acknowledged; immutable ref still needs pushing to origin"
    delivery.nextAttemptAt = Date.now() + 1000
    await writeLocalAttempt({ root, record })
  }
}

export async function pushAttemptRef(
  root: string,
  record: Pick<CachedAttemptRecord, "runRef" | "resultCommitSha" | "resultRef">,
  deadline?: number
) {
  await preserveResultRef(root, record.resultCommitSha, record.resultRef)
  const release = await acquireFileResourceLease({
    root,
    resourceName: "onyx-result-ref-push",
    slots: 4,
    timeoutMs: deadline ? 0 : 120_000,
    leaseMs: 180_000,
    ownerId: randomUUID(),
    metadata: { runRef: record.runRef },
  }).catch((error) => {
    if (error instanceof ResourceLockContentionError) return null
    throw error
  })
  if (!release)
    return {
      resultRefPushStatus: "failed" as const,
      resultRefPushError:
        "No push slot available; retained immutable local ref",
    }
  let uncertain = false
  try {
    if (deadline && Date.now() >= deadline - 500)
      throw new Error("Recovery push deferred to the next pass")
    const result = await runProcess(
      "git",
      ["push", "origin", `${record.resultCommitSha}:${record.resultRef}`],
      {
        cwd: root,
        timeoutMs: deadline
          ? Math.max(1, deadline - Date.now() - 500)
          : 180_000,
        ...(deadline ? { killGraceMs: 250 } : {}),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }
    )
    uncertain = result.protectionUncertain ?? false
    if (uncertain)
      throw new Error("Push termination uncertain; retaining its resource slot")
    if (result.code !== 0 || result.timedOut)
      throw new Error(result.stderr || "Git push failed or timed out")
    return {
      resultRefPushStatus: "pushed" as const,
      resultRefPushedAt: new Date().toISOString(),
    }
  } catch (error) {
    return {
      resultRefPushStatus: "failed" as const,
      resultRefPushError:
        error instanceof Error ? error.message : "Git push failed",
    }
  } finally {
    if (!uncertain) await release()
  }
}

export function attemptDeliveryResource(runRef: string) {
  return `onyx-report-attempt-${createHash("sha256").update(runRef).digest("hex")}`
}

export async function withAttemptDeliveryOwner<T>(
  root: string,
  runRef: string,
  work: () => Promise<T>,
  timeoutMs = 5000
): Promise<T> {
  const release = await acquireFileResourceLease({
    root,
    resourceName: attemptDeliveryResource(runRef),
    slots: 1,
    timeoutMs,
    leaseMs: 5000,
    ownerId: randomUUID(),
    metadata: { runRef },
  })
  try {
    return await work()
  } finally {
    await release()
  }
}

const destinations = new Map<string, Promise<DeliveryDestination>>()
export async function deliveryDestination(
  campaignId: string,
  projectId: string,
  args: Args
): Promise<DeliveryDestination> {
  const apiUrl = await apiBaseUrl(args)
  const key = `${apiUrl}:${projectId}:${args.options.profile ?? ""}`
  let pending = destinations.get(key)
  if (!pending) {
    pending = (async () => {
      const project = apiData<{ teamId: string }>(
        await callApi(
          "GET",
          `/api/v1/research/projects/${projectId}`,
          undefined,
          args
        )
      )
      return { apiUrl, teamId: project.teamId, campaignId }
    })()
    destinations.set(key, pending)
    pending.catch(() => destinations.delete(key))
  }
  return { ...(await pending), campaignId }
}

export async function preserveResultRef(
  root: string,
  commit: string,
  ref: string
) {
  // create-only compare-and-swap; a concurrent identical writer is harmless.
  const created = await gitResult(
    ["update-ref", ref, commit, "0".repeat(commit.length)],
    root
  )
  if (created.code === 0) return
  const existing = await git(["rev-parse", "--verify", ref], root)
  if (existing.trim() !== commit)
    throw new Error(`Immutable experiment ref conflicts: ${ref}`)
}

export function initialReportBody(
  record: CachedAttemptRecord,
  assignmentId?: string
): CreateResearchCampaignExperimentRequest {
  if (!record.sessionId || !record.hypothesisId || !assignmentId)
    throw new Error("Measured report is missing immutable assignment identity")
  return {
    runRef: record.runRef,
    name: record.runRef,
    description: "",
    sessionId: record.sessionId ?? undefined,
    assignmentId,
    hypothesisId: record.hypothesisId ?? undefined,
    workerId: record.workerId ?? undefined,
    baseCommitSha: record.baseCommitSha,
    resultCommitSha: record.resultCommitSha,
    resultRef: record.resultRef,
    resultRefPushStatus: "failed",
    resultRefPushError: "Delivery interrupted before ref push completed",
    status: record.status,
    setupCompliance: record.setupCompliance,
    primaryMetricName: record.primaryMetricName,
    ...(record.primaryMetricValue == null
      ? {}
      : { primaryMetricValue: record.primaryMetricValue }),
    secondaryMetrics: record.metrics,
    artifactRefs: {},
    agentNotes: record.agentNotes,
    ...(record.checks
      ? {
          checks: {
            status: record.checks.status,
            durationMs: record.checks.durationMs ?? null,
            outputSummary: record.checks.outputSummary ?? null,
          },
        }
      : {}),
    ...(record.durationMs == null ? {} : { durationMs: record.durationMs }),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    completedAt: record.completedAt ?? record.createdAt,
    provenance: [],
    ...(record.outputSummary ? { outputSummary: record.outputSummary } : {}),
  }
}

export async function withDeliveryOwner<T>(
  root: string,
  work: () => Promise<T>
): Promise<T> {
  const release = await acquireFileResourceLease({
    root,
    resourceName: "onyx-report-delivery",
    slots: 1,
    timeoutMs: 0,
    leaseMs: 5000,
    ownerId: randomUUID(),
  }).catch((error) => {
    if (!(error instanceof ResourceLockContentionError)) throw error
    throw new Error(
      "Report delivery is occupied. After stopping all delivery processes, use onyx research locks reset --resource onyx-report-delivery --confirm-idle.",
      { cause: error }
    )
  })
  try {
    return await work()
  } finally {
    await release()
  }
}

export async function pendingReportSummary(root: string) {
  const records = await listLocalAttempts(root)
  const files = await readdir(join(await onyxStateDir(root), "attempts")).catch(
    (error) => {
      if (error.code === "ENOENT") return []
      throw error
    }
  )
  const invalid = Math.max(
    0,
    files.filter((name) => name.endsWith(".json")).length - records.length
  )
  return {
    pending: records.length + invalid,
    diagnostics: records
      .filter(
        (record) =>
          !record.delivery ||
          record.delivery.version !== 1 ||
          record.delivery.state !== "pending"
      )
      .slice(0, 25)
      .map((record) => ({
        runRef: record.runRef,
        state: record.delivery?.state ?? "unsupported",
        reason:
          record.delivery?.reason ??
          "Unsupported attempt format; retained for manual inspection",
        destination: record.delivery?.destination ?? null,
      })),
    invalidRecords: invalid,
    oldestPendingAt:
      records.map((record) => record.createdAt).sort()[0] ?? null,
    blocked:
      invalid +
      records.filter(
        (record) =>
          !record.delivery ||
          record.delivery.version !== 1 ||
          record.delivery.state === "blocked"
      ).length,
    rejected: records.filter((record) => record.delivery?.state === "rejected")
      .length,
  }
}

async function matchingDeliveryArgs(
  destination: DeliveryDestination,
  args: Args
): Promise<Args> {
  if (process.env.ONYX_API_KEY || args.options.profile) {
    if ((await apiBaseUrl(args)) !== destination.apiUrl)
      throw new Error("Credential origin differs from saved report")
    if (
      !process.env.ONYX_API_KEY &&
      (await selectedProfileWithName(args)).profile.teamId !==
        destination.teamId
    )
      throw new Error("Credential team differs from saved report")
    return args
  }
  const config = await readConfig()
  const matching = Object.entries(config.profiles ?? {}).find(
    ([, profile]) =>
      profile.apiUrl === destination.apiUrl &&
      profile.teamId === destination.teamId
  )
  if (!matching) throw new Error("No credential profile matches saved report")
  return {
    ...args,
    options: {
      ...args.options,
      profile: matching[0],
      "api-url": destination.apiUrl,
    },
  }
}

export async function recoverReports(root: string, args: Args, dryRun = false) {
  if (dryRun) return pendingReportSummary(root)
  return withDeliveryOwner(root, async () => {
    const deadline = Date.now() + 5000
    const records = (await listLocalAttempts(root)).sort(
      (a, b) =>
        (a.delivery?.nextAttemptAt ?? 0) - (b.delivery?.nextAttemptAt ?? 0)
    )
    let attempted = 0
    for (const candidate of records) {
      const scheduled = candidate.delivery
      if (
        !scheduled ||
        scheduled.version !== 1 ||
        scheduled.state === "rejected" ||
        scheduled.nextAttemptAt > Date.now()
      )
        continue
      if (attempted >= 25 || Date.now() >= deadline) break
      try {
        await withAttemptDeliveryOwner(
          root,
          candidate.runRef,
          async () => {
            // The foreground reporter may have changed or removed this entry since listing.
            const record = await readLocalAttempt(root, {
              runRef: candidate.runRef,
            })
            if (!record) return
            const delivery = record.delivery
            if (
              !delivery ||
              delivery.version !== 1 ||
              delivery.state === "rejected" ||
              delivery.nextAttemptAt > Date.now()
            )
              return
            attempted += 1
            try {
              const matchingArgs = await matchingDeliveryArgs(
                delivery.destination,
                args
              )
              // Verify automation credentials too; never trust the current default team.
              const scopedArgs = {
                ...matchingArgs,
                options: {
                  ...matchingArgs.options,
                  "api-deadline": String(deadline),
                  "api-timeout": String(Math.max(1, deadline - Date.now())),
                },
              }
              const campaign = apiData<{ campaign: { projectId: string } }>(
                await callApi(
                  "GET",
                  `/api/v1/research/campaigns/${delivery.destination.campaignId}/overview`,
                  undefined,
                  scopedArgs
                )
              )
              const project = apiData<{ teamId: string }>(
                await callApi(
                  "GET",
                  `/api/v1/research/projects/${campaign.campaign.projectId}`,
                  undefined,
                  {
                    ...scopedArgs,
                    options: {
                      ...scopedArgs.options,
                      "api-deadline": String(deadline),
                      "api-timeout": String(Math.max(1, deadline - Date.now())),
                    },
                  }
                )
              )
              if (project.teamId !== delivery.destination.teamId)
                throw new Error("Saved delivery team does not match credential")
              await preserveResultRef(
                root,
                record.resultCommitSha,
                record.resultRef
              )
              if (
                !delivery.pushCompleted &&
                delivery.body.resultRefPushStatus !== "pushed"
              ) {
                const push = await pushAttemptRef(root, record, deadline)
                delivery.pushCompleted = push.resultRefPushStatus === "pushed"
                if (!delivery.sealed) {
                  delete delivery.body.resultRefPushError
                  delete delivery.body.resultRefPushedAt
                  Object.assign(delivery.body, push)
                }
              }
              delivery.sealed = true
              await writeLocalAttempt({ root, record })
              if (delivery.reportAcknowledged) {
                if (
                  !delivery.pushCompleted &&
                  delivery.body.resultRefPushStatus !== "pushed"
                )
                  throw new Error("Immutable ref push still pending")
                await acknowledgeReport(root, record)
                return
              }
              const response = await reportCampaignExperiment(
                delivery.destination.campaignId,
                delivery.body,
                {
                  ...scopedArgs,
                  options: {
                    ...scopedArgs.options,
                    "api-deadline": String(deadline),
                    "api-timeout": String(Math.max(1, deadline - Date.now())),
                  },
                }
              )
              if (
                (response.outcome !== "recorded" &&
                  response.outcome !== "duplicate") ||
                response.experiment.runRef !== record.runRef
              )
                throw new Error("Report was not acknowledged")
              await acknowledgeReport(root, record)
            } catch (error) {
              delivery.attempts += 1
              delivery.state =
                error instanceof ApiError &&
                [400, 404, 409, 410, 422].includes(error.status)
                  ? "rejected"
                  : "blocked"
              delivery.reason =
                error instanceof ApiError
                  ? `API ${error.status}: ${error.code ?? "delivery_failed"}`
                  : delivery.reportAcknowledged
                    ? "Report acknowledged; immutable ref push pending. Verify origin access and retry recovery"
                    : "Delivery unavailable; verify matching credentials, origin, and local immutable ref"
              delivery.nextAttemptAt =
                Date.now() +
                Math.max(
                  error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0,
                  Math.min(
                    300_000,
                    1000 * 2 ** Math.min(delivery.attempts - 1, 20)
                  ) *
                    (0.75 + Math.random() * 0.25)
                )
              await writeLocalAttempt({ root, record })
            }
          },
          0
        )
      } catch (error) {
        // A healthy foreground reporter owns this attempt; rotate past it.
        if (!(error instanceof ResourceLockContentionError)) throw error
      }
    }
    await recoverCleanupReceipts(root, args, deadline)
    return pendingReportSummary(root)
  }).catch((error) => {
    if (
      error instanceof Error &&
      error.cause instanceof ResourceLockContentionError
    )
      return pendingReportSummary(root)
    throw error
  })
}

export async function assertAttemptRefsPreserved(
  root: string,
  workerId: string
) {
  if ((await pendingReportSummary(root)).invalidRecords > 0)
    throw new Error(
      "Retaining worktree while malformed pending attempts require inspection"
    )
  for (const attempt of await listLocalAttempts(root, { workerId })) {
    if (!attempt.delivery)
      throw new Error("Retaining worktree for unsupported pending attempt")
    await preserveResultRef(root, attempt.resultCommitSha, attempt.resultRef)
  }
}

type CleanupReceipt = {
  destination: DeliveryDestination
  sessionId: string
  siteId: string
  supervisorRunId: string
  readyExceptDelivery: boolean
}
export async function saveCleanupReceipt(
  root: string,
  receipt: CleanupReceipt
) {
  const dir = join(await onyxStateDir(root), "delivery-cleanup")
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${receipt.sessionId}.${receipt.siteId}.json`)
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(receipt))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  const directory = await open(dir, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
async function recoverCleanupReceipts(
  root: string,
  args: Args,
  deadline: number
) {
  const dir = join(await onyxStateDir(root), "delivery-cleanup")
  const pending = await listLocalAttempts(root)
  if ((await pendingReportSummary(root)).pending > pending.length) return
  for (const name of await readdir(dir).catch(() => [])) {
    if (Date.now() >= deadline || !name.endsWith(".json")) continue
    try {
      const receipt = JSON.parse(
        await readFile(join(dir, name), "utf8")
      ) as CleanupReceipt
      if (
        !receipt.readyExceptDelivery ||
        pending.some((entry) => entry.sessionId === receipt.sessionId)
      )
        continue
      const matchingArgs = await matchingDeliveryArgs(receipt.destination, args)
      const scoped = {
        ...matchingArgs,
        options: {
          ...matchingArgs.options,
          "api-deadline": String(deadline),
          "api-timeout": String(Math.max(1, deadline - Date.now())),
        },
      }
      const live = apiData<{
        project: { teamId: string }
        sites: Array<{
          siteId: string
          supervisorRunId: string
          cleanupRevision: number
          runtimeStatus: string
        }>
      }>(
        await callApi(
          "GET",
          `/api/v1/research/sessions/${receipt.sessionId}/live`,
          undefined,
          scoped
        )
      )
      // The live contract does not include the project on every response; verify team through the saved campaign.
      const campaign = apiData<{ campaign: { projectId: string } }>(
        await callApi(
          "GET",
          `/api/v1/research/campaigns/${receipt.destination.campaignId}/overview`,
          undefined,
          scoped
        )
      )
      const project = apiData<{ teamId: string }>(
        await callApi(
          "GET",
          `/api/v1/research/projects/${campaign.campaign.projectId}`,
          undefined,
          scoped
        )
      )
      if (project.teamId !== receipt.destination.teamId) continue
      const site = live.sites.find(
        (entry) =>
          entry.siteId === receipt.siteId &&
          entry.supervisorRunId === receipt.supervisorRunId
      )
      if (!site) continue
      if (site.runtimeStatus !== "complete")
        await callApi(
          "PATCH",
          `/api/v1/research/sessions/${receipt.sessionId}/cleanup`,
          {
            siteId: receipt.siteId,
            supervisorRunId: receipt.supervisorRunId,
            expectedRevision: site.cleanupRevision,
            status: "complete",
            summary: { pendingReports: 0, recovered: true },
          },
          {
            ...scoped,
            options: {
              ...scoped.options,
              "api-deadline": String(deadline),
              "api-timeout": String(Math.max(1, deadline - Date.now())),
            },
          }
        )
      await unlink(join(dir, name))
    } catch {
      /* Retain the receipt until its authenticated remote update is acknowledged. */
    }
  }
}
