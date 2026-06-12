# Onyx Agent

Open-source agent package for Onyx research workflows.

It installs the `onyx` command and the bundled `onyx` agent skill. The command
is terminal-only: agents make code changes in your existing git repository,
commit to `onyx/{name}` branches, run repo-local evals, and report experiment
metadata to the Onyx app.

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
onyx branch create --name fast-eval --metric score --direction maximize
onyx exp run
onyx exp log --description "baseline"
onyx push
```

The CLI stores local retry state under `.git/onyx/` and flushes it to `/api/v1`
when connectivity and credentials are available.

To delete a research direction entirely — the Onyx branch record with all its
experiments, the remote and local `onyx/<name>` git branches, and matching
local cache rows:

```bash
onyx branch delete fast-eval
```

Deletion requires connectivity (it is never queued). The server tombstones
every deleted experiment's `runRef`, so an offline agent that still has them
queued skips them on its next sync instead of resurrecting them. Recreating a
branch with the same name later is fine — tombstones only match records
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
