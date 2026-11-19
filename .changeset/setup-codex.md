---
"@onyx-robotics/agent": minor
---

`onyx setup` checks Claude Code and Codex CLI, and is ready when one of them is, and installs the skills where each one it finds reads them: `~/.claude/skills`, and `~/.codex/skills` (or `$CODEX_HOME/skills`); with `--project`, the folder's `.claude/skills` and `.agents/skills`. Its JSON output's `skills` gains `dirs`, every folder it wrote (`dir` is the first). The docs and the skills say a run's agents are Claude Code or Codex CLI sessions, whichever the config's `agent` names.
