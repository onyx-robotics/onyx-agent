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
      'Run `onyx research brief --campaign "$ONYX_CAMPAIGN_NAME" --session "$ONYX_SESSION_ID" --hypothesis "$ONYX_HYPOTHESIS_ID"` for current campaign memory'
    )
    expect(prompt).toContain("single routine context source")
    expect(prompt).toContain("onyx exp list --grep")
    expect(prompt).not.toContain("onyx research status --json")
    expect(prompt).not.toContain("onyx exp list --json")
    expect(prompt).not.toContain("onyx knowledge list --json")
    expect(prompt).not.toContain("onyx summary list --json")
    expect(prompt).toContain("Default to one measured candidate per workflow")
    expect(prompt).toContain(
      "Do not run tuning sweeps, grid searches, or batch candidate evaluation unless your hypothesis plan or the research spec explicitly calls for it"
    )
    expect(prompt).toContain(
      'onyx summary upsert --hypothesis "$ONYX_HYPOTHESIS_ID" --worker "$ONYX_WORKER_ID"'
    )
    expect(prompt).toContain("onyx knowledge add")
    expect(prompt).toContain(
      'onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n> --json'
    )
    expect(prompt).toContain('"shouldStop": true')
    expect(prompt).toContain(
      "stop earlier when the global experiment budget is exhausted"
    )
    expect(prompt).toContain("Make one small, measured, logged attempt early")
    expect(prompt).toContain(
      "Do not spend more than a quick orientation pass before the first `onyx exp run`"
    )
    expect(prompt).toContain(
      "The supervisor fixed this worker's Onyx API target and key in the environment"
    )
    expect(prompt).toContain("Do not run `onyx profile use`")
    expect(prompt).toContain("mutate any global Onyx CLI profile/config files")
    expect(prompt).toContain(
      'onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --auto'
    )
    expect(prompt).toContain("onyx exp run --resume --auto")
    expect(prompt).toContain("onyx workflow status --blocked")
    expect(prompt).toContain('onyx exp log --campaign "$ONYX_CAMPAIGN_NAME"')
    expect(prompt).not.toContain("onyx workflow status --active")
    expect(prompt).not.toContain("<pre-edit-sha>")
    expect(prompt).not.toContain("<workflowRunId>")
    expect(prompt).not.toContain("--run-ref <runRef>")
    expect(prompt).not.toContain("Pick one concrete research idea")
    expect(prompt).toContain(
      "Do not create a new restore-forward or cleanup commit unless it can be measured and logged as a valid one-commit workflow"
    )
    expect(prompt).toContain(
      "allowed only inside a normal `onyx exp run` attempt"
    )
    expect(prompt).toContain("Reserve the final 90 second(s) for shutdown")
    expect(prompt).toContain("Do not edit `.git/onyx/research.db`")
    expect(prompt).toContain("never patch the ledger with SQLite")
    expect(prompt).toContain("Server sync is the supervisor/harness's job")
    expect(prompt).toContain("Do not run `onyx push` or `onyx sync`")
    expect(prompt).toContain("onyx sync status")
    expect(prompt).not.toContain("Supervisor/harness sync owns durable pushes")
    expect(prompt).not.toContain(
      "run `onyx push` only when network access is clearly available"
    )
    expect(prompt).not.toContain("Run `onyx sync` or `onyx push` periodically")
    expect(prompt).toContain("Primary metric is king")
    expect(prompt).toContain("Do not ask whether to continue")
    expect(prompt).not.toContain("Peer hypothesis state")
    expect(prompt).not.toContain("ONYX_BRIEF_FILE")
    expect(prompt).not.toContain(".git/onyx/briefs")
    expect(prompt).not.toContain("ONYX_SESSION_STATE_FILE")
    expect(prompt).not.toContain("session-state")
  })
})
