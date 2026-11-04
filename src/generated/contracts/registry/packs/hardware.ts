// Generated from packages/core/src/registry/packs/hardware.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
export default `
key: hardware
version: 1
label: Hardware & controls
description: Hardware systems as assemblies of subsystems and components, and the experiments run on them.
requires: [core]

types:
  - key: hardware_system
    kind: asset
    label: Hardware system
    description: A complete machine or rig (e.g. a robot, test stand).
    properties: [serial_number, location]
  - key: hardware_subsystem
    kind: asset
    label: Hardware subsystem
    description: A functional subsystem of a hardware system (an arm, a drivetrain).
  - key: hardware_component
    kind: asset
    label: Hardware component
    description: A physical component (motor, encoder, IMU). Components can be shared between subsystems.
    properties: [firmware_version, serial_number]
  - key: sysid_run
    kind: activity
    parent: experiment
    label: System identification run
    description: Estimates a model of a system's dynamics from input/output data.
    properties: [fidelity]
  - key: control_test
    kind: activity
    parent: experiment
    label: Controller test
    description: Runs a controller on a system (simulated, hardware-in-the-loop or real) and scores it.
    properties: [fidelity]
  - key: firmware_build
    kind: artifact
    label: Firmware build
    properties: [firmware_version]
    comparison: subject

relations:
  - key: tested
    label: tested
    inverse: tested in
    parent: used
    src_kinds: [activity]
    dst_kinds: [asset]
    lineage: true
    description: The hardware (system, subsystem or component) an activity exercised.

properties:
  - key: fidelity
    label: Fidelity
    type: enum
    values: [sim, hil, hardware]
    description: sim = simulation, hil = hardware-in-the-loop, hardware = on the real machine.
  - key: firmware_version
    label: Firmware version
    type: text
  - key: serial_number
    label: Serial number
    type: text
  - key: location
    label: Location
    type: text
  - key: tracking_rmse
    label: Tracking RMSE
    type: number
    unit: rad
    metric: true
    better: lower
  - key: integral_abs_error
    label: Integral absolute error
    type: number
    metric: true
    better: lower
  - key: control_effort
    label: Control effort
    type: number
    metric: true
    better: lower
  - key: fit_r2
    label: Model fit R²
    type: number
    metric: true
    better: higher
  - key: gain_kp
    label: Proportional gain
    type: number
    metric: true
    input: true
    description: A controller parameter (an input, not an outcome).

dims:
  - key: hardware
    label: Hardware
    rollup: part_of
    paths: [[tested], [generated_by, tested]]
    description: What hardware was exercised, rolled up through the assembly tree.
  - key: fidelity
    label: Fidelity
    property: fidelity
`
