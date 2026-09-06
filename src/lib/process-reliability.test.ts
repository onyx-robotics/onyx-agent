import { expect, test } from "bun:test"
import { runProcess } from "./process"

test("spawn failures reject without leaving timeout work behind", async () => {
  await expect(
    runProcess("/does-not-exist/onyx", [], { timeoutMs: 100 })
  ).rejects.toThrow()
})

test("timeout escalates and waits for a TERM-resistant process", async () => {
  const started = Date.now()
  const result = await runProcess(
    "sh",
    ["-c", "trap '' TERM; while :; do sleep 0.1; done"],
    { timeoutMs: 100, killGraceMs: 100 }
  )
  expect(result.timedOut).toBe(true)
  expect(Date.now() - started).toBeGreaterThanOrEqual(190)
  expect(result.code).not.toBe(0)
})

test("shell descendants with redirected stdio are terminated or retain exclusion", async () => {
  const result = await runProcess(
    "sh",
    ["-c", "sleep 20 >/dev/null 2>&1 & echo $!"],
    { timeoutMs: 500, killGraceMs: 50 }
  )
  const descendant = Number(result.stdout.trim())
  let alive = true
  try {
    process.kill(descendant, 0)
  } catch (error) {
    alive = (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
  expect(!alive || result.protectionUncertain).toBe(true)
})
