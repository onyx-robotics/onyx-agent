import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { linuxBootId } from "./linux-environment"

export type ProcessEvidence = {
  pid?: number | null
  bootId?: string | null
  processStartTicks?: string | null
  processStartedAt?: string | null
  commandIdentity?: string | null
}

function startTicks(pid: number) {
  if (process.platform !== "linux") return null
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null
}

export function inspectProcessIdentity(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const ticks = startTicks(pid)
    const inspect = (field: string) => {
      const result = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], {
        encoding: "utf8",
        timeout: 2000,
      })
      return !result.error && result.status === 0 ? result.stdout.trim() : ""
    }
    const startedAt = inspect("lstart")
    const command = inspect("command")
    if (!startedAt || !command || startTicks(pid) !== ticks) return null
    return {
      startedAt,
      command,
      bootId: linuxBootId(),
      processStartTicks: ticks,
    }
  } catch {
    return null
  }
}

export function processExists(pid: number): "present" | "absent" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid === 0) return "unknown"
  try {
    process.kill(pid, 0)
    return "present"
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "absent"
      : "unknown"
  }
}

export function processOwnership(
  record: ProcessEvidence,
  group = false
): "active" | "dead" | "unknown" {
  const boot = linuxBootId()
  if (record.bootId && !/^[a-f0-9-]{36}$/.test(record.bootId)) return "unknown"
  if (record.bootId && boot && record.bootId !== boot) return "dead"
  if (!record.pid || !Number.isSafeInteger(record.pid) || record.pid <= 0)
    return "unknown"
  if (!record.processStartedAt || !record.commandIdentity) return "unknown"
  const identity = inspectProcessIdentity(record.pid)
  if (identity) {
    if (record.bootId && (!boot || boot !== record.bootId)) return "unknown"
    if (
      record.processStartTicks &&
      identity.processStartTicks !== record.processStartTicks
    )
      return "unknown"
    return record.processStartedAt === identity.startedAt &&
      record.commandIdentity === identity.command
      ? "active"
      : "unknown"
  }
  if (processExists(record.pid) !== "absent") return "unknown"
  // An exited group leader says nothing about its surviving descendants.
  if (group && processExists(-record.pid) !== "absent") return "unknown"
  return "dead"
}

/** Only signal a currently verified group leader. A surviving group after
 * leader exit remains blocked: never signal a reused process group blindly. */
export async function stopOwnedProcessGroup(
  record: ProcessEvidence,
  graceMs = 30_000
) {
  if (processOwnership(record, true) === "dead") return true
  if (processOwnership(record, true) !== "active" || !record.pid) return false
  try {
    process.kill(-record.pid, "SIGTERM")
  } catch {
    return false
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (processOwnership(record, true) === "dead") return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (processOwnership(record, true) !== "active") return false
  try {
    process.kill(-record.pid, "SIGKILL")
  } catch {
    return false
  }
  for (let i = 0; i < 20; i++) {
    if (processOwnership(record, true) === "dead") return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}
