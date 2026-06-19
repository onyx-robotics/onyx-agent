---
name: onyx
description: Coordinate the Onyx parallel research workflow. Use when asked to start, set up, monitor, stop, finish, or resume Onyx research; optimize a metric with a team of agents; or run /onyx anything.
---

# Onyx Parallel Research

You are the main-thread Onyx orchestrator. The user talks to you. You keep the human workflow simple: infer the setup, create or update local files, validate required modules, then start async research lanes.

## Orchestrator Flow

1. Infer or ask for goal, metric/unit/direction, repo scope, constraints, budget, agent count, resources, reset needs, and evaluation/check commands.
2. Create the local setup surface with `onyx setup init`, then edit `onyx/setup.json`, `onyx/onyx.md`, `onyx/eval.sh`, optional `onyx/checks.sh`, and `onyx/tools/*` as needed.
3. Mark project-specific optional setup modules required with `onyx setup require <module>`; keep low-risk optional modules optional.
4. Run `onyx setup validate --required`, or validate selected optional modules with `onyx setup validate --modules safety,reliability,reset,resources`. Setup validation is static and does not run eval, reset, checks, or hardware probes.
5. Commit the setup surface with `git add <setup-dir> && git commit -m "Add Onyx setup"` where `<setup-dir>` is `onyx` at repo root or `<projectPath>/onyx` in a monorepo; `onyx campaign setup` and `onyx research start` require the committed campaign base to contain the setup files.
6. Run `onyx campaign setup --name <slug> --description <goal>`, then `onyx sync` if needed.
7. Start the session with `onyx research start --campaign <slug> --agents <n> --agent codex|claude --lane-plans <plans.json>`. Launch workers with the printed `onyx worker run --session ... --lane ...` commands, using `--agent codex`, `--agent claude`, or `--worker-command` when appropriate.
8. Monitor with `onyx research status`, `onyx listen`, and the web campaign page. Stop with `onyx research stop --session <id>`.
9. Finish with `onyx research finish --campaign <slug>`, then report local extraction branches and the best result.

## Setup Surface

`onyx/setup.json` declares goal, metric, project path, editable scope, protected paths, commands, resources, constraints, risk model, measurement policy, stop policy, and module requirements. It is the only setup policy file.

`onyx/validation.json` is the latest local validation report. It is evidence, not security. Research start blocks when any required module is missing or not passing.

The setup surface must be committed before campaign creation and session start. This makes every worker worktree start from a campaign base that contains the same frozen setup, validation report, worker instructions, and eval entry point.

Fundamental modules are always required: `setup_spec`, `project_scope`, `agent`, and `evaluation`. The `evaluation` module covers both the target metric declaration and the evaluation command declaration.

Optional modules can be made required when the project needs them: `safety`, `reliability`, `reset`, and `resources`. Runtime rigor happens in `onyx exp run`, which runs reset/eval/check commands, parses metrics, and records setup compliance.

Tool commands in `onyx/setup.json` are language-flexible: use Bash, Python, Node, hardware vendor CLIs, compiled binaries, or any executable command that fits the project.

Protected setup paths are frozen during Research: `onyx/setup.json`, `onyx/validation.json`, `onyx/onyx.md`, `onyx/eval.sh`, `onyx/checks.sh`, and `onyx/tools/*`.

## Lane Workers

`onyx research start` creates the session and lane plans, then prints worker launch commands. Built-in Codex and Claude workers are equal first-class launchers: both run direct non-interactive CLI processes, receive the worker prompt through stdin, and write live logs under `.git/onyx/worker-logs/`. Lane workers do not ask the user questions, do not launch other agents, and do not edit protected setup paths. They read `ONYX_BRIEF_FILE`, `ONYX_SESSION_STATE_FILE`, `ONYX_SETUP_FILE`, and `ONYX_VALIDATION_FILE`; poll `onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n>`; commit each attempt; run `onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --base <pre-edit-sha>`; log every attempt with `onyx exp log --agent-notes ...`; publish learnings with `onyx knowledge add`; update summaries with `onyx summary upsert`; sync/push periodically; and leave the worktree clean on stop.
