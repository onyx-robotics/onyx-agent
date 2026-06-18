export const ONYX_SKILL_MARKDOWN = `---
name: onyx
description: Drive the Onyx auto research workflow end-to-end. Use when asked to set up, validate, start, resume, or continue Onyx auto research.
---

# Onyx Research

Use the Onyx CLI as the durable substrate for autonomous research. The workflow has two phases:

1. Setup: define the goal, metric, unit, direction, constraints, tools, reset notes, and tracked onyx/ context.
2. Research: run autonomous lane workers that each own a movable lane branch while every measured attempt is recorded as an immutable experiment ref.

## Setup

1. Gather the goal, eval command, metric name, unit, metric direction, files in scope, constraints, reset/reproducibility notes, human feedback, and stop condition.
2. Create or select the campaign with:

   onyx campaign setup --name <slug> --metric <name> --unit <unit> --direction <maximize|minimize> --description <goal>

3. Write onyx/onyx.md and onyx/eval.sh. Add onyx/checks.sh only when correctness backpressure is required. Commit these setup files.
4. Run:

   onyx setup validate

   This records the baseline experiment, validates the active setup, and makes the campaign ready for Research.

## Research

Start autonomous lane workers with:

  onyx research start --campaign <slug> --agents <n> --worker-command "<agent command>"

Each lane worker receives ONYX_SETUP_ID, ONYX_LANE_ID, ONYX_LANE_NAME, ONYX_LANE_BRANCH, ONYX_BRIEF_FILE, and ONYX_SESSION_STATE_FILE. Read the generated brief and session state, make one measured improvement attempt, and leave committed changes for the runner. The runner evaluates, logs locally, pushes/syncs in the background, and keeps lane summaries concise.

Manual experiment loops can still use onyx exp run, onyx exp log, onyx exp list, onyx push, onyx sync, and onyx sync --watch. Experiments must carry setup context, and research-session experiments must carry lane context.

## Git Rules

Every measured attempt gets an immutable result ref at refs/onyx/experiments/<campaignId>/<runRef>. Lane branches under refs/heads/onyx/<campaign>/lanes/* are movable working surfaces. Do not rewrite reported experiment history; restore earlier file contents through a new forward commit when needed.
`
