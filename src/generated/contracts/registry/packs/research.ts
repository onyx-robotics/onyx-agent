// Generated from packages/core/src/registry/packs/research.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
// The research pack: autoresearch on a codebase (docs/knowledge-graph.md). Hypotheses, experiments,
// insights (notes) and aspects (topics) are core's; this adds what the agents need around them.
export default `
key: research
version: 1
label: Research
description: Autoresearch - tracks, worker tasks, agents' state and how insights relate.
requires: [core, software]

types:
  - key: track
    kind: concept
    label: Track
    description: A line of inquiry in a research run. Hypotheses belong to tracks; the variational operator weighs them (weight) and opens, pauses and closes them.
    statuses:
      exploring: running
      exploiting: running
      paused: blocked
      closed: succeeded
    properties: [weight, notes]
  - key: worker_task
    kind: activity
    parent: job
    label: Worker task
    description: A worker's work on one hypothesis, as a job on an agent_worker unit. It tests the hypothesis and is performed by the worker.
    properties: [base_commit, branch]
  - key: agent_worker
    kind: asset
    parent: environment
    label: Agent worker slot
    description: A slot on a user's machine where one worker agent runs at a time.
  - key: research_endpoint
    kind: asset
    parent: environment
    label: Research endpoint
    description: Where experiments run (a simulator, a GPU, a robot, a set of checks). A project's endpoints are subtypes of it.
  - key: agent_state
    kind: artifact
    label: Agent state
    description: What an agent knew when it stopped - its distilled state, from which it can be cloned and asked about its work (its ghost).
    properties: [state_text, model]
  # core's, with what research records on them
  - key: ai_agent
    kind: agent
    label: AI agent
    properties: [agent_role, model]
  - key: experiment
    kind: activity
    label: Experiment
    properties: [git_sha, branch, base_commit]

relations:
  - key: in_track
    label: in track
    inverse: has
    src_kinds: [concept]
    dst_kinds: [concept]
    description: A hypothesis belongs to a track.
  - key: reworks
    label: reworks
    inverse: reworked by
    src_kinds: [concept]
    dst_kinds: [concept]
    lineage: true
    description: A hypothesis that is a variation of an earlier one.
  - key: informed_by
    label: informed by
    inverse: informed
    parent: influenced_by
    lineage: true
    description: Work (a hypothesis, an experiment, an insight) that cites an insight it was built on.
  - key: supports
    label: supports
    inverse: supported by
    src_kinds: [artifact]
    dst_kinds: [artifact]
    description: An insight that agrees with another, with independent evidence.
  - key: contradicts
    label: contradicts
    inverse: contradicted by
    src_kinds: [artifact]
    dst_kinds: [artifact]
    description: An insight whose evidence disagrees with another's.
  - key: refines
    label: refines
    inverse: refined by
    src_kinds: [artifact]
    dst_kinds: [artifact]
    description: An insight that narrows or qualifies another (when it holds, by how much).
  - key: supersedes
    label: supersedes
    inverse: superseded by
    src_kinds: [artifact]
    dst_kinds: [artifact]
    description: An insight that replaces another, which is no longer to be relied on.
  - key: state_of
    label: state of
    inverse: has state
    src_kinds: [artifact]
    dst_kinds: [agent]
    description: An agent's saved state.

properties:
  - key: weight
    label: Weight
    type: number
    description: A track's share of the worker slots, relative to the other tracks.
  - key: base_commit
    label: Base commit
    type: text
    description: The commit a hypothesis or experiment branches from.
  - key: branch
    label: Branch
    type: text
  - key: agent_role
    label: Agent role
    type: enum
    values: [orchestrator, base, var_op, worker]
  - key: state_text
    label: State
    type: text
  - key: model
    label: Model
    type: text

dims:
  - key: track
    label: Track
    paths: [[in_track], [tests, in_track], [generated_by, tests, in_track]]
  - key: agent_role
    label: Agent role
    property: agent_role
`
