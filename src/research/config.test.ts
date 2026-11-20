import { expect, test } from "bun:test"

import { checkPack } from "../generated/contracts/registry/pack-format"
import { modelFor, researchConfig, vocabularyOf } from "./config"
import { baseSession, type RunState } from "./state"

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

const minimal = {
  name: "n",
  goal: "g",
  remote: "r",
  editable: ["a.py"],
  metrics: [{ key: "bench.t", better: "lower" }],
  endpoints: [{ type: "bench.sim", label: "l", guide: "g.md", driver: "x" }],
}

test("a run's agents are Claude Code sessions unless its config says, and its models are the CLI's", () => {
  const cfg = researchConfig.parse(minimal)
  expect(cfg.agent).toBe("claude")
  expect(["base", "varop", "worker", "ghost"].map((r) => modelFor(cfg, r as "base"))).toEqual([
    "opus",
    "opus",
    "sonnet",
    "haiku",
  ])
  // one the config sets is its own, and the rest stay the CLI's
  const own = researchConfig.parse({ ...minimal, models: { worker: "opus" } })
  expect([modelFor(own, "worker"), modelFor(own, "ghost")]).toEqual(["opus", "haiku"])
})

test("an agent the runtime can't run is refused when the config is read", () => {
  const r = researchConfig.safeParse({ ...minimal, agent: "amp" })
  expect(r.success).toBe(false)
  expect(JSON.stringify(r.error?.issues)).toContain("agent: one of")
})

test("the base agent's session carries on only in the CLI it's a session of", () => {
  const state = (cli?: string) => ({ base: { agent: "a", session: "s", cli } }) as RunState
  // a run set up before a config could choose has a claude session
  expect(baseSession(state(), { agent: "claude" })).toBe("s")
  expect(() => baseSession(state("claude"), { agent: "codex" })).toThrow(
    "run onyx research setup again"
  )
  expect(() =>
    baseSession({ base: { agent: "a", session: null } } as RunState, { agent: "claude" })
  ).toThrow("run setup first")
})
