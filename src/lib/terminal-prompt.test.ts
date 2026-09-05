import { describe, expect, test } from "bun:test"

import { terminalQuestion, type TerminalPrompt } from "./terminal-prompt"

describe("terminal prompts", () => {
  test("returns an answer and closes the prompt", async () => {
    let closed = false
    const prompt: TerminalPrompt = {
      question: async () => "1",
      once: () => undefined,
      off: () => undefined,
      close: () => {
        closed = true
      },
    }

    await expect(
      terminalQuestion("Team: ", "Login canceled.", {
        createPrompt: () => prompt,
      })
    ).resolves.toBe("1")
    expect(closed).toBe(true)
  })

  test("turns readline Ctrl+C into a clean cancellation", async () => {
    let interrupt: (() => void) | undefined
    let closed = false
    const prompt: TerminalPrompt = {
      question: (_question, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        }),
      once: (_event, listener) => {
        interrupt = listener
      },
      off: () => undefined,
      close: () => {
        closed = true
      },
    }

    const answer = terminalQuestion("Team: ", "Login canceled.", {
      createPrompt: () => prompt,
    })
    interrupt?.()

    await expect(answer).rejects.toThrow("Login canceled.")
    expect(closed).toBe(true)
  })
})
