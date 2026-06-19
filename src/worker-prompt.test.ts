import { describe, expect, test } from "bun:test"

import { renderLaneWorkerPrompt } from "./lib/worker-prompt"

const baseInput = {
  briefPath: "/repo/.git/onyx/briefs/session/lane.md",
  campaignName: "drone-controller",
  goal: "Minimize drone tracking error",
  laneBranch: "refs/heads/onyx/drone/lane-1",
  laneId: "lane_123",
  laneName: "lane-1",
  lanePlan: {
    focus: "Reduce controller overshoot",
    hypothesis: "Smoother gains can reduce tracking error.",
    startingPoints: ["src/controller.ts"],
    avoidList: ["eval changes"],
    successSignals: ["tracking_error decreases"],
    giveUpSignals: ["three attempts regress"],
  },
  maxIterations: 8,
  metricLabel: "tracking_error (m), minimize",
  minutesRemaining: 10,
  protectedPaths: ["onyx/onyx.md", "onyx/setup.json"],
  setupFilePath: "/repo/onyx/setup.json",
  validationFilePath: "/repo/onyx/validation.json",
  researchSpecPath: "onyx/onyx.md",
  sessionId: "session_123",
  sessionStatePath: null,
}

describe("lane worker prompt", () => {
  test("renders lane context and core loop rules", () => {
    const prompt = renderLaneWorkerPrompt(baseInput)

    expect(prompt).toContain("# Onyx Lane Worker: lane-1")
    expect(prompt).toContain("- Name: drone-controller")
    expect(prompt).toContain("- Metric: tracking_error (m), minimize")
    expect(prompt).toContain("- Setup file: /repo/onyx/setup.json")
    expect(prompt).toContain("- Validation report: /repo/onyx/validation.json")
    expect(prompt).toContain("- Focus: Reduce controller overshoot")
    expect(prompt).toContain("onyx knowledge add")
    expect(prompt).toContain("Primary metric is king")
    expect(prompt).toContain("Do not ask whether to continue")
    expect(prompt).not.toContain("Peer lane state")
  })

  test("includes peer session state when present", () => {
    const prompt = renderLaneWorkerPrompt({
      ...baseInput,
      sessionStatePath: "/repo/.git/onyx/session-state/session_123/lane-1.json",
    })

    expect(prompt).toContain(
      "- Peer lane state: /repo/.git/onyx/session-state/session_123/lane-1.json"
    )
  })
})
