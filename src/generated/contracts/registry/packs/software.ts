// Generated from packages/core/src/registry/packs/software.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
export default `
key: software
version: 1
label: Software & ML
description: Repositories, commits, training and evaluation runs.
requires: [core]

types:
  - key: repository
    kind: asset
    label: Repository
    description: A source code repository.
  - key: commit
    kind: artifact
    label: Commit
    description: An immutable code revision (materialised when a run references it).
    properties: [git_sha]
    comparison: subject
  - key: training_run
    kind: activity
    parent: experiment
    label: Training run
    properties: [learning_rate, batch_size]
  - key: benchmark_run
    kind: activity
    parent: evaluation
    label: Benchmark run
  - key: model_checkpoint
    kind: artifact
    label: Model checkpoint
    comparison: subject

relations:
  - key: in_repo
    label: in repository
    inverse: contains
    src_kinds: [artifact]
    dst_kinds: [asset]
    description: A commit belongs to a repository.
  - key: checked_out
    label: checked out
    inverse: checked out by
    parent: used
    src_kinds: [activity]
    dst_kinds: [artifact]
    lineage: true
    description: The code revision an activity ran.

properties:
  - key: git_sha
    label: Git SHA
    type: text
  - key: learning_rate
    label: Learning rate
    type: number
    metric: true
    input: true
  - key: batch_size
    label: Batch size
    type: integer
    metric: true
    input: true
  - key: val_loss
    label: Validation loss
    type: number
    metric: true
    better: lower
  - key: accuracy
    label: Accuracy
    type: number
    metric: true
    better: higher
  - key: throughput
    label: Throughput
    type: number
    unit: items/s
    metric: true
    better: higher

dims:
  - key: repository
    label: Repository
    paths: [[checked_out, in_repo], [in_repo], [generated_by, checked_out, in_repo]]
`
