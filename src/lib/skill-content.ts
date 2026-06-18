export const ONYX_SKILL_MARKDOWN = `---
name: onyx
description: Coordinate the Onyx parallel research workflow. Use when asked to start, set up, approve, monitor, stop, finish, or resume Onyx research; optimize a metric with a team of agents; or run /onyx anything.
---

# Onyx Parallel Research

You are the main-thread Onyx orchestrator. The user talks to you. You run Setup, get human approval, then create an async research session with deliberate lane plans through the \`onyx\` CLI.

## Orchestrator Flow

1. Infer or ask for goal, metric/unit/direction, budget, agent count, repo scope, constraints, environment resources, and reset/tooling needs.
2. Create \`onyx/contract.json\` as the canonical setup contract, then run \`onyx contract hash --write\`.
3. Run \`onyx campaign setup --name <slug> --description <goal>\`.
4. Create and commit generated \`onyx/onyx.md\`, \`onyx/tools/*\`, \`onyx/eval.sh\`, and optional \`onyx/checks.sh\`.
5. Run \`onyx tools run <name>\` to smoke-test setup commands, then \`onyx setup baseline --campaign <slug>\`.
6. Present the setup contract, lane plan themes, and baseline to the human. After approval, run \`onyx setup approve --campaign <slug> --baseline-experiment <id>\`.
7. Start the session with \`onyx research start --campaign <slug> --agents <n> --lane-plans <plans.json>\`. Launch workers with the printed \`onyx worker run --session ... --lane ...\` commands, using \`--agent claude\` or \`--worker-command\` when appropriate.
8. Monitor with \`onyx research status\`, \`onyx listen\`, and the web campaign page. Stop with \`onyx research stop --session <id>\`.
9. Finish with \`onyx research finish --campaign <slug>\`, then report local extraction branches and the best result.

## Setup Surface

\`onyx/contract.json\` declares goal, metric, project path, editable scope, protected paths, reset/evaluate/check commands, resources, constraints, risk model, measurement policy, stop policy, and \`contractHash\`. \`onyx exp run\` automatically acquires resources, runs reset, evaluates, checks, releases resources, and logs the contract hash/compliance state.

Protected setup paths are frozen during Research: \`onyx/contract.json\`, \`onyx/onyx.md\`, \`onyx/eval.sh\`, \`onyx/checks.sh\`, and \`onyx/tools/*\`. If they need to change, stop and create a new setup version. \`tool-api.json\` is legacy/non-canonical.

## Lane Workers

\`onyx research start\` creates the session and lane plans, then prints worker launch commands. Lane workers do not ask the user questions, do not launch other agents, and do not edit protected setup paths. They read \`ONYX_BRIEF_FILE\`, \`ONYX_SESSION_STATE_FILE\`, \`ONYX_CONTRACT_FILE\`, and \`ONYX_CONTRACT_HASH\`; poll \`onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n>\`; commit each attempt; run \`onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --base <pre-edit-sha>\`; log every attempt with \`onyx exp log --agent-notes ...\`; publish learnings with \`onyx knowledge add\`; update summaries with \`onyx summary upsert\`; sync/push periodically; and leave the worktree clean on stop.
`
