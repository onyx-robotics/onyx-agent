import { describe, expect, test } from "bun:test"

import { renderHypothesisWorkerPrompt } from "./lib/worker-prompt"

const baseInput = {
  campaignName: "drone-controller",
  goal: "Minimize drone tracking error",
  hypothesisId: "hypothesis_123",
  hypothesisName: "hypothesis-1",
  hypothesisPlan: {
    focus: "Reduce controller overshoot",
    statement: "Smoother gains can reduce tracking error.",
    startingPoints: ["src/controller.ts"],
    avoidList: ["eval changes"],
    successSignals: ["tracking_error decreases"],
    giveUpSignals: ["three attempts regress"],
  },
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
    expect(prompt).toContain(
      "- Session target: keep producing measured attempts until the session-state brief stop guidance asks you to stop"
    )
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
      "Routine session-state brief command: `onyx-worker research session-state-brief --json`"
    )
    expect(prompt).not.toContain("Stop check command")
    expect(prompt).toContain(
      'Campaign brief command for deeper context: `onyx-worker research brief --campaign "$ONYX_CAMPAIGN_NAME" --session "$ONYX_SESSION_ID" --hypothesis "$ONYX_HYPOTHESIS_ID"`'
    )
    expect(prompt).toContain("single routine context source")
    expect(prompt).toContain("onyx-worker exp list --grep")
    expect(prompt).not.toContain("onyx research status --json")
    expect(prompt).not.toContain("onyx exp list --json")
    expect(prompt).not.toContain("onyx knowledge list --json")
    expect(prompt).toContain("Default to one measured candidate per workflow")
    expect(prompt).toContain(
      "Do not run tuning sweeps, grid searches, or batch candidate evaluation unless your hypothesis plan or the research spec explicitly calls for it"
    )
    expect(prompt).not.toContain("onyx-worker summary")
    expect(prompt).toContain("onyx-worker knowledge add")
    expect(prompt).toContain("onyx-worker research session-state-brief --json")
    expect(prompt).not.toContain("onyx-worker research should-stop --json")
    expect(prompt).not.toContain("should-stop")
    expect(prompt).toContain("stop.shouldStopStartingNewWork")
    expect(prompt).toContain("stop.recommendedAction")
    expect(prompt).toContain('recommendedAction` is `"exit"`')
    expect(prompt).toContain('`"finish_current_attempt_then_exit"`')
    expect(prompt).toContain("Do not start another workflow")
    expect(prompt).toContain("Start every loop by running")
    expect(prompt).toContain("After logging, return to step 1")
    expect(prompt).not.toContain("Immediately after logging")
    expect(prompt).toContain(
      "If `onyx-worker exp log` says the attempt was discarded, treat the session as complete"
    )
    expect(prompt).toContain("Make one small, measured, logged attempt early")
    expect(prompt).toContain(
      "Do not spend more than a quick orientation pass before the first `onyx-worker exp run`"
    )
    expect(prompt).toContain(
      "The supervisor launched this worker with `onyx-worker`, `ONYX_WORKER_CONTEXT`, and an isolated `ONYX_HOME`"
    )
    expect(prompt).toContain(
      "the full `onyx` CLI is the user/orchestrator surface"
    )
    expect(prompt).not.toContain("Do not run `onyx profile use`")
    expect(prompt).toContain(
      'onyx-worker exp run --campaign "$ONYX_CAMPAIGN_NAME" --auto'
    )
    expect(prompt).toContain("onyx-worker exp run --resume --auto")
    expect(prompt).toContain(
      "The required order is strict: `exp run --auto`, make exactly one commit, `exp run --resume --auto`, then `exp log`"
    )
    expect(prompt).toContain(
      "Never stack a new experiment commit on top of an unlogged one"
    )
    expect(prompt).toContain(
      "the server records reports first and settles accepted/discarded disposition separately"
    )
    expect(prompt).not.toContain(
      "Do not mark autonomous attempts `accepted` or `rejected`"
    )
    expect(prompt).toContain(
      "If `exp log` says there are zero unlogged attempts, do not amend, reset, or rewrite history"
    )
    expect(prompt).toContain(
      "failed pushes are recorded as local-reported evidence"
    )
    expect(prompt).toContain("onyx-worker workflow status --blocked")
    expect(prompt).toContain(
      'onyx-worker exp log --campaign "$ONYX_CAMPAIGN_NAME"'
    )
    expect(prompt).not.toContain("onyx workflow status --active")
    expect(prompt).not.toContain("<pre-edit-sha>")
    expect(prompt).not.toContain("<workflowRunId>")
    expect(prompt).not.toContain("--run-ref <runRef>")
    expect(prompt).not.toContain("Pick one concrete research idea")
    expect(prompt).toContain(
      "Do not create a new restore-forward or cleanup commit unless it can be measured and logged as a valid one-commit workflow"
    )
    expect(prompt).toContain(
      "allowed only inside a normal `onyx-worker exp run` attempt"
    )
    expect(prompt).toContain("Reserve the final 90 second(s) for shutdown")
    expect(prompt).toContain("Product state is remote-first")
    expect(prompt).toContain("call the Onyx API directly")
    expect(prompt).toContain(
      "attempts to push the immutable experiment ref before it reports"
    )
    expect(prompt).not.toContain("onyx-worker sync status")
    expect(prompt).not.toContain(".git/onyx/research.db")
    expect(prompt).not.toContain("Supervisor/harness sync owns durable pushes")
    expect(prompt).not.toContain(
      "run `onyx push` only when network access is clearly available"
    )
    expect(prompt).not.toContain("Run `onyx sync` or `onyx push` periodically")
    expect(prompt).toContain("Primary metric is king")
    expect(prompt).toContain("Do not ask the user questions")
    expect(prompt).not.toContain("Peer hypothesis state")
    expect(prompt).not.toContain("ONYX_BRIEF_FILE")
    expect(prompt).not.toContain(".git/onyx/briefs")
    expect(prompt).not.toContain("ONYX_SESSION_STATE_FILE")
    expect(prompt).not.toContain("loop-state")
  })
})
