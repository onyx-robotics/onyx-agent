---
name: onyx
description: Coordinate the Onyx parallel research workflow. Use when asked to start, set up, approve, monitor, stop, finish, or resume Onyx research; optimize a metric with a team of agents; or run /onyx anything.
---

# Onyx Parallel Research

You are the main-thread Onyx controller. The user talks to you. You run the
Setup phase, get human approval, then launch and supervise autonomous lane
workers through the `onyx` CLI.

Do not behave like a lane worker in the main thread unless the user explicitly
asks for a manual single-agent loop. The lane workers receive generated prompts
from `onyx research start`; they own their own research loops inside lane
worktrees.

## Controller Responsibilities

1. Infer or ask for the missing research spec:
   - goal
   - primary metric name, unit, and direction
   - time or iteration budget
   - number of agents
   - repo/project path and files in scope
   - hard constraints
   - environment resources, reset requirements, and tool/API needs
2. Start or select the campaign:

   ```bash
   onyx campaign setup --name <slug> --metric <metric> --unit <unit> --direction <maximize|minimize> --description <goal>
   ```

   Add `--project-path <path>` for monorepos.
3. Build the Setup phase artifacts under `<projectPath>/onyx/`.
4. Commit the setup artifacts.
5. Run a baseline:

   ```bash
   onyx setup baseline --campaign <slug>
   ```

6. Present the setup and baseline to the human for approval. Include the goal,
   metric, constraints, reset/tool API, protected paths, and baseline result.
7. After approval:

   ```bash
   onyx setup approve --campaign <slug> --baseline-experiment <id>
   onyx research start --campaign <slug> --agents <n> --agent codex --max-minutes <minutes>
   ```

   Use `--agent claude` for Claude lane workers, or `--worker-command "<cmd>"`
   for a custom worker harness.
8. Monitor with `onyx research status`, `onyx listen`, and the web campaign
   page. If the user interrupts, run `onyx research stop`.
9. Finish with:

   ```bash
   onyx research finish --campaign <slug>
   ```

   This reconciles, writes summaries, and creates local extraction branches
   such as `onyx/<campaign>/best`.

## Setup Artifacts

The controller creates and owns the setup surface:

- `onyx/onyx.md`: durable campaign spec and research context.
- `onyx/tool-api.json`: structured tool/resource manifest.
- `onyx/tools/*`: helper scripts for reset, observation, data collection, or
  hardware/simulator control.
- `onyx/eval.sh`: measurable evaluation entry point.
- `onyx/checks.sh`: optional hard correctness or safety checks.

During Research, lane workers must not edit `onyx/onyx.md`, `onyx/eval.sh`,
`onyx/checks.sh`, `onyx/tool-api.json`, or `onyx/tools/*`. If the setup is
wrong, stop and create a new setup version rather than silently changing the
measurement contract.

## `onyx.md`

Write this as a compact but complete handoff for fresh agents:

```markdown
# Onyx Research: <goal>

## Objective
<What we are optimizing and why.>

## Metric
- Primary: <name>, <unit>, <maximize|minimize>
- Baseline: <value and commit after setup baseline>

## Files In Scope
- <path>: <why it matters>

## Protected Setup
- onyx/onyx.md
- onyx/eval.sh
- onyx/checks.sh
- onyx/tool-api.json
- onyx/tools/*

## Constraints
<Hard safety, quality, dependency, runtime, or hardware rules.>

## Environment And Reset
<How tools reset the environment, acquire resources, and keep measurements comparable.>

## What Has Been Tried
<Strategic themes only. Full experiment history lives in `onyx exp list`.>
```

## Tool API

`onyx/tool-api.json` declares commands and shared resources. Keep it simple and
repo-local.

```json
{
  "schemaVersion": 1,
  "resources": {
    "simulator": {
      "slots": 1,
      "description": "Exclusive simulator process"
    }
  },
  "commands": {
    "reset": {
      "command": "bash onyx/tools/reset.sh",
      "timeoutSeconds": 60,
      "resources": ["simulator"]
    },
    "evaluate": {
      "command": "bash onyx/eval.sh",
      "timeoutSeconds": 600,
      "resources": ["simulator"]
    },
    "check": {
      "command": "bash onyx/checks.sh",
      "timeoutSeconds": 300
    }
  },
  "protectedPaths": [
    "onyx/onyx.md",
    "onyx/eval.sh",
    "onyx/checks.sh",
    "onyx/tool-api.json",
    "onyx/tools"
  ]
}
```

Use `onyx tools run <name>` to smoke-test any command. `onyx exp run` uses the
manifest automatically: acquire resources, reset, evaluate, check, release.
Without a manifest it falls back to `onyx/eval.sh` and optional
`onyx/checks.sh`.

`eval.sh` must print the primary metric as:

```text
METRIC <name>=<number>
```

For noisy metrics, run multiple trials and report a robust statistic plus
secondary diagnostics.

## Lane Worker Contract

`onyx research start` generates lane-worker prompts. Lane workers:

- do not ask the user questions;
- do not launch other agents;
- do not edit protected setup paths;
- poll `onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n>`;
- read `ONYX_BRIEF_FILE`, `ONYX_SESSION_STATE_FILE`, and
  `ONYX_TOOL_API_FILE`;
- make one committed experiment attempt at a time;
- run `onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --base <pre-edit-sha>`;
- record every attempt with `onyx exp log --agent-notes ...`;
- update lane summaries with `onyx summary upsert` when they learn something
  useful;
- sync/push periodically and leave the worktree clean on stop.

## Interrupts And Finish

If the user asks to stop:

```bash
onyx research stop --session <id> --reason "<reason>"
```

Workers should finish the current measured attempt, log it, sync, summarize,
and exit. Then finalize:

```bash
onyx research finish --campaign <slug>
```

Report the best branch, lane branches, baseline, best metric, and open research
ideas back to the user.
