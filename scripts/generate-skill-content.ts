import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const source = join(root, "skills", "onyx", "SKILL.md")
const target = join(root, "src", "lib", "skill-content.ts")
const markdown = await readFile(source, "utf8")

await writeFile(
  target,
  [
    "// Generated from packages/agent/skills/onyx/SKILL.md.",
    "// Run `bun run generate:skill-content` from packages/agent after editing the skill.",
    `export const ONYX_SKILL_MARKDOWN = ${JSON.stringify(markdown)}\n`,
  ].join("\n"),
  "utf8"
)
