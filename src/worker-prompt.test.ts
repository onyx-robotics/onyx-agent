import { describe, expect, test } from "bun:test"

import { renderHypothesisWorkerPrompt } from "./lib/worker-prompt"

const baseInput = {
  briefPath: "/repo/.git/onyx/briefs/session/hypothesis.md",
  campaignName: "drone-controller",
  goal: "Minimize drone tracking error",
  hypothesisId: "hypothesis_123",
  hypothesisName: "hypothesis-1",
  workerBranch: "onyx/session/hypothesis-1/worker",
  hypothesisPlan: {
    focus: "Reduce controller overshoot",
    statement: "Smoother gains can reduce tracking error.",
    startingPoints: ["src/controller.ts"],
    avoidList: ["eval changes"],
    successSignals: ["tracking_error decreases"],
    giveUpSignals: ["three attempts regress"],
  },
  maxIterations: 8,
  metricLabel: "tracking_error (m), minimize",
  minutesRemaining: 10,
  protectedPaths: ["onyx/onyx.md", "onyx/setup.json"],
  researchDeadlineIso: "2026-06-20T14:08:30.000Z",
  setupFilePath: "/repo/onyx/setup.json",
  shutdownCushionSeconds: 90,
  shutdownDeadlineIso: "2026-06-20T14:10:00.000Z",
  validationFilePath: "/repo/onyx/validation.json",
  researchSpecPath: "onyx/onyx.md",
  sessionId: "session_123",
  sessionStatePath: null,
}

describe("hypothesis worker prompt", () => {
  test("renders hypothesis context and core loop rules", () => {
    const prompt = renderHypothesisWorkerPrompt(baseInput)

    expect(prompt).toContain("# Onyx Hypothesis Worker: hypothesis-1")
    expect(prompt).toContain("- Name: drone-controller")
    expect(prompt).toContain("- Metric: tracking_error (m), minimize")
    expect(prompt).toContain(
      "- Stop starting new research by: 2026-06-20T14:08:30.000Z"
    )
    expect(prompt).toContain(
      "- Final shutdown deadline: 2026-06-20T14:10:00.000Z"
    )
    expect(prompt).toContain("- Setup file: /repo/onyx/setup.json")
    expect(prompt).toContain("- Validation report: /repo/onyx/validation.json")
    expect(prompt).toContain("- Focus: Reduce controller overshoot")
    expect(prompt).toContain("onyx knowledge add")
    expect(prompt).toContain("Make one small, measured, logged attempt early")
    expect(prompt).toContain("Reserve the final 90 second(s) for shutdown")
    expect(prompt).toContain("Primary metric is king")
    expect(prompt).toContain("Do not ask whether to continue")
    expect(prompt).not.toContain("Peer hypothesis state")
  })

  test("includes peer session state when present", () => {
    const prompt = renderHypothesisWorkerPrompt({
      ...baseInput,
      sessionStatePath:
        "/repo/.git/onyx/session-state/session_123/hypothesis-1.json",
    })

    expect(prompt).toContain(
      "- Peer hypothesis state: /repo/.git/onyx/session-state/session_123/hypothesis-1.json"
    )
  })
})
