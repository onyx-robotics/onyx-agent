---
"@onyx-robotics/agent": minor
---

`onyx setup [--project]`: one command for a new machine. It checks git and Claude Code, signs you in if you aren't, and installs the package's skills for Claude Code in `~/.claude/skills` (or the project's `.claude/skills`). The skills are part of the program, so a standalone binary installs them too. Copying `skills/` by hand still works.
