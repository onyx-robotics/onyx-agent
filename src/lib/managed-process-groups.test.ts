import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  reconcileManagedProcessGroups,
  trackManagedProcessGroup,
} from "./managed-process-groups"
import { processExists } from "./process-identity"
import { runProcess } from "./process"

const linuxTest = test.skipIf(process.platform !== "linux")

for (const killParent of [true, false])
  linuxTest(
    `recovery terminates a separately grouped evaluator with ${killParent ? "dead" : "live"} parent`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "onyx-managed-group-"))
      let childPid: number | null = null
      const script = join(root, "parent.ts")
      const context = join(root, "context.json")
      await writeFile(context, "{}", { mode: 0o600 })
      await writeFile(
        script,
        `import {runProcess} from ${JSON.stringify(join(import.meta.dir, "process.ts"))}; await runProcess("bash", ["-c", ${JSON.stringify(`echo $$ > ${join(root, "child.pid")}; exec sleep 60`)}], {timeoutMs: 120000, env: {...process.env, ONYX_WORKER_CONTEXT: ${JSON.stringify(context)}}});`
      )
      const parent = spawn(process.execPath, [script], {
        detached: true,
        stdio: "ignore",
      })
      const exited = new Promise((resolve) => parent.once("exit", resolve))
      try {
        for (let i = 0; i < 100; i++) {
          try {
            childPid = Number(await readFile(join(root, "child.pid"), "utf8"))
            break
          } catch {
            await Bun.sleep(20)
          }
        }
        expect(childPid).toBeTruthy()
        const records = join(root, "process-groups")
        const files = await readdir(records)
        expect(files.length).toBe(1)
        const path = join(records, files[0]!)
        let before = await readFile(path, "utf8")
        for (let i = 0; i < 100 && !JSON.parse(before).startTicks; i++) {
          await Bun.sleep(20)
          before = await readFile(path, "utf8")
        }
        expect(JSON.parse(before).startTicks).toBeTruthy()
        if (killParent) {
          process.kill(-parent.pid!, "SIGKILL")
          await exited
        }
        expect(processExists(childPid!)).toBe("present")
        expect(
          await reconcileManagedProcessGroups(root, { dryRun: true })
        ).toBe(1)
        expect(await readFile(path, "utf8")).toBe(before)
        const changed = { ...JSON.parse(before), startTicks: "0" }
        await writeFile(path, JSON.stringify(changed))
        await expect(
          reconcileManagedProcessGroups(root, { graceMs: 100 })
        ).rejects.toThrow("uncertain")
        expect(processExists(childPid!)).toBe("present")
        await writeFile(path, before)
        expect(
          await reconcileManagedProcessGroups(root, { graceMs: 100 })
        ).toBe(1)
        expect(processExists(childPid!)).toBe("absent")
        await exited
        expect(await readdir(records)).toEqual([])
        expect(
          await reconcileManagedProcessGroups(root, { graceMs: 100 })
        ).toBe(0)
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          process.kill(-parent.pid!, "SIGKILL")
          await exited
        }
        if (childPid) {
          try {
            process.kill(-childPid, "SIGKILL")
          } catch {
            /* The test-owned group has already exited. */
          }
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    10000
  )

linuxTest(
  "interrupted spawn evidence is retained without guessing a process identity",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-managed-pending-"))
    try {
      const tracked = trackManagedProcessGroup(join(root, "context.json"))!
      await expect(
        reconcileManagedProcessGroups(root, { dryRun: true })
      ).rejects.toThrow("uncertain")
      expect((await readdir(join(root, "process-groups"))).length).toBe(1)
      tracked.failedToSpawn()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

linuxTest(
  "ordinary measured commands remove their completed process records",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-managed-complete-"))
    try {
      await mkdir(root, { recursive: true })
      const result = await runProcess("true", [], {
        timeoutMs: 1000,
        env: {
          ...process.env,
          ONYX_WORKER_CONTEXT: join(root, "context.json"),
        },
      })
      expect(result.code).toBe(0)
      expect(await readdir(join(root, "process-groups"))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
