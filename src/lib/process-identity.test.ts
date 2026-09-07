import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import {
  inspectProcessIdentity,
  processOwnership,
  stopOwnedProcessGroup,
} from "./process-identity"

test("a live process must match captured identity, not just PID", () => {
  const identity = inspectProcessIdentity(process.pid)
  expect(identity).not.toBeNull()
  const record = {
    pid: process.pid,
    ...identity,
    processStartedAt: identity!.startedAt,
    commandIdentity: identity!.command,
  }
  expect(processOwnership(record, true)).toBe("active")
  expect(
    processOwnership({ ...record, commandIdentity: "another process" }, true)
  ).toBe("unknown")
  expect(processOwnership({ pid: process.pid }, true)).toBe("unknown")
  expect(processOwnership({ pid: 0 }, true)).toBe("unknown")
  expect(processOwnership({ pid: -1 }, true)).toBe("unknown")
})

async function managedProcess(ignoreTerm: boolean) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}console.log('ready');setInterval(()=>{},1000)`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] }
  )
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Child readiness timed out")),
        3000
      )
      child.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.stdout!.once("data", () => {
        clearTimeout(timeout)
        resolve()
      })
      child.once("exit", () => {
        clearTimeout(timeout)
        reject(new Error("Child exited before readiness"))
      })
    })
    const identity = inspectProcessIdentity(child.pid!)!
    return {
      child,
      record: {
        pid: child.pid!,
        ...identity,
        processStartedAt: identity.startedAt,
        commandIdentity: identity.command,
      },
    }
  } catch (error) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        /* Child already exited. */
      }
    }
    throw error
  }
}

for (const ignoreTerm of [false, true]) {
  test(`verified group termination ${ignoreTerm ? "escalates after grace" : "exits cooperatively"}`, async () => {
    const { child, record } = await managedProcess(ignoreTerm)
    try {
      expect(await stopOwnedProcessGroup(record, 300)).toBe(true)
      expect(processOwnership(record, true)).toBe("dead")
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-record.pid, "SIGKILL")
        } catch {
          /* Child already exited. */
        }
      }
    }
  })
}

test("uncertain process identity never authorizes group termination", async () => {
  const { child, record } = await managedProcess(false)
  try {
    expect(
      await stopOwnedProcessGroup(
        { ...record, commandIdentity: "unrelated process" },
        0
      )
    ).toBe(false)
    expect(processOwnership(record, true)).toBe("active")
    expect(await stopOwnedProcessGroup(record, 300)).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-record.pid, "SIGKILL")
      } catch {
        /* Child already exited. */
      }
    }
  }
})
