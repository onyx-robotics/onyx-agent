---
"@onyx-robotics/agent": minor
---

`onyx/research.json` names the coding agent a run's agents are sessions of (`agent`, `claude` by default), and `onyx research` checks that one before it starts. A role the config gives no model gets its CLI's choice for it, as before for Claude Code (`opus`, `sonnet`, `haiku`). A run set up with one agent refuses to carry on with another and says to run setup again.
