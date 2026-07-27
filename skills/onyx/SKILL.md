---
name: onyx
description: Coordinate endless additive Onyx research campaigns, bounded sessions, hypotheses, workers, and metric optimization.
---

# Onyx Parallel Auto Research

You are the user-facing Onyx orchestrator. Keep the research direction durable while treating every execution session as a fresh, bounded batch.

## Setup

1. Establish the goal, immutable metric name/unit/direction, editable and protected scopes, evaluator, reset/readiness/safety tools, resource limits, hypotheses, worker capacity, and experiment/deadline bound.
2. Run `onyx setup init`, then deliberately complete `onyx/setup.json`, `onyx/onyx.md`, and `onyx/tools/*`. The scaffolded evaluator fails until it emits exactly one primary `METRIC name=value` line.
3. Keep exactly one leading agent workflow step and one required metric step. The metric tool must declare non-empty `fingerprintPaths`; the scaffold defaults to `["onyx/tools/evaluation"]`. Include every committed evaluator/config/data input that determines whether results are comparable.
4. Run `onyx setup validate`, inspect `metric_tool_readiness`, and commit the complete setup surface. For GitHub-backed projects, push the exact setup/base commit so GitHub can read it before starting Research. Research fingerprints committed git content, never dirty working-tree content.
5. Run `onyx campaign setup --name <slug> --description <goal>`. Reusing the same campaign name is idempotent only when the metric contract matches. A metric change requires a new campaign.

## Hypotheses

Hypotheses are durable conceptual options, not branches or mutable git bases.

- List: `onyx research hypothesis list --campaign <slug>`
- Add: `onyx research hypothesis add --campaign <slug> --name <name> --focus <focus> --hypothesis <statement>`
- Close: `onyx research hypothesis close --campaign <slug> --hypothesis <name-or-id>`
- Reopen: `onyx research hypothesis reopen --campaign <slug> --hypothesis <name-or-id>`

Adding or reopening affects future sessions only. Closing is abrupt: it cancels open assignments, stops matching workers, rejects late reports for that assignment, and can end a session when no active assignment remains.

## Sessions

Start with:

`onyx research run --campaign <slug> [--workers <n>] [--hypothesis <name-or-id>]... [--base <ref>] [--hypothesis-base <hypothesis>=<ref|experiment:id>]... (--experiments <n> | --max-minutes <n>)`

Every run creates a new remote session. Never resume or attach to an old session. Defaults are committed `HEAD`, every active hypothesis, and one worker. Assignment bases must contain the exact session setup hash and evaluation fingerprint; rebase/cherry-pick older experiment code onto the current setup before continuing it. Use `--new` only when intentionally running another local session for the campaign concurrently.

The command validates the committed setup and fingerprint inputs, snapshots hypothesis assignments, starts a detached supervisor, and prints its session ID, PID, log, status, and listen commands. Use `--json` for orchestration and `--foreground` only for debugging.

Reports are delivered independently and normally appear first as `received`. A small server settler assigns accepted indexes in receipt order. The supervisor nudges settlement with jitter while the session is open; accepted progress is authoritative, while received progress only shows the short settlement backlog. At an exact experiment target, overflow work is retained as discarded diagnostics and never enters rankings.

- Monitor: `onyx research status --summary`, `onyx research status --summary --json`, `onyx listen`, and the web campaign page. Use detailed `onyx research status` only when you need hypothesis and worker diagnostics.
- Scale: `onyx research scale --workers <n> --session <id>`. Scale-down drains existing workers; use stop instead of zero.
- Stop: `onyx research stop --session <id>`. The harness cooperatively stops workers and disposes their worktrees; uncertain process identity is never killed.
- Clean local runtime artifacts: inspect with `onyx research clean --dry-run`, then run `onyx research clean` if desired.

Evaluator changes remain in the campaign but create a separate evaluation revision. Never compare metrics across revisions as a single leaderboard.

## Worker contract

Workers use `ONYX_PROJECT_ROOT` as their source-editing root and `onyx-worker research session-state-brief --json` for routine session, assignment, stop, knowledge, and progress context. They must not ask the user questions, launch agents, use the full control-plane CLI, or mutate protected setup paths/runtime files.

For each attempt, a worker runs `onyx-worker exp run --campaign "$ONYX_CAMPAIGN_NAME" --auto`, makes exactly one scoped clean commit, resumes with `onyx-worker exp run --resume --auto`, and reports with `onyx-worker exp log`. A `recorded` response means delivery succeeded; the worker does not wait for acceptance. It publishes useful reusable knowledge when appropriate. Git holds immutable experiment commits/refs; Supabase owns session settlement, accepted indexes, experiment facts, and provenance. Best results and summary counts are computed from indexed experiment facts when read.

The harness monitors supervisor-owned local control state for server cutoffs and assignment cancellation, gives cooperative stop grace, then terminates the provider. Workers use detached disposable worktrees and never create worker branches. A terminal measurement creates a transient pending-report outbox entry; normal logging clears it, while teardown may deliver exactly one remaining entry. Teardown never commits, measures, or reports scratch work. Partial work is retained only as bounded terminal telemetry with stable reason, provider-exit, delivery, and cleanup outcomes, and a fresh worker starts clean; server settlement remains authoritative for late reports. Monitor systemic replacement loops through the no-progress breaker in `onyx research status --summary` or `onyx listen`.
