---
"@onyx-robotics/agent": minor
---

A research run's agents can be Codex CLI sessions: `"agent": "codex"` in `onyx/research.json`, with Codex signed in. Workers are forks of the base agent's session, as with Claude Code, and each agent is held to the same rules: a PreToolUse hook (`onyx research gate`) lets a worker's shell run only `onyx research` and read-only git, the base agent and the var-op edit nothing, and a ghost has no shell. A turn where Codex ran something the gate didn't see fails rather than being trusted. Codex agents use your Codex's default model unless `models` says. `CODEX_API_KEY` (not `OPENAI_API_KEY`) counts as signing Codex in.
