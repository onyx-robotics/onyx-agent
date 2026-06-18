---
name: onyx
description: Drive the Onyx auto research workflow end-to-end. Use when asked to start, resume, or continue Onyx experiments, run auto research, optimize a metric, work on an Onyx campaign, /onyx anything, or keep the Onyx platform updated from local research. Handles setup, the autonomous experiment loop, worker heartbeat visibility, and recording every attempt - successful or failed - to the Onyx platform (queued in a local outbox when offline).
---

# Onyx Research

Drive an autonomous research loop using the `onyx` CLI as the substrate. You own reasoning, edits, commits, durable notes, and the experiment records the Onyx platform tracks.

## Setup

1. Ask (or infer from the user's prompt) the following key pieces of information. Verify with the user before starting:
   - **Goal**
   - **Evaluation**
   - **Metric**, **unit** (make sure this is a real unit like time `s`, `ms`, `us` that can be formatted with the metric), **direction** (`maximize` / `minimize`)
   - **Files in scope**
   - **Constraints**
   - **Stop conditions** - eg. `stop after N iterations`, `for 30 minutes`, `until <condition>`, default is no stop condition, loop forever until manually stopped by user
2. `onyx campaign setup --name <slug> --metric <name> --unit <unit> --direction <maximize/minimize> --description <goal>`
   - Add `--project-path <projectPath>` when the work is scoped to a subdirectory.
   - The command infers the repository from `origin` and registers the campaign with Onyx; if offline or GitHub access is missing, records stay queued until `onyx sync`.
   - The campaign records the current git HEAD as its base commit. It does not create a shared research-history branch.
3. Read the source files. Understand the workload deeply before writing anything.
4. Write `<projectPath>/onyx/onyx.md` and `<projectPath>/onyx/eval.sh` (see below). Optionally write `<projectPath>/onyx/checks.sh` when correctness constraints require it. Commit these files.
5. Run `onyx setup validate`. This records the baseline experiment, validates the active setup, and moves the campaign into the Research phase.
6. Start autonomous research with `onyx research start --campaign <slug> --agents <n> --worker-command "<agent command>"`, or continue manually with the loop below.

### `onyx.md`

This is the heart of the session. A fresh agent with no context should be able to read this file and run the loop effectively. Invest time making it excellent.

```markdown
# Onyx Research: <goal>

## Objective

<Specific description of what we're optimizing and the workload.>

## Metrics

- **Primary**: <name>, <unit>, <direction> - the optimization target
- **Secondary**: - independent tradeoff monitors
  - <name>, <unit>, <direction>
  - <name>, <unit>, <direction>
  - ...

## How to Run

`./onyx/eval.sh` - outputs `METRIC name=number` lines.

## Files in Scope

<Every file the agent may modify, with a brief note on what it does.>

## Off Limits

<What must NOT be touched.>

## Constraints

<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried

<High-level strategy notes only: key wins, dead-end THEMES, and architectural
insights. Do not list individual experiments here - the full per-experiment
record lives in `onyx exp list` (searchable offline).>
```

Update `onyx.md` periodically - especially the "What's Been Tried" section - so resuming agents have strategic context. For the detailed record of individual attempts, rely on `onyx exp list` instead of duplicating it in `onyx.md`:

- `onyx exp list --limit 20` - recent experiments (newest first) with status and metric.
- `onyx exp list --grep <regex>` - search names, descriptions, agent notes, and output summaries; e.g. `onyx exp list --grep 'cache|memoiz'` before trying a caching idea.
- `onyx exp list --status failed --json` - full records (agent notes included) for post-mortems.

The history cache is hydrated from the Onyx app on `onyx sync`, so after a fresh clone run `onyx sync` once to pull the campaign history.

### `eval.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, and outputs structured lines to stdout. Keep the script fast - every second is multiplied by hundreds of experiment runs.

#### Structured output

- `METRIC name=value` - primary metric (must match `onyx campaign setup`'s `metric name`) and any secondary metrics. Parsed automatically by `onyx exp run`. The primary `METRIC` line is **mandatory** for a successful run: if `eval.sh` exits 0 but emits no matching `METRIC` line, `onyx exp run` records the run as `failed`, and `onyx exp log` refuses to record it as `succeeded`/`accepted`. Always make the eval print the primary metric.

#### Control measurement noise

For noisy metrics (timings, throughput) where the evaluation can be run quickly (<1s per run), run several trials in `eval.sh` and report the median or min as the primary `METRIC`, plus a spread (stddev or range) as a secondary so you can tell a real gain from noise. Warm up first and pin the environment (threads, frequency scaling) where it matters.

#### Design the script to inform optimization

The script should output **whatever data helps you make better decisions in the next iteration.** Think about what you'll need to see after each experiment run to know where to focus:

- Phase timings when the workload has distinct stages
- Error counts, failure categories, or test names when checks can fail in different ways
- Memory usage, cache hit rates, or other runtime diagnostics when relevant
- Anything domain-specific that would help localize regressions or identify bottlenecks

You can **update the script during the loop** for more signal. Adding diagnostic output or new secondary `METRIC` lines is safe. Changing the _measured workload itself_ (size, iterations, what's timed) makes every prior metric incomparable - re-baseline and note it if you must.

#### Agent experiment side notes via `onyx exp log`

Use `onyx exp log`'s `--agent-notes` flag to annotate each experiment run with **whatever would help the next iteration make a better decision.** Free-form key/value pairs - you decide what's worth recording. Don't repeat the description or raw output; capture what you'd lose after a context reset.

Annotate failures and crashes heavily. If you don't capture what you tried and why it failed, future iterations will waste time re-discovering the same dead ends.

### `checks.sh` (optional)

Bash script (`set -euo pipefail`) for backpressure/correctness checks: tests, types, lint, etc. **Only create this file when the user's constraints require correctness validation** (e.g., "tests must pass", "types must check"). Hard guardrails on secondary metrics belong here too (e.g. fail when memory exceeds a ceiling): a `checks_failed` result can never become best, so it stops a primary win that wrecks a tradeoff.

When this file exists:

- Runs automatically after every **passing** benchmark in `onyx exp run`.
- If checks fail, `onyx exp run` reports it clearly - log as `checks_failed`.
- Its execution time does **NOT** affect the primary metric.
- A `checks_failed` result is recorded, but never becomes best.
- Has a separate timeout (default 300s, configurable via `onyx exp run --checks-timeout <seconds>`).

When this file does **not** exist, everything behaves exactly as before - no changes to the loop.

**Keep output minimal.** Only the last 80 lines of checks output are fed back to the agent on failure. Suppress verbose progress/success output and let only errors through. This keeps context lean and helps the agent pinpoint what broke.

```bash
#!/bin/bash
set -euo pipefail
# Example: run tests and typecheck - suppress success output, only show errors
pnpm test --run --reporter=dot 2>&1 | tail -50
pnpm typecheck 2>&1 | grep -i error || true
```

## The Research Phase

Each autonomous agent owns one lane. The lane has a movable branch under `refs/heads/onyx/<campaign>/lanes/*`, while each measured attempt still gets an immutable `refs/onyx/experiments/<campaignId>/<runRef>` ref. A generated brief is available at `$ONYX_BRIEF_FILE` and peer-lane state is available at `$ONYX_SESSION_STATE_FILE` for lane workers.

### **LOOP** (until the stop condition or an interrupt):

1. Check the stop condition (iterations / elapsed time / target). If met, wrap up and stop (see below).
2. Review `onyx/onyx.md`, git, and onyx state. Identify the current best commit (`onyx exp list`). If the last experiment regressed, restore your in-scope files to the best before editing: `git checkout <best-sha> -- <scoped files>` (a new forward commit, not history rewriting).
3. Make edits for a new experiment idea.
4. Commit the result locally. The tree must be clean before measuring - the result is attributed to HEAD.
5. Run the experiment with `onyx exp run [--campaign <name>] [--timeout <seconds>] [--checks-timeout <seconds>] [--project-path <path>] [--no-log]`
6. Inspect the result, including benchmark output and optional checks.sh result.
7. Record `onyx exp log [--campaign <name>] [--name <name>] [--description <text>] [--agent-notes <json-or-text>] [--commit <sha>] [--metric <value>] [--metric-name <name>] [--status succeeded|failed|checks_failed|accepted|rejected|running|queued] [--project-path <path>]`
8. `onyx exp log` records locally first. Keep `onyx sync --watch` running for manual loops, or run `onyx push`/`onyx sync` periodically to push immutable refs and flush queued records.
9. If running as a lane worker, update a concise lane summary through the Onyx CLI/API or in the final commit notes so later agents can resume from the brief.

**On stop:** Update `onyx.md`'s "What's Been Tried" and write a short summary of the best result and any open ideas. Leave git clean - no uncommitted changes and no unreported local commits. Commit any final edits forward (or discard work you won't record), then run `onyx push` or `onyx sync` so immutable refs and the outbox are flushed.

### Loop Rules

- **Primary metric is king.** Improved -> build the next experiment from that result. Worse/equal -> restore the best commit's files and build from there. Secondary metrics rarely change the decision, but a guardrail breach (e.g. memory blowup) should fail the run - encode hard limits in `checks.sh`.
- **Confirm new bests.** A single trial of a noisy metric can lie. Re-run a surprising improvement before building on it.
- **Statuses:** the loop uses `succeeded` / `failed` / `checks_failed` (what `onyx exp run` emits). `accepted` / `rejected` are for human curation - don't set them in the loop.
- **Every `succeeded` result carries the primary metric.** A measured win is defined by its metric, so `onyx exp log` rejects `succeeded`/`accepted` without one. If a run produced no metric (eval crashed, no `METRIC` line), record it with `--status failed` and annotate why - never drop the experiment.
- **Annotate every run with `--agent-notes`.** Record what you learned - not what you did. What would help the next iteration or a fresh agent resuming this session? Notes are searchable later via `onyx exp list --grep`.
- **Keep descriptions clean.** Make sure descriptions are informative on what changed and simple, don't include redundant information like "exp1: " or "iter 1/10: " as that info is already tracked by onyx.
- **Simpler is better.** Removing code for equal perf = good. Ugly complexity for tiny gain = probably not worth building on.
- **Stick to the user's interfaces.** Don't create your own custom tuning, parameter search, or argument entry scripts unless explicitly asked to or required. Prefer using the user's existing method for changing parameters or code as it is.
- **Don't thrash.** Repeatedly returning to the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Think longer when stuck.** Re-read source files, study the profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.
- **Resuming:** if `onyx.md` exists, read it + git log + `onyx status` + `onyx exp list --limit 20` (run `onyx sync` first on a fresh clone). Identify the best commit, restore its files if HEAD is a regression, then continue looping.

**Never stop voluntarily.** Don't ask "should I continue?" - the user expects autonomous work and may be away for hours. Keep going until the stop condition is met or you're interrupted.

## Git Rules

Onyx campaign history is immutable-ref based: every measured attempt gets its own result commit and result ref, defaulting to `refs/onyx/experiments/<campaignId>/<runRef>`. Do not use `git reset --hard`, auto-revert, or force-push to rewrite reported experiments. Restoring an earlier commit's file contents to build from the best (`git checkout <sha> -- <files>`, then commit forward) is fine - that's a new attempt, not history rewriting. Experiment metadata is canonical in the Onyx app/API; `.git/onyx/outbox.jsonl` is only an offline retry queue.

Fixing a mistake goes through deletion, never history rewriting: deleted records are tombstoned server-side, `onyx sync` drops them from the local queue and history, and re-reporting a deleted experiment is rejected. Only delete when the user asks for it; the autonomous loop itself never deletes.

## Ideas Backlog

When you discover complex but promising optimizations that you won't pursue right now, **append them as bullets to `onyx.ideas.md`**. Don't let good ideas get lost.

On resume (context limit, crash), check `onyx.ideas.md` - prune stale/tried entries, experiment with the rest. When all paths are exhausted, delete the file and write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `onyx exp run` + `onyx exp log` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.
