import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const source = join(root, "prompts", "worker-agent-prompt.md")
const target = join(root, "src", "lib", "worker-prompt-content.ts")
const markdown = await readFile(source, "utf8")

await writeFile(
  target,
  [
    "// Generated from packages/agent/prompts/worker-agent-prompt.md.",
    "// Run `bun run generate:worker-prompt-content` from packages/agent after editing the prompt.",
    `export const HYPOTHESIS_WORKER_PROMPT_MARKDOWN = ${JSON.stringify(markdown)}\n`,
  ].join("\n"),
  "utf8"
)
