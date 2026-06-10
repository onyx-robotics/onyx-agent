---
name: onyx
description: Drive the Onyx auto research workflow end-to-end. Use when asked to start, resume, or continue Onyx experiments, run auto research, optimize a metric, work on an Onyx branch, /onyx anything, or keep the Onyx platform updated from local research. Handles setup, the autonomous experiment loop, and recording every attempt — successful or failed — to the Onyx platform (queued in a local outbox when offline).
---

# Onyx Research

Drive an autonomous research loop using the `onyx` CLI as the substrate. You own reasoning, edits, commits, durable notes, and the experiment records the Onyx platform tracks.

## Setup

1. Ask (or infer):
   - **Goal**
   - **Evaluation**
   - **Metric**, **unit**, **direction** (`maximize` / `minimize`)
   - **Files in scope**
   - **Constraints**
   - **Stop conditions** - eg. `stop after N iterations`, `for 30 minutes`, `until <condition>`, default is no stop condition, loop forever until manually stopped by user
2. `onyx branch create --name <slug> --metric <name> --unit <unit> --direction <maximize/minimize> --description <goal>`
   - Add `--project-path <projectPath>` when the work is scoped to a subdirectory.
   - The command infers the repository from `origin` and registers the branch with Onyx; if offline or GitHub access is missing, records stay queued until `onyx sync`.
3. Read the source files. Understand the workload deeply before writing anything.
4. Write `<projectPath>/onyx/onyx.md` and `<projectPath>/onyx/eval.sh` (see below). Optionally write `<projectPath>/onyx/checks.sh` when correctness constraints require it. Commit these files.
5. Run a baseline with `onyx exp run`, then record it with `onyx exp log --description "baseline" --agent-notes '<json>'`, then start looping immediately.

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

The history cache is hydrated from the Onyx app on `onyx sync`, so after a fresh clone run `onyx sync` once to pull the cross-branch history.

### `eval.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, and outputs structured lines to stdout. Keep the script fast - every second is multiplied by hundreds of experiment runs.

#### Structured output

- `METRIC name=value` - primary metric (must match `onyx branch create`'s `metric name`) and any secondary metrics. Parsed automatically by `onyx exp run`.

#### Design the script to inform optimization

The script should output **whatever data helps you make better decisions in the next iteration.** Think about what you'll need to see after each experiment run to know where to focus:

- Phase timings when the workload has distinct stages
- Error counts, failure categories, or test names when checks can fail in different ways
- Memory usage, cache hit rates, or other runtime diagnostics when relevant
- Anything domain-specific that would help localize regressions or identify bottlenecks

The script runs the same code every iteration - but you can **update it during the loop** if you discover you need more signal. Add instrumentation as you learn what matters.

#### Agent experiment side notes via `onyx exp log`

Use `onyx exp log`'s `--agent-notes` flag to annotate each experiment run with **whatever would help the next iteration make a better decision.** Free-form key/value pairs - you decide what's worth recording. Don't repeat the description or raw output; capture what you'd lose after a context reset.

Annotate failures and crashes heavily. If you don't capture what you tried and why it failed, future iterations will waste time re-discovering the same dead ends.

### `checks.sh` (optional)

Bash script (`set -euo pipefail`) for backpressure/correctness checks: tests, types, lint, etc. **Only create this file when the user's constraints require correctness validation** (e.g., "tests must pass", "types must check").

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

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" - the user expects autonomous work.

- **Primary metric is king.** Improved -> build the next experiment from that result. Worse/equal -> leave it recorded and build from the prior best instead. Secondary metrics rarely affect this.
- **Annotate every run with `--agent-notes`.** Record what you learned - not what you did. What would help the next iteration or a fresh agent resuming this session? Notes are searchable later via `onyx exp list --grep`.
- **Simpler is better.** Removing code for equal perf = good. Ugly complexity for tiny gain = probably not worth building on.
- **Don't thrash.** Repeatedly returning to the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Think longer when stuck.** Re-read source files, study the profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.
- **Resuming:** if `onyx.md` exists, read it + git log + `onyx status` + `onyx exp list --limit 20`, continue looping.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.

## Git Rules

Onyx is append-only: commit every attempt forward on `onyx/{name}`. Do not use `git reset --hard`, auto-revert, or force-push. Experiment metadata is canonical in the Onyx app/API; `.git/onyx/outbox.jsonl` is only an offline retry queue.

## Ideas Backlog

When you discover complex but promising optimizations that you won't pursue right now, **append them as bullets to `onyx.ideas.md`**. Don't let good ideas get lost.

On resume (context limit, crash), check `onyx.ideas.md` - prune stale/tried entries, experiment with the rest. When all paths are exhausted, delete the file and write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `onyx exp run` + `onyx exp log` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.
