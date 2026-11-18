# @onyx-robotics/agent

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
