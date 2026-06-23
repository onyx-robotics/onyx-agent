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
2. Create the local setup surface with `onyx setup init`, then edit `onyx/setup.json`, `onyx/onyx.md`, and `onyx/tools/*` as needed. The default eval tool is `onyx/tools/evaluation/run.sh`. There's more details on this setup surface below.
3. Declare `setup.tools` entries and linear `workflow` steps that will drive the worker agent's repeatable experiment workflow. There should be exactly one required `metric: true` command step, and each workflow run should produce a single experiment commit and result log.
4. Run `onyx setup validate`. Setup validation is static and does not execute eval, reset, check, or hardware commands. Failed or stale validation blocks campaign setup and research start; warning checks do not.
5. Commit the setup surface with `git add <setup-dir> && git commit -m "Add Onyx setup"` where `<setup-dir>` is `onyx` at repo root or `<projectPath>/onyx` in a monorepo; `onyx campaign setup` and `onyx research start` require the committed campaign base to contain the setup files.
6. Push the setup base commit to the repository remote with `git push origin HEAD` before campaign sync. The generic CLI warns instead of auto-pushing, but this orchestrated skill should push so GitHub-backed campaign creation can verify the base commit.
7. Run `onyx campaign setup --name <slug> --description <goal>`, then `onyx sync` if needed.
8. Move on to the Research phase after the setup surface has been built out and approved by the human user.

### Setup Surface

`onyx/setup.json` declares goal, metric, project path, editable scope, protected paths, resources, declared tools, and the linear experiment workflow. It is the only setup policy file.

`onyx/validation.json` is the latest local validation report. It stores a setup hash and static checks. It is evidence, not security. Research start blocks when validation is stale or any check failed.

The setup surface must be committed before campaign creation and session start. This makes every worker worktree start from a campaign base that contains the same frozen setup, validation report, worker instructions, and workflow tools.

Workflow v1 is strict and linear: one workflow run is one experiment attempt, one result commit, and one primary metric. Tool and step IDs are lowercase path-safe namespaced strings such as `evaluation.run`, `reset.clean`, and `reliability.check`.

Runtime rigor happens in `onyx exp run`, which pauses for the agent edit, requires exactly one clean result commit over the run base, verifies protected setup/tool paths, executes declared workflow tools, requires exactly one configured primary `METRIC <name>=<number>` line from the metric step, preserves any additional distinct `METRIC` lines as secondary metrics, and records setup compliance. Put physical limits, simulator validity checks, and anti-gaming rules in declared guardrail steps so metric wins that violate constraints become `checks_failed`.

Tool commands in `onyx/setup.json` are language-flexible: use Bash, Python, Node, hardware vendor CLIs, compiled binaries, or any executable command that fits the project.

Protected setup paths are frozen during Research: `onyx/setup.json`, `onyx/validation.json`, `onyx/onyx.md`, and `onyx/tools/*`.

## Research

The research phase begins after you have completed the setup phase. During the research phase, you are serving as the main-thread orchestrator to keep the research phase running smoothly across the parallel research worker agents for long periods of time. The human user may interact with you, asking questions or asking you to take actions on the research process. Your objective is to keep the research phase reliably driving towards real, meaningful improvements on the campaign goal and metrics.

1. Start the research phase with inline JSON: `onyx research start --campaign <slug> --workers <n> --agent codex|claude --hypotheses '<json-array>'`. Use `onyx research hypotheses --example` as a setup-aware template when drafting initial hypotheses, then pass the JSON array inline. Launch workers with the printed `onyx worker run --session ... --hypothesis ...` commands, using `--agent codex`, `--agent claude`, or `--worker-command` when appropriate.
2. Monitor with `onyx research status`, `onyx research status --json`, `onyx listen`, and the web campaign page. Use `onyx research status --reconcile` only when you intentionally want lifecycle repair. Review experiments, worker summaries, and knowledge, then create fresh hypotheses with `onyx research hypothesis add --session <id> --focus <text> --hypothesis <text>` or `--plan <json-file>` whenever the campaign needs another option; launch a worker against an active hypothesis when a worker slot opens.
3. Stop with `onyx research stop --session <id>`.
4. Finish with `onyx research finish --campaign <slug>`, then report local extraction branches and the best result.

### Hypothesis Worker Agents

`onyx research start` creates the session and initial hypothesis plans, then prints worker launch commands. `onyx research hypothesis add` creates campaign hypotheses during or between sessions; it accepts `--plan <json-file>` or inline `--focus`, `--hypothesis`, repeated `--starting-point`, `--avoid`, `--success`, and `--give-up` flags. Successor hypothesis design is orchestrator-controlled in this version: workers finish, fail, publish knowledge, and summarize, but they do not create new hypotheses.

Built-in Codex and Claude workers are equal first-class launchers: both run direct non-interactive CLI processes, receive the worker prompt through stdin, resolve the same Onyx CLI surface as the orchestrator, and write live logs/manifests under `.git/onyx/worker-logs/`. 

Hypothesis workers do not ask the user questions, do not launch other agents, and do not edit protected setup paths. They treat `ONYX_PROJECT_ROOT` as the only source-editing root; read `ONYX_BRIEF_FILE`, `ONYX_SESSION_STATE_FILE`, `ONYX_SETUP_FILE`, `ONYX_VALIDATION_FILE`, and `ONYX_RESEARCH_SPEC_FILE`; inspect peer learnings with `onyx knowledge list`; poll `onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n> --json` before each iteration and before long local sweeps and stop only when `shouldStop` is true; make one small measured/logged attempt early; keep sweeps bounded; start each attempt with `onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --base <pre-edit-sha> --auto`, edit scoped files at the agent pause, make exactly one clean commit, resume with `onyx exp run --resume <workflowRunId> --auto`, inspect blocks with `onyx workflow status --run <workflowRunId>`, and log every terminal attempt with the printed run ref using `onyx exp log --run-ref <runRef> --agent-notes ...`; publish learnings with `onyx knowledge add`; review/update summaries with `onyx summary list` and `onyx summary upsert --hypothesis "$ONYX_HYPOTHESIS_ID" --worker "$ONYX_WORKER_ID"`; reserve the final shutdown cushion for logging/syncing/exiting; sync/push periodically when available; and leave the worktree clean on stop. Workers should not pipe mutation commands through `tail`, `head`, or other filters that can hide failed exits. The worker harness performs a final best-effort commit, measurement for exactly one unlogged commit when possible, local log, and worker-branch push after the agent exits so useful code is not lost when sync is offline or the model exits badly. Multi-commit or dirty salvage preserves the worker branch without producing a measured experiment.