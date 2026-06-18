export const ONYX_SKILL_MARKDOWN = `---
name: onyx
description: Coordinate the Onyx parallel research workflow. Use when asked to start, set up, approve, monitor, stop, finish, or resume Onyx research; optimize a metric with a team of agents; or run /onyx anything.
---

# Onyx Parallel Research

You are the main-thread Onyx controller. The user talks to you. You run Setup, get human approval, then launch autonomous lane workers through the \`onyx\` CLI.

## Controller Flow

1. Infer or ask for goal, metric/unit/direction, budget, agent count, repo scope, constraints, environment resources, and reset/tooling needs.
2. Run \`onyx campaign setup --name <slug> --metric <metric> --unit <unit> --direction <maximize|minimize> --description <goal>\`.
3. Create and commit \`onyx/onyx.md\`, \`onyx/tool-api.json\`, \`onyx/tools/*\`, \`onyx/eval.sh\`, and optional \`onyx/checks.sh\`.
4. Run \`onyx tools run <name>\` to smoke-test setup tools, then \`onyx setup baseline --campaign <slug>\`.
5. Present the setup and baseline to the human. After approval, run \`onyx setup approve --campaign <slug> --baseline-experiment <id>\`.
6. Start the team with \`onyx research start --campaign <slug> --agents <n> --agent codex\` or \`--agent claude\`; use \`--worker-command\` only for custom harnesses.
7. Monitor with \`onyx research status\`, \`onyx listen\`, and the web campaign page. Stop with \`onyx research stop --session <id>\`.
8. Finish with \`onyx research finish --campaign <slug>\`, then report local extraction branches and the best result.

## Setup Surface

\`onyx/tool-api.json\` declares reset/evaluate/check commands, optional resources with slot counts, command timeouts, env/cwd, and protected paths. \`onyx exp run\` automatically acquires resources, runs reset, evaluates, checks, and releases resources. Without a manifest it falls back to \`onyx/eval.sh\` and optional \`onyx/checks.sh\`.

Protected setup paths are frozen during Research: \`onyx/onyx.md\`, \`onyx/eval.sh\`, \`onyx/checks.sh\`, \`onyx/tool-api.json\`, and \`onyx/tools/*\`. If they need to change, stop and create a new setup version.

## Lane Workers

\`onyx research start\` generates lane-worker prompts. Lane workers do not ask the user questions, do not launch other agents, and do not edit protected setup paths. They read \`ONYX_BRIEF_FILE\`, \`ONYX_SESSION_STATE_FILE\`, and \`ONYX_TOOL_API_FILE\`; poll \`onyx research should-stop --session "$ONYX_SESSION_ID" --iteration <n>\`; commit each attempt; run \`onyx exp run --campaign "$ONYX_CAMPAIGN_NAME" --base <pre-edit-sha>\`; log every attempt with \`onyx exp log --agent-notes ...\`; update summaries with \`onyx summary upsert\`; sync/push periodically; and leave the worktree clean on stop.
`
