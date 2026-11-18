import { expect, test } from "bun:test"

import { checkPack } from "../generated/contracts/registry/pack-format"
import { researchConfig, vocabularyOf } from "./config"

test("a config's endpoints and metrics, as the definitions the run adds to the org", () => {
  const cfg = researchConfig.parse({
    name: "n",
    goal: "g",
    remote: "r",
    editable: ["a.py"],
    evaluate: "true",
    metrics: [
      { key: "bench.total_time_s", better: "lower", unit: "s" },
      { key: "bench.poses", better: "higher", label: "Poses reached" },
    ],
    endpoints: [
      { type: "bench.sim", label: "the sim, run by a site", guide: "g.md", site: true },
      { type: "bench.sim", label: "again", guide: "g.md", driver: "x" },
    ],
  })
  const v = vocabularyOf(cfg)
  expect(v.types).toEqual([
    {
      key: "bench.sim",
      kind: "asset",
      parent: "research_endpoint",
      label: "Bench sim",
      description: "the sim, run by a site",
    },
  ])
  expect(v.properties.map((p) => [p.key, p.label, p.unit, p.better])).toEqual([
    ["bench.total_time_s", "Total time s", "s", "lower"],
    ["bench.poses", "Poses reached", undefined, "higher"],
  ])
  // what the server checks them against
  expect("pack" in checkPack({ key: "bench", version: 1, ...v })).toBe(true)
})
