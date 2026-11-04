// Generated from packages/core/src/registry/packs/bio.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
export default `
key: bio
version: 1
label: Life sciences
description: Samples and aliquots, storage locations, assays and protocols.
requires: [core]

types:
  - key: sample
    kind: asset
    label: Sample
    properties: [organism]
  - key: aliquot
    kind: asset
    parent: sample
    label: Aliquot
    description: A portion of a sample (linked with derived_from).
  - key: storage_location
    kind: asset
    label: Storage location
    description: A freezer, rack, box or plate position. Locations nest (located_in).
  - key: assay_run
    kind: activity
    parent: experiment
    label: Assay run
    properties: [concentration_um]
  - key: protocol
    kind: artifact
    label: Protocol
    description: A written lab protocol.

relations:
  - key: located_in
    label: located in
    inverse: holds
    src_kinds: [asset]
    dst_kinds: [asset]
    hierarchy: true
    temporal: true
    description: Where a sample or container is stored.
  - key: assayed
    label: assayed
    inverse: assayed by
    parent: used
    src_kinds: [activity]
    dst_kinds: [asset]
    lineage: true
    description: The sample an assay measured.
  - key: follows_protocol
    label: follows protocol
    inverse: followed by
    parent: used
    src_kinds: [activity]
    dst_kinds: [artifact]
    lineage: true

properties:
  - key: organism
    label: Organism
    type: enum
    values: [human, mouse, rat, yeast, e_coli, other]
  - key: concentration_um
    label: Concentration
    type: number
    unit: µM
    metric: true
    input: true
  - key: assay_signal
    label: Assay signal
    type: number
    metric: true
    better: higher
  - key: viability_pct
    label: Viability
    type: number
    unit: "%"
    metric: true
    better: higher

dims:
  - key: sample
    label: Sample
    paths: [[assayed], [generated_by, assayed]]
  - key: storage
    label: Storage location
    rollup: located_in
    paths: [[assayed, located_in], [located_in]]
  - key: organism
    label: Organism
    property: organism
`
