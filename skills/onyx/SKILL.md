---
name: onyx
description: Read and log work in Onyx, an org-wide research graph, with the onyx CLI. Use when the user asks to look up what's been tried or recorded in Onyx, to log experiments, runs, results, metrics or the links between them, to queue a job, or to start or steer an Onyx research run (onyx research).
---

# Onyx from the command line

Onyx is a graph of an org's research: items (experiments, runs, commits, datasets, hardware, ideas, …), edges between them, and metrics. `onyx` reads and writes it for you.

## Before anything

- `onyx whoami` says who you act as, in which org. Exit code 4 means not signed in: ask the user to run `onyx login` in their own terminal (it opens a browser page to approve; in Claude Code they can type `! onyx login`). Don't try to approve it yourself, and never put a token in a command line or a file. `command not found` means it isn't installed: the user installs it from a clone of the monorepo (`git clone git@github.com:onyx-robotics/onyx.git && onyx/install.sh`, which needs Bun) and runs `onyx setup`.
- Several orgs: `onyx org` lists the profiles, `--profile <slug>` picks one for a command. Ask which org if it isn't clear.
- Off a terminal `onyx` prints JSON (errors on stderr as `{"error": {...}}`), so parse it. Exit codes: 0 ok, 2 bad usage, 3 invalid input, 4 not signed in or not allowed, 5 not found, 6 conflict, 7 unavailable, 9 a job didn't succeed. `onyx help <command>` gives a command's flags.

## Read before you write

Items are named by id or by source key `system:key` (`git:9f2c1e`, `ci:run-812`).

```bash
onyx registry show                         # the org's types, relations, props, dims (compact JSON)
onyx registry show experiment              # one definition, by key
onyx find "arm calibration" --type experiment
onyx ls --type experiment --status running --since 7d   # status classes: pending, running, blocked, succeeded, failed, cancelled
onyx get <item>                            # props, metrics, sources, edges (--history for changes)
onyx lineage <item> --up                   # what it came from (--down: what came from it)
```

Use only the types, relations and props the registry has; if what you need isn't there, tell the user rather than inventing keys (an admin adds them to the org's pack; a research run adds its config's endpoint types and metrics itself).

## Log work

```bash
onyx add experiment "sweep lr 1e-3" --source ci:run-812 --status running --prop lr=0.001 --summary "why and how"
onyx link ci:run-812 checked_out git:9f2c1e
onyx set ci:run-812 --status succeeded --prop loss=0.12
onyx archive <item>                        # nothing is deleted; it stays in history
```

- Give everything you create a `--source system:key` that's stable for what it is (a run id, a commit sha): running the command again updates the item instead of making a second one.
- `--prop key=value` reads the value as JSON when it is (`3`, `true`, `"3"`), text otherwise.
- For more than a few records, or for metrics, write an NDJSON file, one record per line, check it with `onyx ingest file.ndjson --dry-run`, then `onyx ingest file.ndjson`. Sending it again is safe.

```json
{"item": {"ref": "run", "type": "experiment", "name": "nightly", "source": {"system": "ci", "key": "run-812"}}}
{"edge": {"rel": "checked_out", "src": "run", "dst": {"source": {"system": "git", "key": "9f2c1e"}}}}
{"metric": {"entity": "run", "values": {"loss": 0.12}, "step": 1000, "observedAt": "2026-10-10T09:00:00Z"}}
```

## Jobs

`onyx run --on <unit type> --name "<what>" [--prop k=v]... [--wait]` queues work for a unit (a GPU, a bench, a robot); `--wait` follows it and exits 9 if it didn't succeed. `onyx jobs`, `onyx jobs get <id>`, `onyx jobs wait <id>`, `onyx jobs cancel <id>`.

## Research runs

`onyx research` runs agents on the user's machine that improve a repository against its metrics: a base agent studies the code, a variational operator proposes hypotheses, workers test them on the project's endpoints, and what they learn goes into the graph. It needs `onyx login`, a signed-in `claude` or `codex` (the config's `agent`), and `onyx/research.json` in the repository (`onyx research help`, and the package's README for its fields).

```bash
onyx research setup onyx/research.json    # once: the base agent studies the repository
onyx research run onyx/research.json      # until the config's minutes are up
onyx research steer onyx/research.json "<a note for the var-op>"
```

A run lasts as long as its config says and spends the user's coding-agent usage: confirm with the user before you start one, and start `run` in the background or in their terminal. Its state is in `.onyx-research/` in the repository. If you are one of a run's agents, your prompt names the `onyx research` commands you use.

## Ask first

Admin commands (`onyx registry apply`, `onyx units hold`) change the whole org: run them only when the user asks. Signing in, and anything with a token, is the user's to do.
