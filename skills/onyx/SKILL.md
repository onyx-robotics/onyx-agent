---
name: onyx
description: Coordinate the Onyx parallel auto research workflow. Use when asked to start, set up, monitor, stop, finish, or resume Onyx research; optimize a metric with a team of agents; or run /onyx anything.
---

# Onyx Parallel Auto Research

You are the main-thread Onyx orchestrator. The user talks to you. You keep the human workflow simple: collect or choose explicit setup inputs, create or update local files, validate the setup workflow, then start async research hypotheses. The overall research process consists of two phases:

1. Setup
2. Research

## Setup

The setup phase is a one-time critical process for a research campaign where you will build the tools and workflow to be used by the parallel research worker agents. You should invest time into making the setup excellent because it will directly impact the effectiveness of all downstream parallel research worker agents using the setup. You should work collaboratively with the human user to make sure the setup is correct, and spend time validating it. Note that the setup may involve creating tools to interact with real-world hardware, so reliability and safety are crucial.

1. Ask or infer from the user:
   - **Goal**
   - **Metric**, **unit** (make sure this is a real unit like time `s`, `ms`, `us` that can be formatted with the metric), **direction** (`maximize` or `minimize`)
   - **Evaluation** commands and tools
   - **Editable scope** and **Protected scope**
   - **Reliability**, **safety**, and other **constraint** tools and workflow steps to make sure research can be run for long periods of time with proper readiness checks/guardrails, ability to recover from issues, and thorough safety.
   - **Reset** tools and workflow steps to ensure the environment is reset before each experiment
   - **Resources** such as compute/cpu/gpu or real-world hardware
   - **Agent worker count**
   - **Budget**
   - **Hypotheses** (if the user has any)
2. Create the local setup surface with `onyx setup init`; pass `--editable-scope` or `--eval-command` only when you want those exact caller-provided values written into the scaffold. Then edit `onyx/setup.json`, `onyx/onyx.md`, and `onyx/tools/*` as needed. The default eval tool is `onyx/tools/evaluation/run.sh` and remains failing until deliberately configured. See the Setup Surface section below for more information before making edits.
3. Encode reset, readiness, safety, reliability, and hardware/service work as declared `setup.tools` entries and linear `workflow` command steps. Keep exactly one leading agent step and exactly one required `metric: true` command step.
4. Run `onyx setup validate`. Setup validation executes the required metric tool once, requires exactly one primary `METRIC <name>=<number>` line, and records readiness evidence in `onyx/validation.json`. Review the `metric_tool_readiness` check before committing. Failed or stale validation blocks campaign setup and research run; warning checks do not.
5. Commit the setup surface with `git add <setup-dir> && git commit -m "Add Onyx setup"` where `<setup-dir>` is `onyx` at repo root or `<projectPath>/onyx` in a monorepo; `onyx campaign setup` and `onyx research run` require the committed campaign base to contain the setup files.
6. Push the setup base commit to the repository remote with `git push origin HEAD` before campaign sync. The generic CLI warns instead of auto-pushing, but this orchestrated skill should push so GitHub-backed campaign creation can verify the base commit.
7. Run `onyx campaign setup --name <slug> --description <goal>`, then `onyx sync` if needed.
8. Move on to the Research phase after the setup surface has been built out and approved by the human user.

### Setup Surface

`onyx/setup.json` declares goal, metric, project path, editable scope, protected paths, resources, declared tools, and the linear experiment workflow. It is the only setup policy file.

`onyx/validation.json` is the latest local validation report. It stores a setup hash, setup checks, and metric-tool readiness evidence. It is evidence, not security. Research run blocks when validation is stale, any check failed, or `metric_tool_readiness` is missing.

`onyx/onyx.md` is a markdown file intended to provide the worker agent with the research spec and specific notes on the project/setup. The worker agent will already have instructions on how to conduct its auto research, editable/protected scope, git/onyx rules, campaign related inputs/id/names, and how to use the CLI tools. The `onyx/onyx.md` should cover more specific insights on this specific project and setup that are more nuanced.

The setup surface must be committed before campaign creation and session start. This makes every worker worktree start from a campaign base that contains the same frozen setup, validation report, research spec, and workflow tools.

Workflow v1 is strict and linear: one workflow run is one experiment attempt, one result commit, and one primary metric. Tool and step IDs are lowercase path-safe namespaced strings such as `evaluation.run`, `reset.clean`, and `reliability.check`.

Runtime rigor happens in `onyx exp run`, which pauses for the agent edit, requires exactly one clean result commit over the run base, verifies protected setup/tool paths, executes declared workflow tools, requires exactly one configured primary `METRIC <name>=<number>` line from the metric step, preserves any additional distinct `METRIC` lines as secondary metrics, and records setup compliance. Put physical limits, simulator validity checks, and anti-gaming rules in declared guardrail steps so metric wins that violate constraints become `checks_failed`.

Tool commands in `onyx/setup.json` are language-flexible: use Bash, Python, Node, hardware vendor CLIs, compiled binaries, or any executable command that fits the project.

Protected setup paths are frozen during Research: `onyx/setup.json`, `onyx/validation.json`, `onyx/onyx.md`, and `onyx/tools/*`.

## Research

The research phase begins after you have completed the setup phase. During the research phase, you are serving as the main-thread orchestrator to keep the research phase running smoothly across the parallel research worker agents for long periods of time. The human user may interact with you, asking questions or asking you to take actions on the research process. Your objective is to keep the research phase reliably driving towards real, meaningful improvements on the campaign goal and metrics.

1. Start the supervisor with inline JSON: `onyx research run --campaign <slug> --workers <n> --agent codex|claude --hypotheses '<json-array>'`. Treat `--workers` as the active slot target and `--max-iterations` as a maximum cap, not target counts. Use `--max-launches <n>` only for bounded smoke/custom runs where fast workers should not be backfilled. Use `onyx research hypotheses --example` as a setup-aware template when drafting initial hypotheses, then pass the JSON array inline. The supervisor owns local worker scheduling, shared sync, presence updates, and final sync; use `--worker-command` only when a custom worker process is needed.
2. Monitor with `onyx research status`, `onyx research status --json`, `onyx listen`, and the web campaign page. Use `onyx research status --reconcile` only when you intentionally want lifecycle repair. Review experiments, worker summaries, and knowledge, then create fresh hypotheses with `onyx research hypothesis add --session <id> --focus <text> --hypothesis <text>` or `--plan <json-file>` whenever the campaign needs another option; the running supervisor will pick up active hypotheses when worker slots open.
3. Stop with `onyx research stop --session <id>`.
4. Finish with `onyx research finish --campaign <slug>`, confirm the final sync counts printed by the command, then report local extraction branches and the best result.

### Hypothesis Worker Agents

`onyx research run` is the normal local path: it creates or attaches to a session, maintains the requested worker target, schedules active hypotheses, sends coalesced presence updates, and drains durable sync events through one supervisor process. Pass `--max-launches <n>` when a single supervisor invocation should stop after launching a fixed number of workers, especially with fast `--worker-command` smoke tests. `onyx worker run` remains a low-level debugging and recovery primitive. `onyx research hypothesis add` creates campaign hypotheses during or between sessions; it accepts `--plan <json-file>` or inline `--focus`, `--hypothesis`, repeated `--starting-point`, `--avoid`, `--success`, and `--give-up` flags. Successor hypothesis design is orchestrator-controlled in this version: workers finish, fail, publish knowledge, and summarize, but they do not create new hypotheses.

Built-in Codex and Claude workers are equal first-class launchers: both run direct non-interactive CLI processes, receive the worker prompt through stdin, resolve the same Onyx CLI surface as the orchestrator, and write live logs/manifests under `.git/onyx/worker-logs/`, including a raw provider log and readable `.activity.log`. Hypothesis workers do not ask the user questions, do not launch other agents, and do not edit protected setup paths. 

Workers treat `ONYX_PROJECT_ROOT` as the only source-editing root; run `onyx research brief --campaign "$ONYX_CAMPAIGN_NAME" --session "$ONYX_SESSION_ID" --hypothesis "$ONYX_HYPOTHESIS_ID"` for current campaign memory, read `ONYX_RESEARCH_SPEC_FILE` for durable project guidance, and read `ONYX_SETUP_FILE` for exact setup policy; use `onyx research status --json`, `onyx exp list --json`, `onyx knowledge list --json`, and `onyx summary list --json` for live structured state; poll `onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n> --json` before each iteration and before long local sweeps, treat the iteration value as a cap rather than a quota, and stop when `shouldStop` is true or the hypothesis is exhausted; make one small measured/logged attempt early before broad sweeps; treat restores as normal measured workflow attempts instead of unmeasured restore-forward commits; start each attempt with `onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --base <pre-edit-sha> --auto`, edit scoped files at the agent pause, make exactly one clean commit, resume with `onyx exp run --resume <workflowRunId> --auto`, inspect blocks with `onyx workflow status --run <workflowRunId>`, and log every terminal attempt with the printed run ref using `onyx exp log --run-ref <runRef> --agent-notes ...`; publish learnings with `onyx knowledge add`; review/update summaries with `onyx summary list` and `onyx summary upsert --hypothesis "$ONYX_HYPOTHESIS_ID" --worker "$ONYX_WORKER_ID"`; reserve the final shutdown cushion for logging/syncing/exiting; inspect `onyx sync status` before exit; and leave the worktree clean on stop. 

The supervisor/harness owns durable experiment ref pushes and sync events when network access is available. Workers should not pipe mutation commands through `tail`, `head`, or other filters that can hide failed exits. The worker harness monitors stop requests while provider processes run, gives them a default 30-second cooperative grace, then terminates the provider and still performs finalization: already-logged HEADs are marked `already_logged`, exactly one unlogged HEAD commit is measured/logged using its parent as the workflow base, and multi-commit, restore-forward, or dirty salvage is pushed as `salvaged_unmeasured` without creating a blocked workflow run.
