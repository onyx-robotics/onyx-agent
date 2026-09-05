import { openSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { ReadStream } from "node:tty"

export type TerminalPrompt = {
  question: (
    query: string,
    options: { signal: AbortSignal }
  ) => Promise<string>
  once: (event: "SIGINT", listener: () => void) => unknown
  off: (event: "SIGINT", listener: () => void) => unknown
  close: () => void
}

type TerminalInput = {
  input: NodeJS.ReadableStream
  close: () => void
}

function installerTerminalInput(): TerminalInput | undefined {
  if (
    process.platform !== "darwin" ||
    process.env.ONYX_INSTALLER_LOGIN !== "1"
  ) {
    return undefined
  }

  try {
    const input = new ReadStream(openSync("/dev/tty", "r"))
    return {
      input,
      close: () => input.destroy(),
    }
  } catch {
    // The installer already attached fd 0 to /dev/tty. Falling back keeps
    // direct and unusual terminal environments usable if a second open fails.
    return undefined
  }
}

/**
 * Bun's readline interface consumes Ctrl+C itself while a question is active.
 * Give both readline and the process signal a single abort path so interactive
 * login prompts cancel predictably on macOS and Linux.
 */
export async function terminalQuestion(
  question: string,
  cancelMessage: string,
  options: {
    createInput?: () => TerminalInput | undefined
    createPrompt?: (input: NodeJS.ReadableStream) => TerminalPrompt
  } = {}
) {
  const terminalInput = options.createInput?.() ?? installerTerminalInput()
  const input = terminalInput?.input ?? process.stdin
  const controller = new AbortController()
  const cancel = () => controller.abort()
  let prompt: TerminalPrompt | undefined
  try {
    prompt =
      options.createPrompt?.(input) ??
      createInterface({ input, output: process.stdout })
    prompt.once("SIGINT", cancel)
    process.once("SIGINT", cancel)
    return await prompt.question(question, { signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(cancelMessage)
    throw error
  } finally {
    prompt?.off("SIGINT", cancel)
    process.off("SIGINT", cancel)
    prompt?.close()
    terminalInput?.close()
  }
}
