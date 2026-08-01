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

  test("renders static env-driven context and core loop rules", async () => {
    const prompt = await readHypothesisWorkerPrompt()
    const normalizedPrompt = prompt.replaceAll(
      '"$ONYX_WORKER_BIN"',
      "onyx-worker"
    )

    // Fully static: no interpolated values anywhere.
    expect(prompt).not.toContain("${")
    expect(normalizedPrompt).toContain("# Onyx Hypothesis Worker")

    // The brief is the single bootstrap context source; no values are inlined.
    expect(normalizedPrompt).toContain(
      "Run `onyx-worker research session-state-brief --json` before anything else"
    )
    expect(normalizedPrompt).toContain("single routine context source")
    expect(normalizedPrompt).toContain("`currentHypothesis`")
    expect(normalizedPrompt).toContain(
      'onyx-worker research brief --campaign "$ONYX_CAMPAIGN_NAME" --session "$ONYX_SESSION_ID" --hypothesis "$ONYX_HYPOTHESIS_ID"'
    )
    expect(normalizedPrompt).not.toContain("- Name:")
    expect(normalizedPrompt).not.toContain("- Metric:")
    expect(normalizedPrompt).not.toContain("- Focus:")
    expect(normalizedPrompt).not.toContain("Hypothesis Plan")
    expect(normalizedPrompt).not.toContain("Time budget remaining at launch")

    // Environment references replace interpolated values and stay re-readable.
    expect(normalizedPrompt).toContain("`$ONYX_PROJECT_ROOT`")
    expect(normalizedPrompt).toContain("`$ONYX_SETUP_FILE` (schema v2)")
    expect(normalizedPrompt).toContain("`$ONYX_RESEARCH_SPEC_FILE`")
    expect(normalizedPrompt).toContain(
      "`$ONYX_VALIDATION_FILE` is diagnostics only"
    )
    expect(normalizedPrompt).toContain(
      "Treat `$ONYX_PROJECT_ROOT` as the only project root"
    )
    expect(normalizedPrompt).toContain(
      "stable for your whole session"
    )
    expect(normalizedPrompt).toContain(
      "Reserve the final `$ONYX_SHUTDOWN_CUSHION_SECONDS` second(s) for shutdown"
    )
    expect(normalizedPrompt).toContain(
      "exit before `$ONYX_SHUTDOWN_DEADLINE_AT`"
    )
    expect(normalizedPrompt).toContain(
      "Do not start new exploration after `$ONYX_RESEARCH_DEADLINE_AT`"
    )

    expect(normalizedPrompt).toContain(
      "The supervisor launched this worker with `onyx-worker`, `ONYX_WORKER_CONTEXT`, and an isolated `ONYX_HOME`"
    )
    expect(normalizedPrompt).toContain(
      "the full `onyx` CLI is the user/orchestrator surface"
    )
    expect(normalizedPrompt).toContain("must not be edited during Research")
    expect(normalizedPrompt).toContain("`scope.protected`")

    // Stop guidance contract.
    expect(normalizedPrompt).toContain("Start every loop by running")
    expect(normalizedPrompt).toContain("stop.shouldStopStartingNewWork")
    expect(normalizedPrompt).toContain("stop.recommendedAction")
    expect(normalizedPrompt).toContain('recommendedAction` is `"exit"`')
    expect(normalizedPrompt).toContain('`"finish_current_attempt_then_exit"`')
    expect(normalizedPrompt).toContain("Do not start another workflow")

    // Core workflow loop.
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
    expect(normalizedPrompt).toContain("After logging, return to step 1")
    expect(normalizedPrompt).toContain(
      "If `exp log` refuses because no measured attempt exists, do not amend, reset, or rewrite history"
    )
    expect(normalizedPrompt).toContain(
      "If `onyx-worker exp log` says the attempt was discarded, treat the session as complete"
    )
    expect(normalizedPrompt).toContain("onyx-worker workflow status --blocked")
    expect(normalizedPrompt).toContain("onyx-worker tools run <tool-name>")
    expect(normalizedPrompt).toContain(
      'onyx-worker exp log --campaign "$ONYX_CAMPAIGN_NAME"'
    )
    expect(normalizedPrompt).toContain("onyx-worker exp list --grep")
    expect(normalizedPrompt).toContain("onyx-worker knowledge add")

    // Research rules.
    expect(normalizedPrompt).toContain("Primary metric is king")
    expect(normalizedPrompt).toContain(
      "Make one small, measured, logged attempt early"
    )
    expect(normalizedPrompt).toContain(
      "Do not spend more than a quick orientation pass before the first `onyx-worker exp run`"
    )
    expect(normalizedPrompt).toContain(
      "Default to one measured candidate per workflow"
    )
    expect(normalizedPrompt).toContain(
      "Do not run tuning sweeps, grid searches, or batch candidate evaluation unless your hypothesis plan or the research spec explicitly calls for it"
    )
    expect(normalizedPrompt).toContain(
      "the server records reports first and settles accepted/discarded disposition separately"
    )
    expect(normalizedPrompt).toContain("Do not ask the user questions")

    // Git and state rules.
    expect(normalizedPrompt).toContain(
      "Do not create a new restore-forward or cleanup commit unless it can be measured and logged as a valid one-commit workflow"
    )
    expect(normalizedPrompt).toContain(
      "allowed only inside a normal `onyx-worker exp run` attempt"
    )
    expect(normalizedPrompt).toContain("Product state is remote-first")
    expect(normalizedPrompt).toContain("call the Onyx API directly")
    expect(normalizedPrompt).toContain(
      "attempts to push the immutable experiment ref before it reports"
    )
    expect(normalizedPrompt).toContain(
      "failed pushes are recorded as local-reported evidence"
    )

    // Removed legacy surfaces stay removed.
    expect(normalizedPrompt).not.toContain("should-stop")
    expect(normalizedPrompt).not.toContain("onyx-worker sync status")
    expect(normalizedPrompt).not.toContain(".git/onyx/research.db")
    expect(normalizedPrompt).not.toContain("loop-state")
  })
})
