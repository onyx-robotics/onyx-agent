# Getting started with Onyx research

This guide takes you from installing `onyx` to a research run: agents that improve your code against your metrics, test their ideas as experiments on your endpoints, and record what they learn in your org's knowledge graph.

You can let Claude Code do most of it. Steps 1 and 2 are yours; after that, ask Claude "set up an Onyx research run for this repository" and it follows the same steps with you, using the skill from step 2. This guide is what it does, so you can check its work or do it by hand.

## What you need

- **Linux or macOS.** On Windows, use WSL: the agents run as Unix processes.
- **git**, and **[Bun](https://bun.sh)** 1.3.14 or later if you install with npm (the installer's binary needs neither Bun nor Node).
- **[Claude Code](https://claude.com/claude-code)**, signed in (`claude` works in your terminal). A run's agents are Claude Code sessions on your account, so a run spends your Claude usage.
- **An account in an Onyx org**, and someone with the org's **admin** role for two things: loading your project's vocabulary (step 4) and approving a site (step 9). That may be you.
- **A git repository** with the code to improve, and a remote you can push to. Workers push their branches there.

## 1. Install and sign in

```bash
curl -fsSL https://onyxresearch.ai/install.sh | bash
onyx login                             # approve this machine in your browser, pick the org
onyx whoami                            # who you act as, in which org
```

The installer puts `onyx` in `~/.local/bin` (it prints the line to add if that isn't on your `PATH`) and the skills for Claude Code in `~/.claude/skills` (step 2). Or install the package with npm, which needs Bun, and copy the skills yourself in step 2:

```bash
npm install -g @onyx-robotics/agent    # or: bun add -g @onyx-robotics/agent
```

## 2. Give Claude the skills

The package has two skills for Claude Code: `onyx` (read and log in the graph, start and steer runs) and `onyx-research-setup` (set a repository up for a run, with you). The installer has already put them in `~/.claude/skills`. If you installed with npm, copy them there:

```bash
mkdir -p ~/.claude/skills
cp -r "$(npm root -g)/@onyx-robotics/agent/skills/"* ~/.claude/skills/
```

From here, in your repository: run `/onyx` in Claude Code, or ask Claude to set up an Onyx research run. The rest of this guide is the same steps by hand.

## 3. Decide what to improve, and how it's measured

Write these down before anything else; every later file comes from them.

- **The goal**, in a few sentences an agent can act on: what to make better, what must stay true (correctness, safety limits), and anything an agent wouldn't know (where the hardware is, what's been tried).
- **The metrics**, each with a direction: `speedup` higher, `error_mm` lower. Name them `<pack>.<name>` (step 4), for example `solver.speedup`.
- **What agents may edit**: the files that hold the method (`solver.py`, `calibrate.py`). Everything else is read only to them, the measurement included.
- **The quick evaluation**: a command that checks a change is ready to send, in well under a minute (a few samples, a compile, a unit test). It isn't the experiment.
- **Where experiments run**: an **endpoint**, a kind of machine that runs one experiment and reports its metrics. A benchmark on your own machine is the simplest (steps 5 to 8). A robot, a GPU box or a lab bench is a **site** (step 9).

## 4. Add your project's vocabulary to the org

Every endpoint type and every metric must exist in the org's registry before a run can use it: a job for an unknown type never starts, and a result with an unknown metric is refused. You declare them in a small **pack**, `onyx/pack.yaml`:

```yaml
key: solver # your pack's namespace: everything in it is solver.<name>
version: 1
label: Solver
description: How fast the solver is, and the bench that times it.
requires: [research]

types:
  - key: solver.bench
    kind: asset
    parent: research_endpoint
    label: Solver bench
    description: Times solver.py on 100 instances against the reference.

properties:
  - { key: solver.speedup, label: Speedup, type: number, metric: true, better: higher }
  - { key: solver.valid_fraction, label: Valid fraction, type: number, metric: true, better: higher }
```

An admin loads it (with the built-in `research` pack, if the org doesn't have it yet):

```bash
onyx registry check onyx/pack.yaml               # offline: its format and namespace
onyx registry plan research onyx/pack.yaml       # what loading it would change
onyx login --admin && onyx registry apply research onyx/pack.yaml
```

Loading a pack again with more in it adds what's new; nothing is deleted.

## 5. Write the endpoint's driver and guide

For an endpoint on your own machine, the run runs the driver itself, in a checkout of each experiment's commit:

- **The driver** (`onyx/endpoints/bench.py`): runs the experiment, prints its log, and ends with one line `METRICS {json}` whose keys are your metrics. Exit 0 if it ran; another exit, or no `METRICS` line, is a failure, with the end of its output as the reason. If a worker names a packet (`--packet <path>`), its path is appended to the command.

  ```python
  print("METRICS " + json.dumps({"solver.speedup": 3.2, "solver.valid_fraction": 1.0}))
  ```

- **The guide** (`onyx/endpoints/bench.md`): what workers need to use it well, in a few lines: what a packet is (usually the commit itself), what it measures and how, what's in its log, how long it takes, and its rules.

Run the driver once yourself from the repository's root, and check its last line.

## 6. Write the run's config

`onyx/research.json`:

```json
{
  "name": "solver speed",
  "goal": "Make solver.py as fast as possible while staying valid on every instance.",
  "remote": "git@github.com:you/project.git",
  "baseBranch": "main",
  "editable": ["solver.py"],
  "evaluate": "python onyx/endpoints/bench.py --samples 8",
  "metrics": [
    { "key": "solver.speedup", "better": "higher" },
    { "key": "solver.valid_fraction", "better": "higher" }
  ],
  "endpoints": [
    {
      "type": "solver.bench",
      "label": "the bench: solver.py on 100 instances, timed against the reference",
      "guide": "onyx/endpoints/bench.md",
      "driver": "python onyx/endpoints/bench.py",
      "capacity": 1,
      "timeoutS": 900
    }
  ],
  "workers": 2,
  "minutes": 30
}
```

- `capacity` is how many experiments an endpoint runs at once; `timeoutS`, when one is given up on.
- `workers` is how many agents work at once, and `minutes` how long the run proposes new hypotheses. Each worker holds a slot only while it's thinking: one waiting on its experiment frees its slot for another.
- `models` (base, var-op, worker) and `experimentsPerTask` (a safety ceiling per hypothesis) have defaults.

Add `.onyx-research/` to `.gitignore` (the run's state lives there), then commit and push `baseBranch` to `remote`.

## 7. Set up

```bash
onyx research setup onyx/research.json
```

A base agent reads the code, runs the quick evaluation, reads the endpoint guides, and records the aspects of the system experiments will be about. Every other agent of the run starts from it, so read its summary: if it misunderstood the problem, fix the goal or the guide and set up again.

## 8. Run, watch and steer

```bash
onyx research run onyx/research.json                                # until minutes are up
onyx research steer onyx/research.json "try caching the factorisation"
```

- Start `run` in a terminal that stays open (tmux, or a background job): the machine must stay awake and online for the run.
- Watch it in Onyx: its hypotheses, experiments and insights are graph items and jobs like the rest of the org's work, under a campaign named after the run.
- `steer` leaves a note for the var-op, the agent that decides what's tried next; it reads it the next time it's woken.
- Ctrl+C stops the run. `onyx research run` on the same config carries it on, with the same deadline.
- Before a long run, work out the cost: each worker's turn is a Claude Code session, and a run's total is printed when it stops.

## 9. Endpoints on other machines: sites

When experiments need hardware (a robot, a rig, a GPU box), they run on a **site**: a machine with `onyx-site`, a service that takes jobs for its units off your org's queue and runs them with a driver. A run sends experiments to a site exactly as to its own endpoints.

**On the site's machine:**

1. Install `onyx-site`. It isn't published as a package yet: it's installed from the Onyx repository (`python/site-runner`, whose `SETUP.md` is the full guide). Ask your Onyx contact for access.
2. Write its site file. For an experiment that's a program in your repository, the shipped `local_program` driver runs it from the experiment's commit:

   ```toml
   [site]
   server = "https://app.onyxresearch.ai"

   [files]
   bind = "0.0.0.0:7443"
   public_url = "https://bench.example.com:7443"   # must be reachable from the machine the run is on

   [policy]
   unit_types = ["solver.bench"]
   max_deadline_s = 900

   [repos.solver]
   url = "git@github.com:you/project.git"          # the run's remote, exactly as research.json has it
   ssh_key = "keys/solver_ro"                       # a read-only deploy key

   [drivers.bench]
   ref = "onyx_site.drivers.local_program:LocalProgram"
   instances = [{ id = "bench-1" }]
   [drivers.bench.config]
   unit_type = "solver.bench"
   command = ["python3", "onyx/endpoints/bench.py"]

   [unit_types."solver.bench"]
   driver = "bench"
   fidelity = "sim"                                 # "hardware" for a physical rig
   ```

   The site fetches each experiment's commit itself, with a read-only deploy key of its own (`ssh_key`). Make one on the site's machine, add its `.pub` to your repository as a deploy key without write access (`gh repo deploy-key add keys/solver_ro.pub -R you/project`), and have the site's user trust GitHub's host key, since the site won't fetch from a host it doesn't know (`gh api meta -q '.ssh_keys[]' | sed 's/^/github.com /' >> ~/.ssh/known_hosts`). `SETUP.md`, "Giving the site read access to a repository", has the steps and a check.

   A program run this way reports its metrics in `$ONYX_OUT/metrics.json` (`{"solver.speedup": 3.2}`), not in a `METRICS` line, and everything it writes to `$ONYX_OUT` is kept: the run downloads those files for the worker that sent the experiment. The worker's packet path is in `$ONYX_PARAMS` (`params.json`, the job's props). Hardware that needs a long-lived connection gets a driver of its own (`DRIVERS.md`).

3. Enrol it: `onyx-site enrol`, and an admin approves the code it prints. Then `onyx-site run`, as a service (`SETUP.md`, step 7).

**In the run's config**, the endpoint names the site instead of a driver:

```json
{ "type": "solver.bench", "site": true, "label": "...", "guide": "onyx/endpoints/bench.md", "capacity": 1, "timeoutS": 900 }
```

Before a run, send one job by hand and check it comes back, files included:

```bash
echo '{"on": "solver.bench", "type": "experiment", "name": "round trip",
  "props": {"git": {"url": "git@github.com:you/project.git", "commit": "<sha on main>", "ref": "main"}}}' | onyx run -f - --wait
onyx jobs get <id>          # its outcome and metrics; GET /jobs/<id>/files lists its files
```

## When something's wrong

| What you see | Why, and what to do |
| --- | --- |
| `onyx` exits 4 | Not signed in, or not allowed: `onyx login` (admin commands need `onyx login --admin`) |
| An experiment never starts | No unit of its type is free: a site that's down, a unit held or quarantined (`onyx-site status`), or a type not in the registry (step 4) |
| An experiment ends `failed` / `refused` | The site's policy refused it: its unit type isn't in `[policy] unit_types`, or the run's remote isn't in `[repos]` |
| An experiment's results are refused | A metric it reported isn't in the registry: add it to the pack and load it again |
| The base agent fails at setup | `claude` isn't signed in, or the remote has no `baseBranch` |
| Workers sit waiting while endpoints are idle | More workers, or a CPU endpoint (`local_program` with a few slots) for processes that need no hardware, so workers send them as experiments instead of running them on their own machine |
| A run stopped (crash, laptop asleep) | Run `onyx research run` again on the same config: it holds the same jobs and carries them on |
