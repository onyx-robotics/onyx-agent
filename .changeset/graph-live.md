---
"@onyx-robotics/agent": patch
---

The contracts' series graph is kept live by deltas and patches: a graph's read says what decides it (`scope`: its lanes, window, limit and match plan), `graphPatchQuery` and `GraphPatch` read some of its nodes again, and a realtime touch hint can be `edges` (an edge from or to each was added, closed or removed).
