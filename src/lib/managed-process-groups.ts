import { randomUUID } from "node:crypto"
import {
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { linuxBootId } from "./linux-environment"
import { processExists } from "./process-identity"

type Identity = {
  bootId: string | null
  pid: number | null
  startTicks: string | null
}
type GroupRecord = Identity & { schemaVersion: 1; owner: Identity }

function startTicks(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null
  } catch {
    return null
  }
}

function ownership(
  record: Identity,
  group = true
): "active" | "dead" | "unknown" {
  const boot = linuxBootId()
  if (record.bootId && boot && record.bootId !== boot) return "dead"
  if (!record.pid || !record.startTicks || !boot || record.bootId !== boot)
    return "unknown"
  if (startTicks(record.pid) === record.startTicks) return "active"
  return processExists(record.pid) === "absent" &&
    (!group || processExists(-record.pid) === "absent")
    ? "dead"
    : "unknown"
}

/** Persist before spawn so an interrupted launch is uncertain, never invisible.
 * These records deliberately contain no command arguments or environment values. */
export function trackManagedProcessGroup(contextPath: string | undefined) {
  if (process.platform !== "linux" || !contextPath) return null
  if (!isAbsolute(contextPath))
    throw new Error("Worker context must be absolute")
  const directory = join(dirname(contextPath), "process-groups")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (
    realpathSync(directory) !==
    join(realpathSync(dirname(contextPath)), "process-groups")
  )
    throw new Error("Managed process directory escapes worker runtime")
  const path = join(directory, `${randomUUID()}.json`)
  const record: GroupRecord = {
    schemaVersion: 1,
    bootId: linuxBootId(),
    pid: null,
    startTicks: null,
    owner: {
      bootId: linuxBootId(),
      pid: process.pid,
      startTicks: startTicks(process.pid),
    },
  }
  writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 })
  const remove = () => {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return {
    started(pid: number) {
      record.pid = pid
      record.startTicks = startTicks(pid)
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify(record), {
        flag: "wx",
        mode: 0o600,
      })
      renameSync(temporary, path)
    },
    failedToSpawn: remove,
    finished() {
      // The live parent owns this spawn, including very short-lived commands
      // whose /proc identity disappeared before capture.
      if (record.pid && processExists(-record.pid) === "absent") remove()
    },
  }
}

export async function reconcileManagedProcessGroups(
  runtimeDirectory: string,
  { dryRun = false, graceMs = 30_000 } = {}
) {
  if (process.platform !== "linux") return 0
  const directory = join(runtimeDirectory, "process-groups")
  let files: string[]
  try {
    if (
      realpathSync(directory) !==
      join(realpathSync(runtimeDirectory), "process-groups")
    )
      throw new Error("Managed process directory escapes worker runtime")
    files = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw error
  }
  if (files.length > 128)
    throw new Error(
      "Managed process group limit exceeded; retain runtime evidence"
    )
  const deadline = Date.now() + graceMs
  let active = 0
  for (const file of files) {
    const path = join(directory, file)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 4096)
      throw new Error("Unsupported managed process evidence retained")
    const record = JSON.parse(readFileSync(path, "utf8")) as GroupRecord
    if (
      !/^[a-f0-9-]+\.json$/.test(file) ||
      record.schemaVersion !== 1 ||
      !record.bootId ||
      !/^[a-f0-9-]{36}$/.test(record.bootId) ||
      (record.pid !== null &&
        (!Number.isSafeInteger(record.pid) || record.pid <= 0)) ||
      (record.startTicks !== null && !/^\d+$/.test(record.startTicks)) ||
      !record.owner ||
      !record.owner.pid ||
      !Number.isSafeInteger(record.owner.pid) ||
      record.owner.pid <= 0 ||
      record.owner.bootId !== record.bootId ||
      !/^\d+$/.test(record.owner.startTicks ?? "")
    )
      throw new Error("Unsupported managed process evidence retained")
    const state = ownership(record)
    if (state === "active") active++
    const ownerState = ownership(record.owner, false)
    if (record.owner.pid === process.pid || ownerState === "unknown")
      throw new Error(
        "Managed evaluator parent ownership is uncertain; retain runtime evidence"
      )
    if (state === "unknown")
      throw new Error(
        `Managed process group ${record.pid ?? "launch"} ownership is uncertain; retain runtime evidence`
      )
    if (dryRun) continue
    const targets = [
      { identity: record.owner, group: false },
      { identity: record, group: true },
    ]
    for (const target of targets) {
      if (ownership(target.identity, target.group) === "active")
        process.kill(
          target.group ? -target.identity.pid! : target.identity.pid!,
          "SIGTERM"
        )
    }
    while (
      Date.now() < deadline &&
      targets.some(
        (target) => ownership(target.identity, target.group) !== "dead"
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 50))
    for (const target of targets) {
      if (ownership(target.identity, target.group) === "active")
        process.kill(
          target.group ? -target.identity.pid! : target.identity.pid!,
          "SIGKILL"
        )
    }
    for (
      let i = 0;
      i < 20 &&
      targets.some(
        (target) => ownership(target.identity, target.group) !== "dead"
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 50))
    if (
      targets.some(
        (target) => ownership(target.identity, target.group) !== "dead"
      )
    )
      throw new Error(
        `Managed process group ${record.pid} or its parent has surviving or uncertain descendants; retain runtime evidence`
      )
    unlinkSync(path)
  }
  if (!dryRun && readdirSync(directory).length)
    throw new Error(
      "New managed process evidence appeared during recovery; retain it and retry"
    )
  return active
}
