// Generated from packages/core/src/registry/packs/index.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
import bio from "./bio"
import core from "./core"
import hardware from "./hardware"
import research from "./research"
import software from "./software"

/** Built-in domain packs (YAML text), loadable into any org. */
export const BUILTIN_PACKS: Record<string, string> = { core, hardware, software, bio, research }
