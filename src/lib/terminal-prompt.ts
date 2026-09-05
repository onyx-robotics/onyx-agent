import { createInterface } from "node:readline/promises"

export type TerminalPrompt = {
  question: (
    query: string,
    options: { signal: AbortSignal }
  ) => Promise<string>
  once: (event: "SIGINT", listener: () => void) => unknown
  off: (event: "SIGINT", listener: () => void) => unknown
  close: () => void
}

/**
 * Bun's readline interface consumes Ctrl+C itself while a question is active.
 * Give both readline and the process signal a single abort path so interactive
 * login prompts cancel predictably on macOS and Linux.
 */
export async function terminalQuestion(
  question: string,
  cancelMessage: string,
  options: { createPrompt?: () => TerminalPrompt } = {}
) {
  const prompt =
    options.createPrompt?.() ??
    createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  prompt.once("SIGINT", cancel)
  process.once("SIGINT", cancel)
  try {
    return await prompt.question(question, { signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(cancelMessage)
    throw error
  } finally {
    prompt.off("SIGINT", cancel)
    process.off("SIGINT", cancel)
    prompt.close()
  }
}
