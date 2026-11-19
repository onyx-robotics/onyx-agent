---
name: onyx-research-setup
description: Set a repository up for an Onyx research run (onyx research), with the user - the goal and metrics, endpoint drivers and guides, onyx/research.json, and sites for hardware or other machines - then check every piece before the run. Use when the user asks to set up, prepare or configure an Onyx research or autoresearch run, add an endpoint or a site to one, or asks how to start with onyx research.
---

# Setting a repository up for an Onyx research run

A run needs, in the repository: `onyx/research.json`, a driver and a guide for each endpoint, and names for the endpoints' types and the metrics, which the run adds to the org's registry. You write them with the user, check each one works, and hand over `onyx research setup` and `run`. The package's `GETTING_STARTED.md` is the same path for a person; use the `onyx` skill for the CLI itself.

Work in this order. Don't write files before step 2's answers, and don't start a run: that's the user's call (step 8).

## 1. Check what's there

- `onyx whoami`: signed in, and to the right org. Exit 4: the user runs `onyx login` themselves (in Claude Code, `! onyx login`). Never handle a token.
- `claude --version` or `codex --version`, and `git remote -v`: the run's agents are sessions of Claude Code or Codex CLI, whichever the config's `agent` names (`claude`, the default, or `codex`), even when you, setting it up, are another coding agent. Ask the user which, when both are signed in. Workers push branches to a remote, which must exist and be pushable. A bare repository (`git init --bare`) is fine for a first try on one machine.
- Linux or macOS (WSL on Windows).
- `onyx/research.json` already there: read it and its endpoints' guides, and change only what the user asks.
- `onyx registry show types` (the ones whose `parent` is `research_endpoint`, or a subtype of it) and `onyx registry show props` (those with `metric: true`): endpoint types and metrics the org already has. Reuse them when they fit rather than inventing near-duplicates.

## 2. Ask the user

Ask what you can't read from the code, in one go:

- **The goal**: what to improve, what must stay true (validity, limits, safety), and what an agent wouldn't know (what's been tried, where hardware is, what breaks it).
- **The metrics**, each with its direction, and which matters most.
- **What agents may edit**: the method's files. The measurement (the config's `measurement` paths, `onyx/endpoints` by default) changes only in a measurement hypothesis, which the var-op proposes.
- **Where experiments run**: this machine (a benchmark, a simulator), or hardware or another machine (a site, step 6). How long one takes, and how many can run at once.
- **The budget**: workers and minutes. A run spends the user's coding-agent usage, mostly in workers' turns; say so.

## 3. The vocabulary (names)

Name each endpoint type and each metric `<namespace>.<name>`, one namespace for the project (a built-in metric like `score` as it is). There's no pack to write or load: the run adds the config's types and metrics to the org's registry when it starts, only those the org doesn't have, and never changes one that's there. See `GETTING_STARTED.md`, step 4.

- Every metric the drivers report goes in the config's `metrics`, with its direction, or a result is refused. Give it a `label` and a `unit` where the key doesn't say them.
- A key the org already has keeps its meaning: check `onyx registry` for one the project means to reuse, and pick a new name if it means something else.

## 4. Endpoints this machine runs

For each, write in `onyx/endpoints/`:

- **The driver**: run in a checkout of an experiment's commit, from the repository's root, with the worker's packet path appended if it named one. It prints its log and ends with one line `METRICS {json}`, keys from the config's `metrics`; exit 0. A failure says why in its last lines. Keep it honest: measure the way the user does, time against a reference where speed matters, check validity.
- **The guide** (`<name>.md`, about ten lines): the packet (usually the commit itself), what it measures and how, what's in the log, how long one takes, its rules. Workers read it before every experiment.
- **A CPU endpoint**: offer one for processes that need no hardware, so workers have somewhere to run any program longer than about a minute. Workers send those as experiments too, and a turn spent running a process locally holds a worker slot.

## 5. The config

Write `onyx/research.json` (fields: `GETTING_STARTED.md`, step 6, and the package README). Then:

- `remote`: the URL every endpoint fetches from, exactly; workers push there.
- `capacity`: what the endpoint really runs at once (1 for a single rig). `timeoutS`: the time limit per experiment the run starts with, a hard cutoff sent with each experiment to the driver (`time_limit_s` in its params); the user can change it during a run (`onyx research limit`).
- `workers`: about the endpoints' total capacity, since a waiting worker frees its slot; fewer if experiments are slow.
- Set `agent` to `codex` if the run's agents are to be Codex CLI sessions (leave it out for Claude Code). Leave `models` to their defaults unless the user asks.
- Add `.onyx-research/` to `.gitignore`.

## 6. Sites: hardware and other machines

A site is a machine running `onyx-site`, which takes jobs for its units from the org's queue. An endpoint it runs has `"site": true` and no `driver` in the config. Its setup is on that machine, partly by hand (installing, approving): tell the user what to do there, and write what you can.

- **First, check whether the machine already is a site.** Run `onyx-site status` there, and ask the user. A machine has one site, enrolled once, whatever runs on it: if it already is one, never enrol it again. Add the endpoint to that site's file instead (its type in `[policy] unit_types`, a driver and a unit for it, the repository if it's a new one), restart `onyx-site run`, and check the new unit in `onyx-site status`. Enrolling again makes a second site for the same machine, with a second key that replaces the first on disk.
- **Install**: `onyx-site` is on PyPI: `uv tool install 'onyx-site[keyring]'`, as the user that runs it. A driver's libraries go into its Python: `uv tool install --force --with <package> 'onyx-site[keyring]'`.
- **The site file**: `[policy] unit_types` lists the endpoint types; `[repos.<name>] url` is the run's `remote`, character for character; `[files] public_url` is reachable from the machine the run is on (it downloads experiments' files from there).
- **Read access, the site's own**: the site fetches each commit itself, with a read-only deploy key made on its machine (`ssh_key`), added to the repository without write access (`gh repo deploy-key add <key>.pub -R <repo>`), and GitHub's host key in the site user's `known_hosts`, taken from `gh api meta` (the site fetches with `StrictHostKeyChecking=yes`). onyx-site's setup guide, "Giving the site read access to a repository", has the steps. Never route around it: no path mappings to a local copy, no shared folders, no key that can push. A site that can't fetch the run's remote can't run its experiments, and that's what to fix.
- **A program in the repository** (most experiments): the shipped `onyx_site.drivers.local_program:LocalProgram` driver runs a `command` in the experiment's commit. It reports metrics from `$ONYX_OUT/metrics.json`, not a `METRICS` line, and keeps everything in `$ONYX_OUT`; the job's props (the packet included) are in `$ONYX_PARAMS`. Write the endpoint's program to that contract.
- **Hardware with a long-lived connection** (a robot's server, a serial bus): a driver of its own (`DRIVERS.md` in the site-runner). Put the hardware's limits in the goal and the guide: joint ranges, currents, what tripped it before, what a person must do to recover it.
- **Enrol**, only a machine that isn't a site yet: `onyx-site enrol` on that machine; an admin approves the code it prints. Then `onyx-site run` as a service, and `onyx-site status` shows its units.

## 7. Check every piece

Nothing goes to the run unchecked:

1. `onyx research vocabulary onyx/research.json` adds the config's endpoint types and metrics the org doesn't have (setup and run do it too; a site's check below needs them first). For each key it didn't add, `onyx registry show props <metric>` has the direction the config says.
2. Each driver stops an experiment at its `time_limit_s` (in the job's params, `$ONYX_PARAMS` for `local_program`): the site-runner only passes it on.
3. Each driver of this machine, in a clean checkout of `HEAD` (`git worktree add /tmp/check HEAD`): runs, and its last line is `METRICS` with every metric's key.
4. Each site's read access, as it will fetch: with `GIT_SSH_COMMAND="ssh -i <its key> -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"`, `git ls-remote <remote> main` answers, and a push with that key is refused.
5. Each site endpoint: one job by hand on a pushed commit (`onyx run -f -` with `on`, and `props.git` = `{url, commit, ref}`), ended `succeeded`, with its metrics and files (`onyx jobs get <id>`).
6. Commit and push `baseBranch` to `remote`.

## 8. Hand over

Tell the user what you set up and what you checked, then the commands:

```bash
onyx research setup onyx/research.json   # the base agent studies the repository (minutes, a few dollars)
onyx research run onyx/research.json     # until minutes are up; keep the terminal and machine on
onyx research steer onyx/research.json "<a note for the var-op>"
```

Starting a run is theirs to decide: say how long it lasts and that it spends their coding-agent usage, and start it only if they ask, in the background or in their terminal. After setup, read its summary (`.onyx-research/<run>/base-summary.md`) with them: if the base agent misunderstood the problem, fix the goal or a guide and run setup again.
