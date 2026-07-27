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
    const normalizedPrompt = prompt.replaceAll(
      '"$ONYX_WORKER_BIN"',
      "onyx-worker"
    )

    expect(normalizedPrompt).toContain("# Onyx Hypothesis Worker: hypothesis-1")
    expect(normalizedPrompt).toContain("- Name: drone-controller")
    expect(normalizedPrompt).toContain("- Metric: tracking_error (m), minimize")
    expect(normalizedPrompt).toContain(
      "- Stop starting new research by: 2026-06-20T14:08:30.000Z"
    )
    expect(normalizedPrompt).toContain(
      "- Final shutdown deadline: 2026-06-20T14:10:00.000Z"
    )
    expect(normalizedPrompt).toContain(
      "- Session target: keep producing measured attempts until the session-state brief stop guidance asks you to stop"
    )
    expect(normalizedPrompt).toContain(
      "- Worktree root: /repo/.git/onyx/worktrees/session-hypothesis"
    )
    expect(normalizedPrompt).toContain(
      "- Project root: /repo/.git/onyx/worktrees/session-hypothesis"
    )
    expect(normalizedPrompt).toContain(
      "- Setup file: /repo/.git/onyx/worktrees/session-hypothesis/onyx/setup.json"
    )
    expect(normalizedPrompt).toContain(
      "- Validation report (diagnostics only): /repo/.git/onyx/worktrees/session-hypothesis/onyx/validation.json"
    )
    expect(normalizedPrompt).not.toContain(
      "- Validation report (diagnostics only): /repo/onyx/validation.json"
    )
    expect(normalizedPrompt).not.toContain(
      "- Setup file: /repo/onyx/setup.json"
    )
    expect(normalizedPrompt).toContain(
      "- Research spec: /repo/.git/onyx/worktrees/session-hypothesis/onyx/onyx.md"
    )
    expect(normalizedPrompt).toContain("- Focus: Reduce controller overshoot")
    expect(normalizedPrompt).toContain(
      "Treat `/repo/.git/onyx/worktrees/session-hypothesis` as the only project root"
    )
    expect(prompt).toContain(
      'Routine session-state brief command: `"$ONYX_WORKER_BIN" research session-state-brief --json`'
    )
    expect(normalizedPrompt).not.toContain("Stop check command")
    expect(normalizedPrompt).toContain(
      'Campaign brief command for deeper context: `onyx-worker research brief --campaign "$ONYX_CAMPAIGN_NAME" --session "$ONYX_SESSION_ID" --hypothesis "$ONYX_HYPOTHESIS_ID"`'
    )
    expect(normalizedPrompt).toContain("single routine context source")
    expect(normalizedPrompt).toContain("onyx-worker exp list --grep")
    expect(normalizedPrompt).not.toContain("onyx research status --json")
    expect(normalizedPrompt).not.toContain("onyx exp list --json")
    expect(normalizedPrompt).not.toContain("onyx knowledge list --json")
    expect(normalizedPrompt).toContain(
      "Default to one measured candidate per workflow"
    )
    expect(normalizedPrompt).toContain(
      "Do not run tuning sweeps, grid searches, or batch candidate evaluation unless your hypothesis plan or the research spec explicitly calls for it"
    )
    expect(normalizedPrompt).not.toContain("onyx-worker summary")
    expect(normalizedPrompt).toContain("onyx-worker knowledge add")
    expect(normalizedPrompt).toContain(
      "onyx-worker research session-state-brief --json"
    )
    expect(normalizedPrompt).not.toContain(
      "onyx-worker research should-stop --json"
    )
    expect(normalizedPrompt).not.toContain("should-stop")
    expect(normalizedPrompt).toContain("stop.shouldStopStartingNewWork")
    expect(normalizedPrompt).toContain("stop.recommendedAction")
    expect(normalizedPrompt).toContain('recommendedAction` is `"exit"`')
    expect(normalizedPrompt).toContain('`"finish_current_attempt_then_exit"`')
    expect(normalizedPrompt).toContain("Do not start another workflow")
    expect(normalizedPrompt).toContain("Start every loop by running")
    expect(normalizedPrompt).toContain("After logging, return to step 1")
    expect(normalizedPrompt).not.toContain("Immediately after logging")
    expect(normalizedPrompt).toContain(
      "If `onyx-worker exp log` says the attempt was discarded, treat the session as complete"
    )
    expect(normalizedPrompt).toContain(
      "Make one small, measured, logged attempt early"
    )
    expect(normalizedPrompt).toContain(
      "Do not spend more than a quick orientation pass before the first `onyx-worker exp run`"
    )
    expect(normalizedPrompt).toContain(
      "The supervisor launched this worker with `onyx-worker`, `ONYX_WORKER_CONTEXT`, and an isolated `ONYX_HOME`"
    )
    expect(normalizedPrompt).toContain(
      "the full `onyx` CLI is the user/orchestrator surface"
    )
    expect(normalizedPrompt).not.toContain("Do not run `onyx profile use`")
    expect(normalizedPrompt).toContain(
      'onyx-worker exp run --campaign "$ONYX_CAMPAIGN_NAME" --auto'
    )
    expect(normalizedPrompt).toContain("onyx-worker exp run --resume --auto")
    expect(normalizedPrompt).toContain(
      "The required order is strict: `exp run --auto`, make exactly one commit, `exp run --resume --auto`, then `exp log`"
    )
    expect(normalizedPrompt).toContain(
      "Never stack a new experiment commit on top of an unlogged one"
    )
    expect(normalizedPrompt).toContain(
      "the server records reports first and settles accepted/discarded disposition separately"
    )
    expect(normalizedPrompt).not.toContain(
      "Do not mark autonomous attempts `accepted` or `rejected`"
    )
    expect(normalizedPrompt).toContain(
      "If `exp log` says there are zero unlogged attempts, do not amend, reset, or rewrite history"
    )
    expect(normalizedPrompt).toContain(
      "failed pushes are recorded as local-reported evidence"
    )
    expect(normalizedPrompt).toContain("onyx-worker workflow status --blocked")
    expect(normalizedPrompt).toContain(
      'onyx-worker exp log --campaign "$ONYX_CAMPAIGN_NAME"'
    )
    expect(normalizedPrompt).not.toContain("onyx workflow status --active")
    expect(normalizedPrompt).not.toContain("<pre-edit-sha>")
    expect(normalizedPrompt).not.toContain("<workflowRunId>")
    expect(normalizedPrompt).not.toContain("--run-ref <runRef>")
    expect(normalizedPrompt).not.toContain("Pick one concrete research idea")
    expect(normalizedPrompt).toContain(
      "Do not create a new restore-forward or cleanup commit unless it can be measured and logged as a valid one-commit workflow"
    )
    expect(normalizedPrompt).toContain(
      "allowed only inside a normal `onyx-worker exp run` attempt"
    )
    expect(normalizedPrompt).toContain(
      "Reserve the final 90 second(s) for shutdown"
    )
    expect(normalizedPrompt).toContain("Product state is remote-first")
    expect(normalizedPrompt).toContain("call the Onyx API directly")
    expect(normalizedPrompt).toContain(
      "attempts to push the immutable experiment ref before it reports"
    )
    expect(normalizedPrompt).not.toContain("onyx-worker sync status")
    expect(normalizedPrompt).not.toContain(".git/onyx/research.db")
    expect(normalizedPrompt).not.toContain(
      "Supervisor/harness sync owns durable pushes"
    )
    expect(normalizedPrompt).not.toContain(
      "run `onyx push` only when network access is clearly available"
    )
    expect(normalizedPrompt).not.toContain(
      "Run `onyx sync` or `onyx push` periodically"
    )
    expect(normalizedPrompt).toContain("Primary metric is king")
    expect(normalizedPrompt).toContain("Do not ask the user questions")
    expect(normalizedPrompt).not.toContain("Peer hypothesis state")
    expect(normalizedPrompt).not.toContain("ONYX_BRIEF_FILE")
    expect(normalizedPrompt).not.toContain(".git/onyx/briefs")
    expect(normalizedPrompt).not.toContain("ONYX_SESSION_STATE_FILE")
    expect(normalizedPrompt).not.toContain("loop-state")
  })
})
