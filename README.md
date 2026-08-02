# Onyx Agent

Open-source agent package for Onyx research workflows.

It installs the `onyx` command and the bundled `onyx` agent skill. The command
is terminal-only: agents make code changes in your existing git repository,
commit measured attempts, push immutable experiment refs best-effort, and report
experiment metadata plus setup, hypothesis, and worker state to the Onyx app.

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
entries; profile listing includes each profile's worker defaults. Use
`onyx profile worker set --agent codex|claude|opencode [--model <model>]` to
store default worker settings for new research sessions; `--agent` and `--model`
flags on `onyx research run` override those defaults.

Only for local app development, point the agent at a non-production API.
`--local` is shorthand for `--api-url http://localhost:3000`:

```bash
onyx login --local
```

This stores a separate profile for the local app; switch between it and the
hosted app with `onyx profile use <name>`. Developer mode
(`onyx developer use dev`) changes which CLI source runs, not which app the
CLI targets.

## CLI analytics

Official Onyx releases collect one structured outcome event per allowlisted
user command, starting from the first eligible command. The first eligible
interactive command also prints a one-time telemetry notice to stderr
describing collection and how to opt out; the notice is informational and
does not gate collection. Events
may include the bounded command name, terminal outcome, rounded duration,
stable failure stage/reason, version, auth state, and internal team ID. They
never include arguments, environment variables, local paths, repository
identity, refs or commits, code, diffs, prompts, research content, metric names
or values, credentials, exception text, worker output, rendering, keys, rows,
or polling.

No analytics runs in `onyx-worker`, CI, testbed/synthetic-worker environments,
developer/source builds, or non-production API profiles. A random installation
ID is used before the next successful login supplies an internal user ID; old
installation activity is never linked to that user. Delivery is best effort,
has a 250 ms shutdown budget, creates no outbox, and cannot change a command's
exit code.

```bash
onyx telemetry status
onyx telemetry disable
onyx telemetry enable
```

`ONYX_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` always disable collection.

## Agent Skill

The installer installs the bundled skill automatically for Claude Code, Codex,
and OpenCode. It writes Claude's personal skill file at
`~/.claude/skills/onyx/SKILL.md`, Codex's user skill file at
`~/.agents/skills/onyx/SKILL.md`, the Codex home skill file at
`${CODEX_HOME:-~/.codex}/skills/onyx/SKILL.md` for Codex builds that discover
skills from `CODEX_HOME`, and OpenCode's global skill file at
`~/.config/opencode/skills/onyx/SKILL.md`. The canonical source is
`skills/onyx/SKILL.md`; after editing it, run `bun run generate:skill-content`
so the embedded release fallback stays in sync. To install it manually:

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

The CLI writes research product state directly to `/api/v1`. Supabase/API owns
campaigns, sessions, hypotheses, worker leases, experiments,
knowledge, stop state, report settlement, and accepted experiment ordering.
Local `.git/onyx/` files are runtime artifacts: logs, manifests, workflow
runs, transient pending-report outbox entries, session/control snapshots,
resource locks, and a small `state.json`
convenience cache.
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
constraints. The supervisor writes a shared local session-state brief for
routine worker context; workers use targeted CLI commands only when they need
deeper prose memory or history.

Research commands require API access. The supervisor uses server-assigned
leases, renews worker liveness in batches, and owns stop scheduling. Workers
receive one short-lived scoped credential rather than the supervisor's team API
key. The worker API derives their full assignment identity and exposes only
brief, experiment, knowledge, and heartbeat operations.
attempt to push immutable experiment refs while reporting; failed pushes are
recorded as local-reported evidence instead of blocking metrics. Experiment
report calls return `recorded` or `duplicate`, and later settlement assigns
accepted/discarded disposition plus accepted indexes. `onyx exp list`,
`onyx research status`,
`onyx listen` and `knowledge list` read remote API state
instead of offline local projections.

`onyx campaign setup` and `onyx research run` require the `onyx/` setup
surface to be committed. This keeps each session assignment pinned to a commit
that actually contains `setup.json`, `validation.json`, `onyx.md`, and
declared workflow tools. GitHub App access is optional for local research:
public repositories can show web code/diffs once commits and refs are pushed to
GitHub, while private repositories record local-reported commits and metrics
until the GitHub App is connected for private code/diff viewing and
verification. After pushing missing refs or connecting GitHub, use the web
campaign page or `onyx research status --reconcile` to refresh Git verification
state.

For `github_public` and `github_app` projects, the exact session and assignment
base commits must also be visible to GitHub. Push them before starting Research;
the CLI reports the invisible commit without creating a session when preflight
validation fails.

Tool commands in `onyx/setup.json` are language-flexible: point them at Bash,
Python, Node, hardware vendor CLIs, compiled binaries, or any executable
available to the project.

Hypothesis workers are driven by the static Markdown prompt in
`prompts/worker-agent-prompt.md`. It references worker environment variables
(`$ONYX_WORKER_BIN`, `$ONYX_PROJECT_ROOT`, deadlines, and setup file paths)
instead of interpolated values, so workers can always re-read live values, and
the session-state brief remains the single routine context source. After
editing it, run `bun run generate:worker-prompt-content` so the embedded
release fallback stays in sync and standalone release binaries stay
self-contained.

Add durable hypotheses, then start a fresh bounded session with the repo-level
supervisor:

```bash
onyx research hypothesis add --campaign fast-eval --name bounded-search --focus "Try a bounded search" --hypothesis "A focused local change can improve the configured metric."
onyx research run --campaign fast-eval --workers 4 --agent codex --max-minutes 10 --experiments 20
onyx research hypothesis add --campaign fast-eval --focus "Try a fresh hypothesis" --hypothesis "The new direction may improve score"
```

`onyx research run` validates committed setup and evaluator fingerprint inputs,
resolves the provider and worker CLI to absolute paths, performs one structured
model probe plus a protocol handshake, and aborts before creating a session if
any deterministic compatibility check fails. It then
always creates a new assignment-backed session, and starts a detached supervisor by
default, then prints the session id, supervisor PID, log path, and monitoring
commands before returning. Use `--json` for parseable startup output in
orchestrator agents, and `--foreground` only when you intentionally want an
attached debugging or smoke-test shell.

Omitting `--workers` selects one. It is the active slot target: when a short worker exits, the
supervisor backfills that slot while the session is running. Bound sessions with
`--experiments <n>` for an exact accepted experiment target, `--max-minutes <n>`
for a deadline, or both:

```bash
onyx research run --campaign fast-eval --workers 2 --max-concurrency 2 --experiments 2 --worker-command "<cmd>"
```

For large local runs, the supervisor ramps launches in batches
(`--launch-batch-size`, default up to 10) separated by
`--launch-interval-seconds` (default 5), backs off with capped exponential
jitter only for transient provider rate-limit, overload, or unavailable
failures, and asks the server for worker leases in idempotent batches.
Deterministic auth, model, protocol, network-policy, and sandbox failures stop
the site immediately; evaluation, git, and report-delivery failures retain
distinct non-backoff terminal reasons.
The server enforces the worker target, assigns hypotheses, records reports, and
settles accepted/discarded disposition idempotently after completion. Batch
leases return one compact shared research context plus per-worker grants, while
the supervisor's control poll reads aggregate progress/capacity and canceled
assignment IDs instead of full worker or assignment lists.
Use `onyx research scale --workers <n> --session <id>` to change capacity;
scale-down drains naturally. New hypotheses join future sessions only, while
closing a hypothesis cancels its open assignments and workers immediately.

Presence is bounded for large sessions: the supervisor sends site telemetry
every interval while uploading changed worker snapshots by default, a full
worker snapshot every 60 seconds or final upload, and at most 250 worker
snapshots per request.

Codex, Claude, and OpenCode are first-class built-in launchers. All are spawned
directly in non-interactive mode, receive the worker prompt over stdin, and use
the explicit `onyx-worker` CLI surface for worker-safe primitives while the full
`onyx` CLI remains the user/orchestrator surface. Supervised workers get
isolated `ONYX_HOME` plus `ONYX_WORKER_CONTEXT` under
`.git/onyx/worker-runtime/<session>/<workerId>/`, and write raw stdout/stderr logs,
readable `.activity.log` files, structured `.activity.jsonl` files,
per-worker latest-state JSON snapshots, and launch manifests under
`.git/onyx/worker-logs/`. Runtime directories and context files use restrictive
permissions, retained output is stream-redacted, and credential-bearing runtime
directories are deleted during teardown. `onyx research run` owns local worker scheduling,
server lease acquisition, session-state brief refreshes, supervisor-owned
control polling, adaptive coalesced presence updates, batch heartbeats, stop
handling, and local child cleanup. `onyx research status --summary --json`
provides bounded orchestrator telemetry; detailed `onyx research status --json` reports fresh
supervisor telemetry when available, including active process count, launch
rate, provider backoff, the no-progress breaker, recent launch failures, PID,
and log path. `onyx worker run --session <id> --hypothesis <id>` remains available
as a low-level debugging primitive.
`onyx research status` shows active-session hypotheses and workers by default,
including activity/raw log paths, last-output age, timeout state, and manifest
errors when local manifests are available. `--experiments` is the exact accepted
experiment target and `--max-minutes` is the optional deadline.
`onyx listen` shows the same local worker latest-state/manifests, terminal
reason and cleanup outcomes, active provider backoff, and no-progress breaker
alongside the remote experiment view.
`onyx workflow status --active` shows only actionable running or paused
workflow runs; use `onyx workflow status --blocked` or `--run <id>` for blocked
diagnostics.

Each worker gets a detached disposable worktree at
`.git/onyx/worktrees/<sessionId>/<workerId>`, while
worker prompts and logs live under `.git/onyx/`. Workers run
`onyx-worker research session-state-brief --json` for bounded routine context and
worker-specific stop guidance. They inspect `stop.shouldStopStartingNewWork`
and `stop.recommendedAction` at the start of each loop, use
`onyx-worker research brief` only for fuller prose memory, run the setup
workflow through `onyx-worker exp run --campaign <name> --auto` and
`onyx-worker exp run --resume --auto`, push
`refs/onyx/experiments/<campaignId>/<runRef>`, and report the experiment with
setup/session/hypothesis/worker context. `onyx research hypothesis add`
can create another campaign hypothesis at any time from a JSON plan file or inline
focus/hypothesis flags; a running supervisor picks up new active hypotheses as
soon as worker slots open. Workers publish shared learning with
`onyx-worker knowledge add` and read selected complete items through the
session-state brief. `onyx-worker knowledge list --json` provides deeper
history when needed, but successor hypothesis selection remains an
orchestrator/human decision.
Workers run in detached disposable worktrees and never create or push worker
branches. After the agent exits, the harness may deliver exactly one already
terminal measured attempt, then removes the worktree. It never creates a final
commit, runs evaluation, or reports dirty, partial, multi-commit, or ambiguous
scratch work. Manifests retain bounded diagnostics and report terminal attempt
delivery plus worktree cleanup outcomes, provider exit/signal/timeout details,
and stable terminal reason codes. If
`onyx research stop` is requested while a provider process is still running,
the harness gives it the configured stop grace (30 seconds by default),
terminates it if needed, then runs the same teardown path. Use
`--worker-command` only for custom harnesses.

Stop sessions explicitly:

```bash
onyx research stop --session <id>
```

Campaigns remain active until explicitly archived.

To delete a research direction entirely — the campaign record with all its
experiments and matching local cache rows:

```bash
onyx campaign delete --name fast-eval
```

Deletion is applied directly through `/api/v1`; the server owns tombstones for
deleted campaigns and experiments. Recreating a campaign with the same name
later is fine because tombstones only match records created before deletion.

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

Developer mode runs source through Bun and replaces the managed Claude, Codex,
and OpenCode skill files with symlinks to this checkout's `skills/onyx/SKILL.md`,
so active agents see skill edits from local source.
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
ONYX_POSTHOG_KEY=phc_production_project_token \
  ONYX_POSTHOG_HOST=https://e.onyxresearch.ai \
  bun run build:release
```

The release workflow reads the public production project token from the
`ONYX_POSTHOG_KEY` GitHub Actions secret. Source builds remain telemetry-off,
and the build keeps the token and all analytics code out of `onyx-worker`.

## License

Apache-2.0
