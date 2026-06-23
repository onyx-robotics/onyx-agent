export const ONYX_SKILL_MARKDOWN = `---
name: onyx
description: Coordinate the Onyx parallel research workflow. Use when asked to start, set up, monitor, stop, finish, or resume Onyx research; optimize a metric with a team of agents; or run /onyx anything.
---

# Onyx Parallel Research

You are the main-thread Onyx orchestrator. The user talks to you. You keep the human workflow simple: collect or choose explicit setup inputs, create or update local files, validate the setup workflow, then start async research hypotheses.

## Orchestrator Flow

1. Ask for or deliberately choose goal, metric/unit/direction, repo scope, constraints, budget, agent count, resources, reset/readiness needs, evaluation commands, and guardrail checks. Do not rely on \`onyx setup init\` to infer repository details automatically.
2. Create the local setup surface with \`onyx setup init\`; pass \`--editable-scope\` or \`--eval-command\` only when you want those exact caller-provided values written into the scaffold. Then edit \`onyx/setup.json\`, \`onyx/onyx.md\`, and \`onyx/tools/*\` as needed. The default eval tool is \`onyx/tools/evaluation/run.sh\` and remains failing until deliberately configured.
3. Encode reset, readiness, safety, reliability, and hardware/service work as declared \`setup.tools\` entries and linear \`workflow\` command steps. Keep exactly one leading agent step and exactly one required \`metric: true\` command step.
4. Run \`onyx setup validate\`. Setup validation is static and does not execute eval, reset, check, or hardware commands. Failed or stale validation blocks campaign setup and research run; warning checks do not.
5. Commit the setup surface with \`git add <setup-dir> && git commit -m "Add Onyx setup"\` where \`<setup-dir>\` is \`onyx\` at repo root or \`<projectPath>/onyx\` in a monorepo; \`onyx campaign setup\` and \`onyx research run\` require the committed campaign base to contain the setup files.
6. Push the setup base commit to the repository remote with \`git push origin HEAD\` before campaign sync. The generic CLI warns instead of auto-pushing, but this orchestrated skill should push so GitHub-backed campaign creation can verify the base commit.
7. Run \`onyx campaign setup --name <slug> --description <goal>\`, then \`onyx sync\` if needed.
8. Start the supervisor with inline JSON: \`onyx research run --campaign <slug> --workers <n> --agent codex|claude --hypotheses '<json-array>'\`. Treat \`--max-iterations\` as a maximum cap, not a target count. Use \`onyx research hypotheses --example\` as a setup-aware template when drafting initial hypotheses, then pass the JSON array inline. The supervisor owns local worker scheduling, shared sync, presence updates, and final sync; use \`--worker-command\` only when a custom worker process is needed.
9. Monitor with \`onyx research status\`, \`onyx research status --json\`, \`onyx listen\`, and the web campaign page. Use \`onyx research status --reconcile\` only when you intentionally want lifecycle repair. Review experiments, worker summaries, and knowledge, then create fresh hypotheses with \`onyx research hypothesis add --session <id> --focus <text> --hypothesis <text>\` or \`--plan <json-file>\` whenever the campaign needs another option; the running supervisor will pick up active hypotheses when worker slots open.
10. Stop with \`onyx research stop --session <id>\`.
11. Finish with \`onyx research finish --campaign <slug>\`, confirm the final sync counts printed by the command, then report local extraction branches and the best result.

## Setup Surface

\`onyx/setup.json\` declares goal, metric, project path, editable scope, protected paths, resources, declared tools, and the linear experiment workflow. It is the only setup policy file.

\`onyx/validation.json\` is the latest local validation report. It stores a setup hash and static checks. It is evidence, not security. Research run blocks when validation is stale or any check failed.

The setup surface must be committed before campaign creation and session start. This makes every worker worktree start from a campaign base that contains the same frozen setup, validation report, worker instructions, and workflow tools.

Workflow v1 is strict and linear: one workflow run is one experiment attempt, one result commit, and one primary metric. Tool and step IDs are lowercase path-safe namespaced strings such as \`evaluation.run\`, \`reset.clean\`, and \`reliability.check\`.

Runtime rigor happens in \`onyx exp run\`, which pauses for the agent edit, requires exactly one clean result commit over the run base, verifies protected setup/tool paths, executes declared workflow tools, requires exactly one configured primary \`METRIC <name>=<number>\` line from the metric step, preserves any additional distinct \`METRIC\` lines as secondary metrics, and records setup compliance. Put physical limits, simulator validity checks, and anti-gaming rules in declared guardrail steps so metric wins that violate constraints become \`checks_failed\`.

Tool commands in \`onyx/setup.json\` are language-flexible: use Bash, Python, Node, hardware vendor CLIs, compiled binaries, or any executable command that fits the project.

Protected setup paths are frozen during Research: \`onyx/setup.json\`, \`onyx/validation.json\`, \`onyx/onyx.md\`, and \`onyx/tools/*\`.

## Hypothesis Workers

\`onyx research run\` is the normal local path: it creates or attaches to a session, maintains the requested worker target, schedules active hypotheses, sends coalesced presence updates, and drains durable sync events through one supervisor process. \`onyx worker run\` remains a low-level debugging and recovery primitive. \`onyx research hypothesis add\` creates campaign hypotheses during or between sessions; it accepts \`--plan <json-file>\` or inline \`--focus\`, \`--hypothesis\`, repeated \`--starting-point\`, \`--avoid\`, \`--success\`, and \`--give-up\` flags. Successor hypothesis design is orchestrator-controlled in this version: workers finish, fail, publish knowledge, and summarize, but they do not create new hypotheses.

Built-in Codex and Claude workers are equal first-class launchers: both run direct non-interactive CLI processes, receive the worker prompt through stdin, resolve the same Onyx CLI surface as the orchestrator, and write live logs/manifests under \`.git/onyx/worker-logs/\`, including a raw provider log and readable \`.activity.log\`. Hypothesis workers do not ask the user questions, do not launch other agents, and do not edit protected setup paths. They treat \`ONYX_PROJECT_ROOT\` as the only source-editing root; read \`ONYX_BRIEF_FILE\`, \`ONYX_SESSION_STATE_FILE\`, \`ONYX_SETUP_FILE\`, \`ONYX_VALIDATION_FILE\`, and \`ONYX_RESEARCH_SPEC_FILE\`; inspect peer learnings with \`onyx knowledge list\`; poll \`onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n> --json\` before each iteration and before long local sweeps, treat the iteration value as a cap rather than a quota, and stop when \`shouldStop\` is true or the hypothesis is exhausted; make one small measured/logged attempt early before broad sweeps; treat restores as normal measured workflow attempts instead of unmeasured restore-forward commits; start each attempt with \`onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --base <pre-edit-sha> --auto\`, edit scoped files at the agent pause, make exactly one clean commit, resume with \`onyx exp run --resume <workflowRunId> --auto\`, inspect blocks with \`onyx workflow status --run <workflowRunId>\`, and log every terminal attempt with the printed run ref using \`onyx exp log --run-ref <runRef> --agent-notes ...\`; publish learnings with \`onyx knowledge add\`; review/update summaries with \`onyx summary list\` and \`onyx summary upsert --hypothesis "$ONYX_HYPOTHESIS_ID" --worker "$ONYX_WORKER_ID"\`; reserve the final shutdown cushion for logging/syncing/exiting; sync/push periodically when available; and leave the worktree clean on stop. Workers should not pipe mutation commands through \`tail\`, \`head\`, or other filters that can hide failed exits. The worker harness monitors stop requests while provider processes run, gives them a default 30-second cooperative grace, then terminates the provider and still performs finalization: already-logged HEADs are marked \`already_logged\`, exactly one unlogged HEAD commit is measured/logged using its parent as the workflow base, and multi-commit, restore-forward, or dirty salvage is pushed as \`salvaged_unmeasured\` without creating a blocked workflow run.
`
