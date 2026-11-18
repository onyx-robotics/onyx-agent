import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { researchConfig, type LoadedConfig } from "./config"
import { setTimeLimit, timeLimits } from "./limits"
import { RunDir } from "./state"

test("a run's time limits start from the config, and change for that run, one endpoint at a time", () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-limits-"))
  const cfg: LoadedConfig = {
    ...researchConfig.parse({
      name: "t",
      goal: "g",
      remote: "../r.git",
      editable: ["a.py"],
      metrics: [{ key: "t.m", better: "higher" }],
      endpoints: [
        { type: "t.fast", label: "fast", guide: "g.md", driver: "x", timeoutS: 120 },
        { type: "t.slow", label: "slow", guide: "g.md", site: true },
      ],
    }),
    root: dir,
    path: join(dir, "research.json"),
  }
  const run = new RunDir(join(dir, "run"))
  expect(timeLimits(run, cfg)).toEqual({ "t.fast": 120, "t.slow": 1800 })

  expect(setTimeLimit(run, cfg, "t.slow", 600)).toEqual({ was: 1800, now: 600 })
  expect(timeLimits(run, cfg)).toEqual({ "t.fast": 120, "t.slow": 600 })
  // another run of the same config starts from the config again
  expect(timeLimits(new RunDir(join(dir, "other")), cfg)).toEqual({ "t.fast": 120, "t.slow": 1800 })

  expect(() => setTimeLimit(run, cfg, "t.none", 60)).toThrow("no endpoint t.none")
})
