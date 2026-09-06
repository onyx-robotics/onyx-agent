import { afterEach, expect, test } from "bun:test"
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "./git"
import { acquireFileResourceLease, resetResourceLocks } from "./resource-locks"
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "onyx-lock-test-"))
  roots.push(root)
  await git(["init", "--quiet"], root)
  return root
}
function acquire(root: string, ownerId: string, timeoutMs = 10) {
  return acquireFileResourceLease({
    root,
    resourceName: "rig",
    slots: 1,
    timeoutMs,
    leaseMs: 1,
    ownerId,
  })
}
test("expired lease remains exclusive; release is idempotent", async () => {
  const root = await fixture()
  const release = await acquire(root, "first")
  await new Promise((resolve) => setTimeout(resolve, 5))
  await expect(acquire(root, "second")).rejects.toThrow("Timed out")
  await release()
  await release()
  await (
    await acquire(root, "second")
  )()
})
test("dead owners and malformed files are retained until explicit idle reset", async () => {
  const root = await fixture()
  const dir = join(root, ".git/onyx/resource-locks/rig")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "0.json")
  await writeFile(path, "{partial")
  await expect(acquire(root, "other")).rejects.toThrow("locks:")
  expect(await readFile(path, "utf8")).toBe("{partial")
  expect(await resetResourceLocks(root, "rig", true)).toEqual([
    await realpath(path),
  ])
  await resetResourceLocks(root, "rig")
  await (
    await acquire(root, "other")
  )()
})
test("idle reset refuses a live owner", async () => {
  const root = await fixture()
  const release = await acquire(root, "first")
  await expect(resetResourceLocks(root, "rig")).rejects.toThrow("live")
  await release()
})
test("concurrent contenders never acquire more than capacity", async () => {
  const root = await fixture()
  let active = 0
  let maximum = 0
  await Promise.all(
    Array.from({ length: 8 }, async (_, i) => {
      const release = await acquire(root, `owner-${i}`, 2000)
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      await release()
    })
  )
  expect(maximum).toBe(1)
})
