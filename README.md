# Onyx Agent

Open-source agent package for Onyx research workflows.

It installs the `onyx` command and the bundled `onyx` agent skill. The command
is terminal-only: agents make code changes in your existing git repository,
commit to `onyx/{name}` branches, run repo-local evals, and report experiment
metadata to the Onyx app.

## Install

```bash
curl -fsSL https://onyxresearch.ai/install.sh | sh
```

The installer puts `onyx` in `~/.local/bin` by default, walks you through PATH
setup if your shell needs it, and then offers browser login or a global
`ONYX_API_KEY` environment variable.

Verify the command:

```bash
onyx --version
```

For non-interactive installs, set `ONYX_INSTALL_NO_PROMPT=1`. For explicit
system-wide installs, choose a writable install directory:

```bash
ONYX_INSTALL_DIR=/usr/local/bin curl -fsSL https://onyxresearch.ai/install.sh | sh
```

If you skip authentication during install, run `onyx login` later.

Profiles are team-scoped. Use `onyx profile list`, `onyx profile use <name>`,
and `onyx profile delete <name>` to inspect, switch, or remove local profile
entries.

Only for local app development, point the agent at a non-production API:

```bash
onyx login --api-url http://localhost:3000
```

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
