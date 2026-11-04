# @onyx-robotics/agent

[Onyx](https://onyxresearch.ai) is an org-wide research graph: people and AI agents log experiments, data, hardware, ideas and goals, and see what came from what. This package is everything of Onyx that runs on your machine:

- **`onyx`**, the command line: sign in, read the graph, log work, ingest files, queue jobs, keep your org's vocabulary as code.
- **`onyx research`**: autoresearch on your machine. Agents run experiments on your codebase in parallel, and what they learn goes into your org's knowledge graph.
- **The SDK** (`@onyx-robotics/agent/sdk`): `OnyxClient`, for agents, scripts and integrations.
- **A skill for coding agents** (`skills/onyx`): how Claude Code and similar agents use `onyx`.

## Install

```bash
npm install -g @onyx-robotics/agent   # or: bun add -g @onyx-robotics/agent
```

The `onyx` command runs on [Bun](https://bun.sh) (1.3.14 or later), so Bun has to be on your `PATH`. Or take a binary that needs neither Bun nor Node, for Linux or macOS, x64 or arm64, from the [releases](https://github.com/onyx-robotics/onyx-agent/releases):

```bash
curl -fsSL -o onyx https://github.com/onyx-robotics/onyx-agent/releases/latest/download/onyx-darwin-arm64
chmod +x onyx && sudo mv onyx /usr/local/bin/
```

(`onyx-linux-x64`, `onyx-linux-arm64`, `onyx-darwin-x64`, `onyx-darwin-arm64`.)

## Sign in

```bash
onyx login                # shows a code and opens a page: check the code, pick an org, approve
onyx whoami               # who you act as, in which org
```

`onyx login` signs in to `https://app.onyxresearch.ai` (`--url <url>` for another server). It works the way `gh` does: approve this machine in your browser (over SSH, open the printed page anywhere). The sign-in acts as you in the org you chose, lasts 30 days after it was last used (90 at most), and `onyx logout` revokes it. `--admin` also asks for the admin scope.

Each org has its own profile: `onyx org` lists them, `onyx org use <slug>` switches, `--profile <slug>` picks one for a command. Profiles live in `~/.config/onyx/config.json` (or `$XDG_CONFIG_HOME/onyx`, or `$ONYX_CONFIG`), readable by you only.

**In CI and scripts**, use a personal token (Account → Personal tokens) or an API key (Admin → API keys, which acts as its AI agent): set `ONYX_URL` and `ONYX_TOKEN`, or `echo "$ONYX_TOKEN" | onyx login --with-token`.

## Use it

Items are named by id, or by a source key `system:key` (`git:9f2c1e`, `plm:arms/arm-2`).

```bash
onyx registry show                                   # the org's types, relations, props and dims
onyx find "arm calibration"                          # items by name
onyx ls --type experiment --status running --since 7d
onyx get git:9f2c1e                                  # an item: props, metrics, sources, edges
onyx lineage <item> --up                             # what it came from

onyx add experiment "sweep lr" --source ci:run-812 --status running --prop lr=0.001
onyx link ci:run-812 checked_out git:9f2c1e
onyx set ci:run-812 --status succeeded --prop loss=0.12
onyx ingest runs.ndjson                              # items, edges, metrics and refs, one per line

onyx run --on gpu --name "train v3" --wait           # queue a job, follow it to its end
onyx jobs                                            # what's in flight

onyx registry plan packs/acme.yaml --detailed-exitcode   # your org's pack as code, in CI
onyx registry apply packs/acme.yaml --yes --wait
```

`onyx help` lists every command and `onyx help <command>` its flags.

**Output.** At a terminal you get tables and sentences; anywhere else (a pipe, a script, an agent) JSON: one document per command, NDJSON for streams. `--json` and `--human` choose. Errors go to stderr. Exit codes say what happened:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected error |
| 2 | Bad usage |
| 3 | Invalid input, or a refusal in a registry plan |
| 4 | Not signed in, or not allowed |
| 5 | Not found |
| 6 | A conflict a retry won't fix |
| 7 | Unavailable after retries |
| 8 | The registry plan has changes (`--detailed-exitcode`) |
| 9 | A job ended without succeeding (`run --wait`, `jobs wait`) |

**Ingest files** hold one record per line, each `{"item": …}`, `{"edge": …}`, `{"metric": …}` or `{"ref": …}`. Every item carries a key (an `id`, a `source` or an `identity`), so the same file sent again gives the same state:

```json
{"item": {"ref": "run", "type": "experiment", "name": "nightly", "source": {"system": "ci", "key": "run-812"}}}
{"edge": {"rel": "checked_out", "src": "run", "dst": {"source": {"system": "git", "key": "9f2c1e"}}}}
{"metric": {"entity": "run", "values": {"loss": 0.12}, "step": 1000, "observedAt": "2026-10-10T09:00:00Z"}}
```

## onyx research

Agents improve your code against your metrics: a base agent studies the repository, then a variational operator proposes hypotheses and workers test them, each in its own worktree, by running experiments on your project's endpoints (a benchmark, a simulator, a robot). Every hypothesis and experiment is a job in your org's queue, and every result and insight is in the knowledge graph, for anyone in the org to read and question.

You need: `onyx login`, a logged-in [Claude Code](https://claude.com/claude-code) (`claude`), git, and an `onyx/research.json` in the repository:

```json
{
  "name": "solver speed",
  "goal": "Make solver.py as fast as possible while staying valid on every instance.",
  "remote": "git@github.com:you/project.git",
  "editable": ["solver.py"],
  "evaluate": "python onyx/endpoints/bench.py --samples 8",
  "metrics": [{ "key": "speedup", "better": "higher" }],
  "endpoints": [
    {
      "type": "bench",
      "label": "the benchmark, 100 instances",
      "guide": "onyx/endpoints/bench.md",
      "driver": "python onyx/endpoints/bench.py"
    }
  ],
  "workers": 2,
  "minutes": 30
}
```

An endpoint's `type` is a unit type from your org's pack (a subtype of `research_endpoint`); its driver runs in a checkout of the experiment's commit and prints a last line `METRICS {json}`. `models`, `experimentsPerTask`, `baseBranch`, `capacity` and `timeoutS` have defaults.

```bash
onyx research setup onyx/research.json          # the base agent studies the repository
onyx research run onyx/research.json            # propose, test and learn until the minutes are up
onyx research steer onyx/research.json "try vectorising the inner loop"
onyx research greedy onyx/research.json         # a one-agent baseline to compare a run with
onyx research help                              # these, and the commands agents use in a run
```

A run trades your sign-in for a key of its own, so its jobs are taken only by its own runner. Its state is kept in `.onyx-research/` in the repository (add it to `.gitignore`), so a run that stops picks up where it was. `fixtures/algotune` in this repo is a project ready to run.

## The SDK

```ts
import { OnyxClient } from "@onyx-robotics/agent/sdk"

const onyx = new OnyxClient({ baseUrl: "https://app.onyxresearch.ai", token: process.env.ONYX_TOKEN! })
const run = onyx.newId()
await onyx.ingest({
  items: [{ id: run, type: "experiment", name: "fit arm model", status: "running" }],
  edges: [{ rel: "tested", src: run, dst: { source: { system: "plm", key: "arm-2" } } }],
})
```

Every write carries an Idempotency-Key its retries reuse (network errors, 429 and 5xx, retryable conflicts), so the server applies it once. `stream()` sends records in order, in chunks, as `onyx ingest` does. The SDK runs in Bun and in Node 22 or later.

## The skill

`skills/onyx/SKILL.md` teaches a coding agent to sign in, read the graph before it writes, log its work and start `onyx research`. For Claude Code, copy it into your skills:

```bash
mkdir -p ~/.claude/skills && cp -r "$(npm root -g)/@onyx-robotics/agent/skills/onyx" ~/.claude/skills/
```

(or into a project's `.claude/skills/`).

## Develop

```bash
bun install
bun run lint && bun run typecheck && bun run test
bun run build        # dist/: the JavaScript for Node
bun run compile      # dist/onyx-<platform>-<arch>: a binary for this machine (-- --all for every one)
bun run onyx -- help # the CLI from source
```

`src/generated/contracts` is the API's contracts, copied from Onyx's server code: don't edit it. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes get in.

## License

Apache-2.0 (see [LICENSE](LICENSE)).
