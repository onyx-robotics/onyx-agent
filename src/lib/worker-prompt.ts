import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { HYPOTHESIS_WORKER_PROMPT_MARKDOWN } from "./worker-prompt-content"

export function packagedHypothesisWorkerPromptPath() {
  return fileURLToPath(
    new URL("../../prompts/hypothesis-worker.md", import.meta.url)
  )
}

export async function readHypothesisWorkerPrompt() {
  try {
    return await readFile(packagedHypothesisWorkerPromptPath(), "utf8")
  } catch {
    return HYPOTHESIS_WORKER_PROMPT_MARKDOWN
  }
}
