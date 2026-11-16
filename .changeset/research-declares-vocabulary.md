---
"@onyx-robotics/agent": minor
---

`onyx research` adds the endpoint types and metrics named in `research.json` to your org's registry when a run is set up or started, so there's no `onyx/pack.yaml` to write or ask an admin to load. Metrics take an optional `label` and `unit`; `onyx research vocabulary <config>` adds them without starting anything; the SDK has `extendRegistry`.
