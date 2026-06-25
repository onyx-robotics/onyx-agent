import { describe, expect, test } from "bun:test"

import { renderHypothesisWorkerPrompt } from "./lib/worker-prompt"

const baseInput = {
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
  projectRoot: "/repo/.git/onyx/worktrees/session-hypothesis",
  researchDeadlineIso: "2026-06-20T14:08:30.000Z",
  setupFilePath: "/repo/.git/onyx/worktrees/session-hypothesis/onyx/setup.json",
  shutdownCushionSeconds: 90,
  shutdownDeadlineIso: "2026-06-20T14:10:00.000Z",
  validationFilePath:
    "/repo/.git/onyx/worktrees/session-hypothesis/onyx/validation.json",
  researchSpecPath: "/repo/.git/onyx/worktrees/session-hypothesis/onyx/onyx.md",
  sessionId: "session_123",
  worktreeRoot: "/repo/.git/onyx/worktrees/session-hypothesis",
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
    expect(prompt).toContain("- Per-worker iteration cap: 8 maximum")
    expect(prompt).toContain(
      "- Worktree root: /repo/.git/onyx/worktrees/session-hypothesis"
    )
    expect(prompt).toContain(
      "- Project root: /repo/.git/onyx/worktrees/session-hypothesis"
    )
    expect(prompt).toContain(
      "- Setup file: /repo/.git/onyx/worktrees/session-hypothesis/onyx/setup.json"
    )
    expect(prompt).toContain(
      "- Validation report (diagnostics only): /repo/.git/onyx/worktrees/session-hypothesis/onyx/validation.json"
    )
    expect(prompt).not.toContain(
      "- Validation report (diagnostics only): /repo/onyx/validation.json"
    )
    expect(prompt).not.toContain("- Setup file: /repo/onyx/setup.json")
    expect(prompt).toContain(
      "- Research spec: /repo/.git/onyx/worktrees/session-hypothesis/onyx/onyx.md"
    )
    expect(prompt).toContain("- Focus: Reduce controller overshoot")
    expect(prompt).toContain(
      "Treat `/repo/.git/onyx/worktrees/session-hypothesis` as the only project root"
    )
    expect(prompt).toContain(
      'Campaign brief command: `onyx research brief --campaign "$ONYX_CAMPAIGN_NAME" --session "$ONYX_SESSION_ID" --hypothesis "$ONYX_HYPOTHESIS_ID"`'
    )
    expect(prompt).toContain(
      'Run `onyx research brief --campaign "$ONYX_CAMPAIGN_NAME" --session "$ONYX_SESSION_ID" --hypothesis "$ONYX_HYPOTHESIS_ID"` first'
    )
    expect(prompt).toContain("onyx research status --json")
    expect(prompt).toContain("onyx exp list --json")
    expect(prompt).toContain("onyx knowledge list --json")
    expect(prompt).toContain("onyx summary list --json")
    expect(prompt).toContain("In `single_candidate` mode")
    expect(prompt).toContain(
      'onyx summary upsert --hypothesis "$ONYX_HYPOTHESIS_ID" --worker "$ONYX_WORKER_ID"'
    )
    expect(prompt).toContain("onyx knowledge add")
    expect(prompt).toContain(
      'onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n> --json'
    )
    expect(prompt).toContain('"shouldStop": true')
    expect(prompt).toContain("maximum cap, not a target count")
    expect(prompt).toContain("Make one small, measured, logged attempt early")
    expect(prompt).toContain("Start the first measured workflow early")
    expect(prompt).toContain(
      "do not create an unmeasured restore-forward commit outside `onyx exp run`"
    )
    expect(prompt).toContain(
      "allowed only inside a normal `onyx exp run` attempt"
    )
    expect(prompt).toContain("Reserve the final 90 second(s) for shutdown")
    expect(prompt).toContain("Supervisor/harness sync owns durable pushes")
    expect(prompt).toContain("onyx sync status")
    expect(prompt).toContain(
      "run `onyx push` only when network access is clearly available"
    )
    expect(prompt).not.toContain(
      "Run `onyx sync` or `onyx push` periodically"
    )
    expect(prompt).toContain("Primary metric is king")
    expect(prompt).toContain("Do not ask whether to continue")
    expect(prompt).not.toContain("Peer hypothesis state")
    expect(prompt).not.toContain("ONYX_BRIEF_FILE")
    expect(prompt).not.toContain(".git/onyx/briefs")
    expect(prompt).not.toContain("ONYX_SESSION_STATE_FILE")
    expect(prompt).not.toContain("session-state")
  })
})
