---
"@onyx-robotics/agent": patch
---

A Codex worker of a research run is told it creates and edits files with apply_patch inside its working directory and the directories it's given, and to write its state for `onyx research finish` there. It was told only that anything that writes is refused, so a worker could give up on finishing.
