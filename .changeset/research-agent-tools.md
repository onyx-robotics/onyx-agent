---
"@onyx-robotics/agent": minor
---

Research agents can only do their own job. The base agent and the var-op read and run nothing but their own commands. A worker edits code, and its shell runs only the quick evaluation, `onyx research` and read-only git, so every computation is an experiment on an endpoint. The var-op's cost stays flat over a run: it isn't woken while idle, workers' notes are batched, and its session starts afresh every 20 wakes (`onyx research run` hands it the board). A run's experiments are held to twice its endpoints' capacity, runs sharing an endpoint get a fair share of it, and a site's metrics are read once they're recorded.
