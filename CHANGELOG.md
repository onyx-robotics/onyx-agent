# @onyx-robotics/agent

## 0.4.0

### Minor Changes

- `onyx/research.json` names the coding agent a run's agents are sessions of (`agent`, `claude` by default), and `onyx research` checks that one before it starts. A role the config gives no model gets its CLI's choice for it, as before for Claude Code (`opus`, `sonnet`, `haiku`). A run set up with one agent refuses to carry on with another and says to run setup again.
- Research runs take each agent's instructions from its skill: `skills/onyx-research-base`, `-varop` and `-worker`, built into `onyx` and installed by `onyx setup`. Agents can only do their own job: the base agent and the var-op read and run nothing but `onyx research`, and a worker edits code and runs only `onyx research` and read-only git, so every computation is an experiment on an endpoint. The var-op starts each wake afresh from the base agent with the board and its journal, so a wake's context doesn't grow over the run. Each endpoint has a time limit per experiment for the run, a hard cutoff sent with every experiment to its driver (`time_limit_s`), which the user changes with `onyx research limit`. Experiments say what they're for (`--kind`), measurement changes are hypotheses of their own (`propose --measurement`, and results measured differently are never compared), and a hypothesis can be finished without an experiment. A refused command no longer stalls an agent: it's told which command was refused, and the var-op is told why a worker stopped. A run's experiments are held to twice its endpoints' capacity, and runs sharing an endpoint get a fair share of it. The quick evaluation and the turn time limit are gone.
- A research run's agents can be Codex CLI sessions: `"agent": "codex"` in `onyx/research.json`, with Codex signed in. Workers are forks of the base agent's session, as with Claude Code, and each agent is held to the same rules: a PreToolUse hook (`onyx research gate`) lets a worker's shell run only `onyx research` and read-only git, the base agent and the var-op edit nothing, and a ghost has no shell. A turn where Codex ran something the gate didn't see fails rather than being trusted. Codex agents use your Codex's default model unless `models` says. `CODEX_API_KEY` (not `OPENAI_API_KEY`) counts as signing Codex in.
- `onyx research plot <config>`: a run's plot in the app (`/items/<campaign>/plot`: a lane per track, the run's score over time), which `onyx research setup` and `run` also print. A hypothesis is now linked to its campaign as well as its track when it's proposed, so the campaign finds its experiments; `onyx research plot` links an earlier run's hypotheses too.
- `onyx research run <config> --minutes <n>` resumes a run with that much more time to propose, a run whose time is up included: the workers' turns it cancelled at its end are sent again, and the hypotheses it cancelled leave the board. A run's supervisor leaves the queue when it stops, so its slots are archived rather than left offline. An experiment the supervisor runs itself has its own process group, so its time limit ends whatever the driver started. The setup skill checks whether a machine already is a site before enrolling it, and adds the endpoint to that site instead.
- `onyx setup` checks Claude Code and Codex CLI, and is ready when one of them is, and installs the skills where each one it finds reads them: `~/.claude/skills`, and `~/.codex/skills` (or `$CODEX_HOME/skills`); with `--project`, the folder's `.claude/skills` and `.agents/skills`. Its JSON output's `skills` gains `dirs`, every folder it wrote (`dir` is the first). The docs and the skills say a run's agents are Claude Code or Codex CLI sessions, whichever the config's `agent` names.

### Patch Changes

- A Codex worker of a research run is told it creates and edits files with apply_patch inside its working directory and the directories it's given, and to write its state for `onyx research finish` there. It was told only that anything that writes is refused, so a worker could give up on finishing.
- Codex agents of a research run can read the code and send experiments. An agent that may read files may read them with its shell, as Codex does (`cat`, `sed -n`, `rg`, `find` and the like; nothing that writes or runs a program) and look at images, and is told so. A worker runs outside Codex's sandbox, which kept its worktree's git metadata read only so `onyx research experiment` couldn't commit; its gate holds it to its rules instead, as before, and now also keeps its edits where it works and in the directories it's given, as Claude Code's are.
- The docs, the skills and `onyx setup`'s help speak of your coding agent (Claude Code or Codex CLI) rather than Claude Code alone.
- The docs and the skills install `onyx` from the public releases (`curl -fsSL https://raw.githubusercontent.com/onyx-robotics/onyx-agent/main/scripts/install.sh | sh`, no Bun or Node needed) and `onyx-site` from PyPI, rather than from a checkout of Onyx's private repository. The README leads with the binary; npm is for the SDK, or with Bun.
- The guides to setting up a site and writing its drivers are here now, in `docs/sites/` (`SETUP.md`, `DRIVERS.md`), and in the package: the onyx-site README on PyPI and `GETTING_STARTED.md` link to them.

## 0.3.0

### Minor Changes

- `onyx research image <file> ... [--on <item>] [--caption "..."] [--step <n>]`: a worker puts checkpoint screenshots and GIFs (PNG, JPEG, GIF or WebP, at most 4 MB each) on an item's page in the app, its hypothesis by default. Workers are told about it in their prompt. The SDK's `uploadFile(entity, bytes, { name, caption, step })` does the same from code.
- The contracts' `queueHistoryQuery`: a card's queue over a window of the past (`POST /api/v1/views/queue/history`), its units' busy time and the runs that started on them in bins (5 minutes to 28 days), their state over it and, with `runs`, the runs on them.
- The contracts' `clearQueueInput` and `ClearQueueResult`: `POST /api/v1/jobs/queue/clear` cancels every waiting job the caller may cancel (anyone's for an admin, their own otherwise), or only those waiting for one kind of unit (`on`), or only those pinned to one unit (`unit`); what's running carries on.
- `onyx research` adds the endpoint types and metrics named in `research.json` to your org's registry when a run is set up or started, so there's no `onyx/pack.yaml` to write or ask an admin to load. Metrics take an optional `label` and `unit`; `onyx research vocabulary <config>` adds them without starting anything; the SDK has `extendRegistry`.
- `onyx setup [--project]`: one command for a new machine. It checks git and Claude Code, signs you in if you aren't, and installs the package's skills for Claude Code in `~/.claude/skills` (or the project's `.claude/skills`). The skills are part of the program, so a standalone binary installs them too. Copying `skills/` by hand still works.

### Patch Changes

- `onyx research setup`, `run` and `greedy` check the machine before they start: git, the coding agent the run's agents are sessions of (installed and, where its CLI can say, signed in), and the config's `baseBranch` on its `remote`. They list every problem at once with its fix, instead of the base agent or a clone failing minutes in. The checks know Claude Code, Codex CLI, Gemini CLI and opencode; runs still use Claude Code.
- The contracts' workspace documents: a Plot panel can hold several fields up (`more`, beside `y`), each plotted as a series of its own. Documents without it read as before.
- `onyx ingest` points a person at their new items with `see it in the app: <url>`, no longer naming the app's "Your work" button, which is gone. The `url` in its last JSON record is unchanged.
- The contracts' workspace documents: a Queue panel can hold where its timeline looks (`window`: a span up to now, which it follows, or a stretch of the past). Documents without it read as before.
- The contracts' workspace documents: a Queue panel can hold how its timeline is opened (`folded`: kinds of unit folded to one row; `opened`: units opened to a row per run). Documents without them read as before.
- A getting-started guide (GETTING_STARTED.md), from installing to a first research run with endpoints on other machines, and a second skill, `onyx-research-setup`, that lets Claude Code set a repository up for a run with you.
- The contracts' `searchQuery` takes `rows`: each match's serving row as the viewer's views count it, so a client keeps only what's in a view's lanes.
- The contracts' series graph is kept live by deltas and patches: a graph's read says what decides it (`scope`: its lanes, window, limit and match plan), `graphPatchQuery` and `GraphPatch` read some of its nodes again, and a realtime touch hint can be `edges` (an edge from or to each was added, closed or removed).

## 0.2.0

### Minor Changes

- A new package under the same name, for Onyx's platform: the `onyx` CLI (sign in from the browser, then read, log and link work, ingest files, queue jobs and keep an org's pack as code), the SDK as `@onyx-robotics/agent/sdk`, the research runtime as `onyx research`, and a skill for coding agents in `skills/onyx`. It replaces the 0.1 CLI, which is no longer maintained.
