# Onyx Agent

Open-source agent package for Onyx research workflows.

It installs the `onyx` command and the bundled `onyx` agent skill. The command
is terminal-only: agents make code changes in your existing git repository,
commit measured attempts, push immutable experiment refs, and report experiment
metadata plus setup, lane, and worker state to the Onyx app.

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

The installer installs the bundled skill automatically to Claude Code's
personal skill directory at `~/.claude/skills/onyx/SKILL.md`. To install it
manually:

```bash
onyx agent install-skill
```

To locate the package skill source:

```bash
onyx agent skill-path
```

## Core Workflow

```bash
onyx setup init --goal "Improve score" --metric-name score
# edit onyx/eval.sh so it emits METRIC score=<number>
onyx setup validate --required
git add onyx
git commit -m "Add Onyx setup"
onyx campaign setup --name fast-eval --description "Improve score"
onyx tools run evaluate
onyx research start --campaign fast-eval --agents 4
onyx push
```

The CLI stores local retry state under `.git/onyx/` and flushes it to `/api/v1`
when connectivity and credentials are available.

The bundled `/onyx` skill is the preferred user-facing orchestrator. It creates
`onyx/setup.json`, `onyx/validation.json`, generated `onyx/onyx.md`,
`onyx/tools/*`, `onyx/eval.sh`, and optional `onyx/checks.sh`; validates
required setup modules locally with static checks; then creates an async
research session with deliberate lane plans. Required setup modules are
`setup_spec`, `project_scope`, `agent`, and `evaluation`; optional modules are
`safety`, `reliability`, `reset`, and `resources`. Runtime rigor remains in
`onyx exp run`, which executes reset/eval/check commands, parses metrics, and
records setup compliance.

`onyx campaign setup` and `onyx research start` require the `onyx/` setup
surface to be committed. This keeps worker worktrees pinned to a base commit
that actually contains `setup.json`, `validation.json`, `onyx.md`, and
`eval.sh`.

Tool commands in `onyx/setup.json` are language-flexible: point them at Bash,
Python, Node, hardware vendor CLIs, compiled binaries, or any executable
available to the project.

Lane workers are driven by the TypeScript-rendered Markdown prompt in
`src/lib/worker-prompt.ts`, so prompt variables are typechecked directly in the
editor and standalone release binaries stay self-contained.

To run multiple local research lanes directly from the CLI, choose a built-in
agent launcher:

```bash
onyx research start --campaign fast-eval --agents 4 --lane-plans plans.json --max-minutes 10
onyx worker run --session <id> --lane <lane-id> --agent codex
onyx worker run --session <id> --lane <lane-id> --agent claude
```

Codex and Claude are first-class built-in launchers. Both are spawned directly
in non-interactive mode, receive the worker prompt over stdin, and write live
stdout/stderr logs plus launch manifests under `.git/onyx/worker-logs/`.
`onyx research status` shows active-session lanes and workers by default,
including log paths and last-output age when local manifests are available.

Each lane has a branch under `refs/heads/onyx/<campaign>/lanes/*`, gets a
generated brief and worker prompt under `.git/onyx/`, polls
`onyx research should-stop`, runs the setup contract through `onyx exp run`,
pushes `refs/onyx/experiments/<campaignId>/<runRef>`, and reports the
experiment with setup/session/lane/worker context. Workers publish shared
learning with `onyx knowledge add`. Use `--worker-command` only for custom
harnesses.

Stop and finalize campaigns explicitly:

```bash
onyx research stop --session <id>
onyx research finish --campaign fast-eval
```

`finish` reconciles state and prints local extraction branches such as
`onyx/fast-eval/best`.

To delete a research direction entirely — the campaign record with all its
experiments and matching local cache rows:

```bash
onyx campaign delete --name fast-eval
```

Deletion requires connectivity (it is never queued). The server tombstones
every deleted experiment's `runRef`, so an offline agent that still has them
queued skips them on its next sync instead of resurrecting them. Recreating a
campaign with the same name later is fine because tombstones only match records
created before the deletion.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test
```

To make the persistent `onyx` command use this checkout during development:

```bash
onyx developer link .
onyx developer use dev
```

Developer mode runs source through Bun and replaces
`~/.claude/skills/onyx/SKILL.md` with a symlink to this checkout's
`skills/onyx/SKILL.md`, so Claude Code sees skill edits from local source.
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
