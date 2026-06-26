# Onyx Agent

Open-source agent package for Onyx research workflows.

It installs the `onyx` command and the bundled `onyx` agent skill. The command
is terminal-only: agents make code changes in your existing git repository,
commit measured attempts, push immutable experiment refs, and report experiment
metadata plus setup, hypothesis, and worker state to the Onyx app.

## Install

```bash
curl -fsSL https://onyxresearch.ai/install.sh | bash
```

The installer puts `onyx` in `~/.local/bin` by default, walks you through PATH
setup if your shell needs it, and then starts browser login. Press `Esc` while
it is waiting if you need to authenticate later or use `ONYX_API_KEY` instead.

Verify the command:

```bash
onyx --version
```

For non-interactive installs, set `ONYX_INSTALL_NO_PROMPT=1`. For explicit
system-wide installs, choose a writable install directory:

```bash
curl -fsSL https://onyxresearch.ai/install.sh | ONYX_INSTALL_DIR=/usr/local/bin bash
```

If you cancel authentication during install, run `onyx login` later.

Profiles are team-scoped. Use `onyx profile list`, `onyx profile use <name>`,
and `onyx profile delete <name>` to inspect, switch, or remove local profile
entries.

Only for local app development, point the agent at a non-production API.
`--local` is shorthand for `--api-url http://localhost:3000`:

```bash
onyx login --local
```

This stores a separate profile for the local app; switch between it and the
hosted app with `onyx profile use <name>`. Developer mode
(`onyx developer use dev`) changes which CLI source runs, not which app the
CLI targets.

## Agent Skill

The installer installs the bundled skill automatically for Claude Code and
Codex. It writes Claude's personal skill file at
`~/.claude/skills/onyx/SKILL.md`, Codex's user skill file at
`~/.agents/skills/onyx/SKILL.md`, and the Codex home skill file at
`${CODEX_HOME:-~/.codex}/skills/onyx/SKILL.md` for Codex builds that discover
skills from `CODEX_HOME`. The canonical source is `skills/onyx/SKILL.md`;
after editing it, run `bun run generate:skill-content` so the embedded release
fallback stays in sync. To install it manually:

```bash
onyx agent install-skill
```

To locate the package skill source:

```bash
onyx agent skill-path
```

## Core Workflow

```bash
onyx setup init --goal "Improve score" --metric-name score --editable-scope src --eval-command "printf 'METRIC score=1\n'"
# edit onyx/setup.json, onyx/onyx.md, and onyx/tools/evaluation/run.sh
onyx setup validate
git add onyx
git commit -m "Add Onyx setup"
git push origin HEAD
onyx campaign setup --name fast-eval --description "Improve score"
onyx research run --campaign fast-eval --workers 4
onyx listen
```

The CLI stores local research state and retry events in `.git/onyx/research.db`
and flushes them to `/api/v1` when connectivity and credentials are available.
Transient diagnostics use `onyx tools run <tool-id>`, which executes declared
setup tools without creating workflow or measured-attempt state.

The bundled `/onyx` skill is the preferred user-facing orchestrator. It creates
`onyx/setup.json`, `onyx/validation.json`, generated `onyx/onyx.md`,
and `onyx/tools/*`; designs the linear workflow and declared tools; validates
the setup hash and executes the canonical metric tool once to prove readiness;
then creates an async research session with deliberate hypothesis plans.
Runtime rigor remains in `onyx exp run`, which
pauses for the agent edit, requires exactly one clean result commit, executes
workflow command steps, parses the primary metric, and records setup compliance.
`onyx setup init` stays explicit: `--editable-scope` and `--eval-command` write
only the caller-provided values, and the default eval tool keeps failing until
the orchestrator deliberately configures it. Slow eval cost is paid during
`onyx setup validate`, not before every worker loop. The generated `onyx/onyx.md`
is a research spec for durable project guidance: goal, metric interpretation,
editable scope, evaluation caveats, declared tools, and project-specific
constraints. Workers use CLI commands for live structured state instead of
generated per-worker state files.

Local research state is SQLite-first. The agent stores campaigns, sessions,
hypotheses, workers, experiments, summaries, knowledge, resource leases, and
pending sync events in `.git/onyx/research.db`. Commands write this ledger
before attempting network sync, so setup, research execution, experiment
logging, summaries, and knowledge publishing work offline and can be uploaded
later with `onyx sync`.
Use `onyx sync status`, `onyx sync conflicts`, `onyx sync retry`,
`onyx sync export`, and `onyx sync doctor` to inspect and repair the local
ledger.

`onyx campaign setup` and `onyx research run` require the `onyx/` setup
surface to be committed. This keeps worker worktrees pinned to a base commit
that actually contains `setup.json`, `validation.json`, `onyx.md`, and
declared workflow tools. GitHub-backed campaigns also require that base commit
to be present on the repository remote; the CLI warns when it is missing, while
the bundled `/onyx` skill pushes the setup base before campaign sync.

Tool commands in `onyx/setup.json` are language-flexible: point them at Bash,
Python, Node, hardware vendor CLIs, compiled binaries, or any executable
available to the project.

Hypothesis workers are driven by the TypeScript-rendered Markdown prompt in
`src/lib/worker-prompt.ts`, so prompt variables are typechecked directly in the
editor and standalone release binaries stay self-contained.

To run multiple local research hypotheses directly from the CLI, use the
repo-level supervisor with a built-in agent launcher:

```bash
plans='[{"focus":"Try a bounded search","statement":"A focused local change can improve the configured metric."}]'
onyx research run --campaign fast-eval --workers 4 --agent codex --hypotheses "$plans" --max-minutes 10 --max-experiments 20 --max-worker-iterations 5
onyx research hypothesis add --session <id> --focus "Try a fresh hypothesis" --hypothesis "The new direction may improve score"
```

`onyx research run` validates the campaign and starts a detached supervisor by
default, then prints the session id, supervisor PID, log path, and monitoring
commands before returning. Use `--json` for parseable startup output in
orchestrator agents, and `--foreground` only when you intentionally want an
attached debugging or smoke-test shell.

`--workers` is the active slot target: when a short worker exits, the
supervisor backfills that slot. For a bounded fake-worker smoke test, cap
launches explicitly:

```bash
onyx research run --campaign fast-eval --workers 2 --max-concurrency 2 --max-launches 2 --worker-command "<cmd>"
```

For large local runs, the supervisor ramps launches in batches
(`--launch-batch-size`, default up to 10) separated by
`--launch-interval-seconds` (default 5), backs off with capped exponential
jitter when provider startup, rate-limit, overload, auth, or degraded-service
failures happen, and stops launching new workers once the shutdown cushion
begins or the shared session stop reasons say the experiment budget is
exhausted, reservations expired, a stop was requested, or the session became
terminal.

Sync and presence are bounded for large sessions: `onyx sync` defaults to 50
events per request (`--sync-batch-size`, max 100), the supervisor drains at
most 4 sync batches per interval by default (`--sync-drain-batches`), and
presence sends site telemetry every interval while uploading changed worker
snapshots by default, a full worker snapshot every 60 seconds or final upload,
and at most 250 worker snapshots per request.

Codex and Claude are first-class built-in launchers. Both are spawned directly
in non-interactive mode with the same Onyx CLI surface as the orchestrator,
receive the worker prompt over stdin, and write raw stdout/stderr logs,
readable `.activity.log` files, structured `.activity.jsonl` files,
per-worker latest-state JSON snapshots, and launch manifests under
`.git/onyx/worker-logs/`. `onyx research run` owns local worker scheduling,
the supervisor-owned push/sync queue with default concurrency 4, adaptive
coalesced presence updates, sampled durable heartbeats, stop handling, and
final sync for the session. `onyx research status --json` reports fresh
supervisor telemetry when available, including active process count, launch
rate, provider backoff, recent launch failures, PID, and log path. `onyx worker run --session <id> --hypothesis <id>` remains available
as a low-level debugging and recovery primitive.
`onyx research status` shows active-session hypotheses and workers by default,
including activity/raw log paths, last-output age, timeout state, and manifest
errors when local manifests are available. `--max-experiments` is the global
attempt budget and `--max-worker-iterations` is a per-worker safety cap.
`onyx listen` shows the same local worker latest-state/manifests and active
provider backoff metadata alongside the experiment/outbox view.
`--max-launches` caps only new workers launched by the current
supervisor invocation and does not change the session's active slot target.
`onyx workflow status --active` shows only actionable running or paused
workflow runs; use `onyx workflow status --blocked` or `--run <id>` for blocked
diagnostics.

Each worker gets its own work branch under `refs/heads/onyx/<session>/<worker>`,
and its worktree lives at `.git/onyx/worktrees/<sessionId>/<workerId>`, while
worker prompts and logs live under `.git/onyx/`. Workers run `onyx research brief`
for current campaign memory, poll `onyx research should-stop`, run the setup workflow through `onyx exp run
--campaign <name> --base <sha> --auto` and `onyx exp run --resume <id> --auto`,
push `refs/onyx/experiments/<campaignId>/<runRef>`, and report the experiment
with setup/session/hypothesis/worker context. `onyx research hypothesis add`
can create another campaign hypothesis at any time from a JSON plan file or inline
focus/hypothesis flags; a running supervisor picks up new active hypotheses as
soon as worker slots open. Workers
publish shared learning with `onyx knowledge add` and read it back with
`onyx knowledge list`, but successor hypothesis selection remains an
orchestrator/human decision.
After the agent exits, the worker harness performs one final best-effort
commit, checks whether HEAD is already represented by a local experiment,
measures/logs exactly one unlogged HEAD commit using that commit's parent as
the workflow base, and pushes the worker branch so useful offline work is not
lost. Multi-commit, restore-forward, or dirty salvage preserves the branch
without producing a measured experiment or blocked workflow run. Worker
manifests report `finalizationStatus` as `none`, `already_logged`,
`measured_and_logged`, `salvaged_unmeasured`,
`salvaged_unmeasured_budget_exhausted`, or `failed`. If
`onyx research stop` is requested while a provider process is still running,
the harness gives it the configured stop grace (30 seconds by default),
terminates it if needed, then runs the same finalization path. Use
`--worker-command` only for custom harnesses.

Stop and finalize campaigns explicitly:

```bash
onyx research stop --session <id>
onyx research finish --campaign fast-eval
```

`finish` reconciles state, drains final sync, prints accepted/pending/conflict
counts, and prints local extraction branches such as `onyx/fast-eval/best`.

To delete a research direction entirely — the campaign record with all its
experiments and matching local cache rows:

```bash
onyx campaign delete --name fast-eval
```

Deletion writes a local tombstone and sync event first, so it can be queued
offline and replayed safely. The server also tombstones deleted campaigns and
experiments so stale SQLite sync events cannot resurrect them. Recreating a
campaign with the same name later is fine because tombstones only match records
created before the deletion.

## Development

```bash
bun install
bun run ci
```

To make the persistent `onyx` command use this checkout during development:

```bash
onyx developer link .
onyx developer use dev
```

Developer mode runs source through Bun and replaces
the managed Claude and Codex skill files with symlinks to this checkout's
`skills/onyx/SKILL.md`, so active agents see skill edits from local source.
Return to the installed release with:

```bash
onyx developer use release
```

Restart or reload active agent sessions if they cache skill files.

When public CLI commands, flags, profile behavior, local state, sync behavior,
or the bundled agent skill changes, update the public docs in
`/Users/ted/onyx/docs` in the same change.

Release binaries are built from Bun standalone executables:

```bash
bun run build:release
```

## License

Apache-2.0
