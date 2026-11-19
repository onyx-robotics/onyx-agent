---
"@onyx-robotics/agent": patch
---

Codex agents of a research run can read the code and send experiments. An agent that may read files may read them with its shell, as Codex does (`cat`, `sed -n`, `rg`, `find` and the like; nothing that writes or runs a program) and look at images, and is told so. A worker runs outside Codex's sandbox, which kept its worktree's git metadata read only so `onyx research experiment` couldn't commit; its gate holds it to its rules instead, as before, and now also keeps its edits where it works and in the directories it's given, as Claude Code's are.
