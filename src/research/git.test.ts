import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { changedPaths, git, measurementOf } from "./git"

test("a change to the measurement is seen, and only it changes a commit's measurement", () => {
  const repo = mkdtempSync(join(tmpdir(), "onyx-git-"))
  git(repo, "init", "--quiet")
  mkdirSync(join(repo, "onyx", "endpoints"), { recursive: true })
  writeFileSync(join(repo, "onyx", "endpoints", "bench.py"), "score = time\n")
  writeFileSync(join(repo, "solver.py"), "v1\n")
  const commit = (m: string) => {
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", m)
    return git(repo, "rev-parse", "HEAD")
  }
  const base = commit("base")
  const paths = ["onyx/endpoints"]

  // the method changes: not the measurement
  writeFileSync(join(repo, "solver.py"), "v2\n")
  expect(changedPaths(repo, base, paths)).toEqual([])
  const method = commit("method")
  expect(measurementOf(repo, method, paths)).toBe(measurementOf(repo, base, paths))

  // a file edited, and one added, under the measurement: both seen before they're committed
  writeFileSync(join(repo, "onyx", "endpoints", "bench.py"), "score = time * 2\n")
  writeFileSync(join(repo, "onyx", "endpoints", "data.json"), "{}\n")
  expect(changedPaths(repo, base, paths).sort()).toEqual([
    "onyx/endpoints/bench.py",
    "onyx/endpoints/data.json",
  ])
  const measured = commit("measurement")
  expect(measurementOf(repo, measured, paths)).not.toBe(measurementOf(repo, base, paths))
})
