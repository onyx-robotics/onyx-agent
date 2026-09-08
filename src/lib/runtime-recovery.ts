import { reconcileManagedProcessGroups } from "./managed-process-groups"
import { readdir, readFile, lstat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { gitCommonDir } from "./git"
import { resolveStoragePath, linuxBootId } from "./linux-environment"
import {
  processOwnership,
  stopOwnedProcessGroup,
  type ProcessEvidence,
} from "./process-identity"
import type { CliState } from "./runtime-state"
import type { WorkerLaunchManifest } from "./worker-launcher"
import { acquireFileResourceLease } from "./resource-locks"
import { randomUUID } from "node:crypto"

export const RUNTIME_RESOURCE = "onyx-runtime-reconciliation"
export async function acquireRuntimeOwnership(root: string) {
  return acquireFileResourceLease({
    root,
    resourceName: RUNTIME_RESOURCE,
    slots: 1,
    timeoutMs: 0,
    leaseMs: 120_000,
    ownerId: randomUUID(),
  })
}

export type RuntimeSessionResult = {
  sessionId: string
  status: "recovered" | "skipped-active" | "blocked"
  actions: string[]
  reasons: string[]
}
export type RuntimeRecoveryResult = {
  recovered: number
  skippedActive: number
  blocked: number
  sessions: RuntimeSessionResult[]
}

export async function readRuntimeState(root: string): Promise<CliState> {
  try {
    const state = JSON.parse(
      await readFile(
        join(await gitCommonDir(root), "onyx", "state.json"),
        "utf8"
      )
    )
    if (
      !state ||
      typeof state !== "object" ||
      (state.schemaVersion !== undefined && state.schemaVersion !== 2) ||
      (state.sessions && typeof state.sessions !== "object")
    )
      throw new Error("Invalid state")
    return state
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw new Error("Runtime state is unreadable; retain it for inspection", {
      cause: error,
    })
  }
}

async function entries(path: string) {
  return readdir(path).catch((error) => {
    if (error.code === "ENOENT") return [] as string[]
    throw error
  })
}
const safeId = (value: string) =>
  /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,79}$/.test(value) && !value.endsWith("-")

/** Reads never call mkdir-based convenience accessors. All deletions are
 * delegated to the same teardown helper used during launch reconciliation. */
export async function reconcileRuntime({
  root,
  sessionId,
  dryRun = false,
  cleanup,
  complete,
}: {
  root: string
  sessionId?: string
  dryRun?: boolean
  cleanup: (
    sessionId: string,
    manifest: WorkerLaunchManifest
  ) => Promise<boolean>
  complete: (sessionId: string) => Promise<void>
}): Promise<RuntimeRecoveryResult> {
  const state = await readRuntimeState(root)
  const base = join(await gitCommonDir(root), "onyx")
  const site = await readFile(join(base, "runtime", "site-id"), "utf8")
    .then((v) => v.trim())
    .catch(() => null)
  const ids = sessionId
    ? [sessionId]
    : [
        ...new Set([
          ...Object.keys(state.sessions ?? {}),
          ...(await entries(join(base, "worker-runtime"))),
          ...(await entries(join(base, "worker-logs"))),
          ...(await entries(join(base, "worktrees"))),
        ]),
      ].sort()
  const sessions: RuntimeSessionResult[] = []
  const deadline = Date.now() + 60_000
  for (const id of ids.slice(0, 100)) {
    const result: RuntimeSessionResult = {
      sessionId: id,
      status: "blocked",
      actions: [],
      reasons: [],
    }
    sessions.push(result)
    try {
      if (!safeId(id))
        throw new Error("Invalid session directory name; retain for inspection")
      if (Date.now() >= deadline)
        throw new Error("Recovery pass time limit reached; run again")
      const local = state.sessions?.[id]
      if (
        !local?.supervisor?.supervisorRunId ||
        !site ||
        local.schedulerSiteId !== site
      )
        throw new Error("Missing or mismatched local site/supervisor ownership")
      const path = join(base, "worker-runtime", id, "supervisor-process.json")
      const supervisor = JSON.parse(
        await readFile(path, "utf8")
      ) as ProcessEvidence & {
        schemaVersion: number
        mode?: string
        createdAt?: string
        sessionId: string
        supervisorRunId: string
      }
      if (
        supervisor.schemaVersion !== 1 ||
        !["foreground", "detached"].includes(supervisor.mode ?? "") ||
        typeof supervisor.createdAt !== "string" ||
        supervisor.sessionId !== id ||
        supervisor.supervisorRunId !== local.supervisor.supervisorRunId ||
        supervisor.pid !== local.supervisor.pid ||
        supervisor.processStartedAt !== local.supervisor.processStartedAt ||
        supervisor.commandIdentity !== local.supervisor.commandIdentity
      )
        throw new Error("Supervisor evidence is inconsistent")
      const ownership = processOwnership(supervisor)
      if (ownership === "active") {
        result.status = "skipped-active"
        result.reasons.push("Supervisor identity is live")
        continue
      }
      if (ownership !== "dead")
        throw new Error("Supervisor death cannot be established")
      const logDir = join(base, "worker-logs", id)
      const manifests: WorkerLaunchManifest[] = []
      for (const file of await entries(logDir)) {
        if (!file.endsWith(".manifest.json")) continue
        const manifest = JSON.parse(
          await readFile(join(logDir, file), "utf8")
        ) as WorkerLaunchManifest
        if (
          manifest.schemaVersion !== 2 ||
          manifest.sessionId !== id ||
          !safeId(manifest.workerId ?? "") ||
          !safeId(manifest.hypothesisId ?? "") ||
          !/^[a-f0-9]{40,64}$/.test(manifest.startingCommitSha ?? "") ||
          !["starting", "running", "completed", "failed", "stopped"].includes(
            manifest.status
          ) ||
          manifest.supervisorRunId !== supervisor.supervisorRunId ||
          manifest.manifestPath !== join(logDir, file)
        )
          throw new Error("Unsupported or mismatched worker manifest retained")
        const worktree = join(base, "worktrees", id, manifest.workerId)
        const cwd = resolve(manifest.cwd)
        if (cwd !== worktree && !cwd.startsWith(`${worktree}${sep}`))
          throw new Error("Worker cwd is outside its disposable worktree")
        const runtime = join(base, "worker-runtime", id, manifest.workerId)
        for (const target of [worktree, runtime, manifest.manifestPath]) {
          const actual = await resolveStoragePath(target)
          const expected = join(
            await resolveStoragePath(base),
            target.slice(base.length)
          )
          if (actual !== expected)
            throw new Error(
              "Worker artifact symlink escapes its expected location"
            )
        }
        manifests.push(manifest)
      }
      if (manifests.length > 250)
        throw new Error("Worker manifest limit exceeded; retain for inspection")
      // No unaccounted runtime home or worktree may be silently removed.
      for (const name of await entries(join(base, "worktrees", id))) {
        if (!manifests.some((m) => m.workerId === name))
          throw new Error(`Unaccounted worktree: ${name}`)
      }
      const runtimeEntries = await readdir(join(base, "worker-runtime", id), {
        withFileTypes: true,
      })
      for (const entry of runtimeEntries) {
        if (
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          !manifests.some((m) => m.workerId === entry.name)
        )
          throw new Error(`Unaccounted runtime directory: ${entry.name}`)
      }
      for (const manifest of manifests) {
        const exists = async (path: string) =>
          lstat(path)
            .then(() => true)
            .catch((error) => {
              if (error.code === "ENOENT") return false
              throw error
            })
        if (
          ["completed", "failed", "stopped"].includes(manifest.status) &&
          manifest.teardown?.worktreeCleanup === "removed" &&
          !(await exists(join(base, "worktrees", id, manifest.workerId))) &&
          !(await exists(join(base, "worker-runtime", id, manifest.workerId)))
        ) {
          result.actions.push(
            `${manifest.workerId}: already cleaned; preserve terminal diagnostics`
          )
          continue
        }
        if (
          process.platform === "linux" &&
          manifest.managedProcessGroupsVersion !== 1 &&
          !(
            manifest.bootId &&
            linuxBootId() &&
            manifest.bootId !== linuxBootId()
          )
        )
          throw new Error(
            `Worker ${manifest.workerId}: legacy evaluator process ownership is unavailable; retain runtime evidence`
          )
        const owner = processOwnership(manifest, true)
        if (owner === "unknown")
          throw new Error(
            `Worker ${manifest.workerId}: process/descendant ownership is uncertain`
          )
        result.actions.push(
          `${manifest.workerId}: ${owner === "active" ? "stop verified process group, " : ""}preserve terminal refs, remove worktree and credential runtime`
        )
        if (dryRun) {
          const groups = await reconcileManagedProcessGroups(
            join(base, "worker-runtime", id, manifest.workerId),
            { dryRun: true }
          )
          if (groups)
            result.actions.push(
              `${manifest.workerId}: stop ${groups} identity-verified managed process group(s)`
            )
          continue
        }
        if (
          Date.now() >= deadline ||
          (owner === "active" &&
            !(await stopOwnedProcessGroup(
              manifest,
              Math.min(
                Number.isFinite(manifest.stopGraceMs) &&
                  manifest.stopGraceMs! >= 0
                  ? manifest.stopGraceMs!
                  : 30_000,
                deadline - Date.now()
              )
            )))
        )
          throw new Error(
            `Worker ${manifest.workerId}: termination remains uncertain; artifacts retained`
          )
        if (!(await cleanup(id, manifest)))
          throw new Error(
            `Worker ${manifest.workerId}: cleanup incomplete; evidence retained`
          )
      }
      const resources = await entries(join(base, "resource-locks"))
      for (const resource of resources) {
        if (Date.now() >= deadline)
          throw new Error(
            "Resource inspection time limit reached; retain artifacts and retry"
          )
        if (resource === RUNTIME_RESOURCE) continue
        if (
          (await entries(join(base, "resource-locks", resource))).some((name) =>
            /^\d+\.json$/.test(name)
          )
        ) {
          result.reasons.push(
            `Occupied resource ${resource}; stop every user, then onyx research locks reset --resource ${resource} --confirm-idle`
          )
        }
      }
      if (!result.reasons.length) {
        if (!dryRun) await complete(id)
        result.status = "recovered"
        result.reasons.push(
          `Remote cutoff unchanged. If still open: onyx research stop --session ${id}`
        )
      }
    } catch (error) {
      result.reasons.push(
        error instanceof Error ? error.message : "Runtime reconciliation failed"
      )
    }
    result.actions = result.actions.slice(0, 25)
    result.reasons = result.reasons
      .slice(0, 25)
      .map((reason) => reason.slice(0, 1000))
  }
  if (ids.length > 100)
    sessions.push({
      sessionId: "remaining",
      status: "blocked",
      actions: [],
      reasons: ["Session limit exceeded; select --session explicitly"],
    })
  return {
    recovered: sessions.filter((s) => s.status === "recovered").length,
    skippedActive: sessions.filter((s) => s.status === "skipped-active").length,
    blocked: sessions.filter((s) => s.status === "blocked").length,
    sessions,
  }
}
