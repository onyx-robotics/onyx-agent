import { expect, test } from "bun:test"

import type { RunState, WorkerState } from "../src/research/state"
import { check, normalize } from "./smoke-check"

const worker = (w: Partial<WorkerState>): WorkerState =>
  ({
    task: "t1",
    phase: "done",
    denied: [],
    experiments: [],
    ended: { outcome: "succeeded" },
    ...w,
  }) as WorkerState

const state = (s: Partial<RunState>): RunState =>
  ({ workers: {}, results: {}, varop: { refused: [] }, ...s }) as unknown as RunState

const good = state({
  workers: { t1: worker({}) },
  results: {
    e1: {
      id: "e1",
      task: "t1",
      endpoint: "smoke.bench",
      commit: "abc",
      status: "succeeded",
      outcome: "succeeded",
      metrics: { "smoke.speedup": 40 },
      logTail: "",
      endedAt: 0,
    },
  },
})

const base = { agent: "claude", setupExit: 0, runExit: 0, log: "", agentLogs: {} }

test("a clean run has no findings", () => {
  expect(check({ ...base, state: good })).toEqual([])
})

test("a failed setup is one hard finding, and nothing after it is judged", () => {
  const f = check({ ...base, setupExit: 1, state: null })
  expect(f.map((x) => x.fingerprint)).toEqual(["claude:setup-failed"])
  expect(f[0]!.severity).toBe("hard")
})

test("a run killed at CI's limit is a hang", () => {
  const f = check({ ...base, runExit: 124, state: good })
  expect(f.map((x) => x.fingerprint)).toEqual(["claude:run-hung"])
})

test("no metrics from any experiment is hard", () => {
  const s = state({
    workers: good.workers,
    results: { e1: { ...good.results.e1!, status: "failed", metrics: {} } },
  })
  expect(check({ ...base, state: s }).map((x) => x.fingerprint)).toEqual(["claude:no-measurement"])
})

test("a gate Codex skipped is hard", () => {
  const s = state({
    ...good,
    workers: {
      t1: worker({ ended: { outcome: "failed", reason: "Codex didn't run its hook (…)" } }),
    },
  })
  expect(check({ ...base, agent: "codex", state: s }).map((x) => x.fingerprint)).toEqual([
    "codex:gate-bypassed",
  ])
})

test("trouble in the log is soft, once per kind, and an experiment failing isn't trouble", () => {
  const log = [
    "07:01:02 experiment 1a2b3c4d failed {}",
    "07:01:03 sync: fetch failed after 3 tries",
    "07:01:09 sync: fetch failed after 5 tries",
  ].join("\n")
  const f = check({ ...base, log, state: good })
  expect(f).toHaveLength(1)
  expect(f[0]!.severity).toBe("soft")
  expect(f[0]!.fingerprint).toBe("claude:log:sync: fetch failed after <n> tries")
})

test("normalize takes out times, ids and numbers", () => {
  expect(normalize("12:00:01 worker 3f2a9c1d resumes in smoke.bench (turn 2)")).toBe(
    "worker <id> resumes in smoke.bench (turn <n>)"
  )
})
