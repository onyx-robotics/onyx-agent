import { describe, expect, test } from "bun:test"

import type { ResearchSetupFile } from "./contract"
import {
  hardwareConcurrency,
  parseSimConfig,
  simConfigProblems,
  workflowHardwareResources,
} from "./sim-config"

function setup(overrides: Partial<ResearchSetupFile> = {}): ResearchSetupFile {
  const tool = {
    command: "sh",
    args: [],
    shell: false,
    cwd: "project",
    env: {},
    resources: [] as string[],
    timeoutSeconds: 30,
    leaseTimeoutSeconds: 30,
    outputLimitBytes: 4000,
    fingerprintPaths: [] as string[],
  }
  return {
    schemaVersion: 2,
    goal: "goal",
    projectPath: "",
    scope: { editable: ["src"], protected: [] },
    metric: { name: "error", unit: null, direction: "minimize" },
    resources: { rig: { slots: 1 }, arm: { slots: 2 } },
    tools: {
      sim: tool,
      reset: { ...tool, resources: ["rig"] },
      evaluate: { ...tool, resources: ["arm", "rig"] },
    },
    workflow: [
      { id: "edit", agent: "edit", optional: false },
      { id: "reset", run: "reset", optional: false },
      { id: "evaluate", run: "evaluate", metric: true, optional: false },
    ],
    ...overrides,
  }
}

describe("sim.json", () => {
  test("applies defaults and normalizes paths", () => {
    expect(
      parseSimConfig(JSON.stringify({ tool: "sim", paths: ["./sim/"] }), "x")
    ).toEqual({
      schemaVersion: 1,
      tool: "sim",
      paths: ["sim"],
      source: "agent",
      maxQueuedPerWorker: 1,
    })
  })

  test("rejects unknown fields and escaping paths", () => {
    expect(() =>
      parseSimConfig(JSON.stringify({ tool: "sim", paths: ["sim"], x: 1 }), "x")
    ).toThrow("Invalid x")
    expect(() =>
      parseSimConfig(JSON.stringify({ tool: "sim", paths: ["../sim"] }), "x")
    ).toThrow("project-relative")
  })

  test("reports a simulator that uses hardware, is measured, or is editable", () => {
    const base = setup()
    expect(
      simConfigProblems(base, parseSimConfig('{"tool":"sim","paths":["sim"]}', "x"))
    ).toEqual([])
    const problems = simConfigProblems(
      base,
      parseSimConfig('{"tool":"reset","paths":["src/sim"]}', "x")
    )
    expect(problems.join(" ")).toContain("must not use hardware")
    expect(problems.join(" ")).toContain("also a workflow step")
    expect(problems.join(" ")).toContain("overlaps editable scope src")
    expect(
      simConfigProblems(
        base,
        parseSimConfig('{"tool":"missing","paths":["sim"]}', "x")
      )
    ).toEqual([
      'sim.json tool "missing" is not declared in onyx/setup.json tools.',
    ])
  })

  test("derives hardware resources and concurrency from the workflow", () => {
    expect(workflowHardwareResources(setup())).toEqual(["arm", "rig"])
    expect(hardwareConcurrency(setup())).toBe(1)
    expect(
      hardwareConcurrency(
        setup({ resources: { rig: { slots: 3 }, arm: { slots: 2 } } })
      )
    ).toBe(2)
  })
})
