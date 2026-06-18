---
name: onyx
description: Coordinate the Onyx parallel research workflow. Use when asked to start, set up, approve, monitor, stop, finish, or resume Onyx research; optimize a metric with a team of agents; or run /onyx anything.
---

# Onyx Parallel Research

You are the main-thread Onyx orchestrator. The user talks to you. You run the
Setup phase, get human approval, then create an async research session with
deliberate lane plans through the `onyx` CLI.

Do not behave like a lane worker in the main thread unless the user explicitly
asks for a manual single-agent loop. The lane workers receive generated prompts
from `onyx research start`; they own their own research loops, measurement,
logging, summaries, and knowledge updates inside their lane worktrees.

## Orchestrator Responsibilities

1. Infer or ask for the missing research spec:
   - goal
   - primary metric name, unit, and direction
   - time or iteration budget
   - number of agents
   - repo/project path and files in scope
   - hard constraints
   - environment resources, reset requirements, and tool/API needs
2. Build the canonical setup contract at `<projectPath>/onyx/contract.json`,
   then stamp its hash:

   ```bash
   onyx contract hash --write
   ```

3. Start or select the campaign:

   ```bash
   onyx campaign setup --name <slug> --description <goal>
   ```

   Add `--project-path <path>` for monorepos.

4. Build the generated narrative setup artifact `<projectPath>/onyx/onyx.md`.
5. Commit the setup artifacts.
6. Run a baseline:

   ```bash
   onyx setup baseline --campaign <slug>
   ```

7. Present the setup and baseline to the human for approval. Include the goal,
   metric, contract hash, commands, resources, constraints, protected paths,
   lane plan themes, and baseline result.
8. After approval:

   ```bash
   onyx setup approve --campaign <slug> --baseline-experiment <id>
   onyx research start --campaign <slug> --agents <n> --lane-plans <plans.json> --max-minutes <minutes>
   ```

   The command returns a session id and one `onyx worker run --session ...`
   command per lane. Launch workers locally or on other machines. Use
   `--agent claude` on `onyx worker run` for Claude lane workers, or
   `--worker-command "<cmd>"` for a custom worker harness.

9. Monitor with `onyx research status`, `onyx listen`, and the web campaign
   page. If the user interrupts, run `onyx research stop`.
10. Finish with:

```bash
onyx research finish --campaign <slug>
```

This reconciles, writes summaries, and creates local extraction branches
such as `onyx/<campaign>/best`.

## Setup Artifacts

The orchestrator creates and owns the setup surface:

- `onyx/contract.json`: canonical structured setup contract, including goal,
  metric, project path, editable scope, protected paths, commands, resources,
  constraints, risk model, measurement policy, stop policy, and contract hash.
- `onyx/onyx.md`: generated narrative view of the contract and research context.
- `onyx/tools/*`: helper scripts for reset, observation, data collection, or
  hardware/simulator control.
- `onyx/eval.sh`: measurable evaluation entry point.
- `onyx/checks.sh`: optional hard correctness or safety checks.

During Research, lane workers must not edit `onyx/contract.json`,
`onyx/onyx.md`, `onyx/eval.sh`, `onyx/checks.sh`, or `onyx/tools/*`. If the
setup is wrong, stop and create a new setup version rather than silently
changing the measurement contract. `tool-api.json` may exist for legacy
workflows, but it is not canonical.

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
- onyx/contract.json
- onyx/eval.sh
- onyx/checks.sh
- onyx/tools/\*

## Constraints

<Hard safety, quality, dependency, runtime, or hardware rules.>

## Environment And Reset

<How tools reset the environment, acquire resources, and keep measurements comparable.>

## What Has Been Tried

<Strategic themes only. Full experiment history lives in `onyx exp list`.>
```

## Setup Contract

`onyx/contract.json` declares commands and shared resources. Keep it simple and
repo-local. Write it first with no `contractHash` or with a placeholder, then
run `onyx contract hash --write`.

```json
{
  "schemaVersion": 1,
  "goal": "Improve the target metric without changing the evaluation contract.",
  "metric": {
    "name": "score",
    "unit": null,
    "direction": "maximize"
  },
  "projectPath": "",
  "editableScope": ["src"],
  "protectedPaths": [
    "onyx/contract.json",
    "onyx/onyx.md",
    "onyx/eval.sh",
    "onyx/checks.sh",
    "onyx/tools"
  ],
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
  "constraints": [],
  "riskModel": {
    "risks": [],
    "antiGamingChecks": []
  },
  "measurement": {
    "metricLine": "METRIC",
    "trials": 1,
    "aggregation": "single",
    "notes": null
  },
  "stopPolicy": {
    "maxIterations": null,
    "maxMinutes": null,
    "patience": null
  },
  "contractHash": "sha256:<filled-by-onyx-contract-hash>"
}
```

Use `onyx tools run <name>` to smoke-test any command. `onyx exp run` uses the
contract automatically: acquire resources, reset, evaluate, check, release.

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
- read `ONYX_BRIEF_FILE`, `ONYX_SESSION_STATE_FILE`, `ONYX_CONTRACT_FILE`, and
  `ONYX_CONTRACT_HASH`;
- make one committed experiment attempt at a time;
- run `onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --base <pre-edit-sha>`;
- record every attempt with `onyx exp log --agent-notes ...`;
- publish shared learning with `onyx knowledge add` and update lane summaries
  with `onyx summary upsert` when they learn something useful;
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
