import { readFile } from "node:fs/promises"

import { describe, expect, test } from "bun:test"

import {
  packagedHypothesisWorkerPromptPath,
  readHypothesisWorkerPrompt,
} from "./lib/worker-prompt"
import { HYPOTHESIS_WORKER_PROMPT_MARKDOWN } from "./lib/worker-prompt-content"

describe("hypothesis worker prompt", () => {
  test("embedded release prompt matches canonical prompt markdown", async () => {
    expect(HYPOTHESIS_WORKER_PROMPT_MARKDOWN).toBe(
      await readFile(packagedHypothesisWorkerPromptPath(), "utf8")
    )
  })

  test("renders a static, env-free contract and core loop rules", async () => {
    const prompt = await readHypothesisWorkerPrompt()

    // Fully static and environment-free: no interpolation, no env vars, no
    // identity flags. Identity and deadlines flow through the worker runtime
    // context and the session-state brief instead.
    expect(prompt).not.toContain("${")
    expect(prompt).not.toContain("$ONYX_")
    expect(prompt).not.toContain("ONYX_WORKER_BIN")
    expect(prompt).not.toContain("--campaign")
    expect(prompt).not.toContain("--session")
    expect(prompt).not.toContain("--hypothesis ")
    expect(prompt).toContain("# Onyx Research Worker")
    expect(prompt).toContain(
      "it already knows your campaign, session, hypothesis, and worker identity"
    )

    // The brief is the single bootstrap context source; no values are inlined.
    expect(prompt).toContain(
      "Run `onyx-worker research session-state-brief --json` before anything else"
    )
    expect(prompt).toContain("single routine context source")
    expect(prompt).toContain("`currentHypothesis`")
    expect(prompt).toContain("run `onyx-worker research brief` for a fuller prose brief")
    expect(prompt).not.toContain("- Name:")
    expect(prompt).not.toContain("- Metric:")
    expect(prompt).not.toContain("- Focus:")
    expect(prompt).not.toContain("Hypothesis Plan")
    expect(prompt).not.toContain("Time budget remaining at launch")

    // The project root is the working directory and the onyx/ directory is
    // the setup surface — no file-path env vars.
    expect(prompt).toContain(
      "Your working directory is the project root, inside a detached disposable worktree"
    )
    expect(prompt).toContain("`onyx/setup.json` — the local setup policy")
    expect(prompt).toContain("`onyx/onyx.md`")
    expect(prompt).toContain("`onyx/validation.json` — diagnostics only")
    expect(prompt).toContain(
      "Treat your working directory — the project root — as the only root"
    )

    expect(prompt).toContain(
      "The supervisor launched this worker with `onyx-worker` on `PATH`, `ONYX_WORKER_CONTEXT`, and an isolated `ONYX_HOME`"
    )
    expect(prompt).toContain(
      "The full `onyx` CLI is the user/orchestrator surface"
    )
    expect(prompt).toContain("must not be edited during Research")
    expect(prompt).toContain("`scope.protected`")

    // Stop guidance contract, including brief-carried time budget.
    expect(prompt).toContain("Start every loop by running")
    expect(prompt).toContain("stop.shouldStopStartingNewWork")
    expect(prompt).toContain("stop.recommendedAction")
    expect(prompt).toContain("stop.secondsRemaining")
    expect(prompt).toContain("stop.researchDeadlineAt")
    expect(prompt).toContain("stop.shutdownCushionSeconds")
    expect(prompt).toContain("stop.shutdownDeadlineAt")
    expect(prompt).toContain('recommendedAction` is `"exit"`')
    expect(prompt).toContain('`"finish_current_attempt_then_exit"`')
    expect(prompt).toContain("Do not start another workflow")

    // Core workflow loop, flagless.
    expect(prompt).toContain("onyx-worker exp run --auto")
    expect(prompt).toContain("onyx-worker exp run --resume --auto")
    expect(prompt).toContain(
      "The required order is strict: `exp run --auto`, make exactly one commit, `exp run --resume --auto`, then `exp log`"
    )
    expect(prompt).toContain(
      "Never stack a new experiment commit on top of an unlogged one"
    )
    expect(prompt).toContain("After logging, return to step 1")
    expect(prompt).toContain(
      "If `exp log` refuses because no measured attempt exists, do not amend, reset, or rewrite history"
    )
    expect(prompt).toContain(
      "If `onyx-worker exp log` says the attempt was discarded, treat the session as complete"
    )
    expect(prompt).toContain("onyx-worker workflow status --blocked")
    expect(prompt).toContain("onyx-worker tools run <tool-name>")
    expect(prompt).toContain("onyx-worker exp log --name")
    expect(prompt).toContain("onyx-worker exp list --grep")
    expect(prompt).toContain("onyx-worker knowledge add")

    // Research rules.
    expect(prompt).toContain("Primary metric is king")
    expect(prompt).toContain("Make one small, measured, logged attempt early")
    expect(prompt).toContain(
      "Do not spend more than a quick orientation pass before the first `onyx-worker exp run`"
    )
    expect(prompt).toContain("Default to one measured candidate per workflow")
    expect(prompt).toContain(
      "Do not run tuning sweeps, grid searches, or batch candidate evaluation unless your hypothesis plan or the research spec explicitly calls for it"
    )
    expect(prompt).toContain(
      "the server records reports first and settles accepted/discarded disposition separately"
    )
    expect(prompt).toContain("Do not ask the user questions")

    // Git and state rules.
    expect(prompt).toContain(
      "Do not create a new restore-forward or cleanup commit unless it can be measured and logged as a valid one-commit workflow"
    )
    expect(prompt).toContain(
      "allowed only inside a normal `onyx-worker exp run` attempt"
    )
    expect(prompt).toContain("Product state is remote-first")
    expect(prompt).toContain("call the Onyx API directly")
    expect(prompt).toContain(
      "attempts to push the immutable experiment ref before it reports"
    )
    expect(prompt).toContain(
      "failed pushes are recorded as local-reported evidence"
    )

    // Removed legacy surfaces stay removed.
    expect(prompt).not.toContain("should-stop")
    expect(prompt).not.toContain("onyx-worker sync status")
    expect(prompt).not.toContain(".git/onyx/research.db")
    expect(prompt).not.toContain("loop-state")
  })
})
