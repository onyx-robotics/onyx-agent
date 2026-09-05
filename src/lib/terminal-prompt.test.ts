import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

  test("uses and closes an explicit controlling-terminal input", async () => {
    const input = {} as NodeJS.ReadableStream
    let receivedInput: NodeJS.ReadableStream | undefined
    let inputClosed = false
    const prompt: TerminalPrompt = {
      question: async () => "2",
      once: () => undefined,
      off: () => undefined,
      close: () => undefined,
    }

    await expect(
      terminalQuestion("Team: ", "Login canceled.", {
        createInput: () => ({
          input,
          close: () => {
            inputClosed = true
          },
        }),
        createPrompt: (promptInput) => {
          receivedInput = promptInput
          return prompt
        },
      })
    ).resolves.toBe("2")
    expect(receivedInput).toBe(input)
    expect(inputClosed).toBe(true)
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

  test("accepts input in a compiled macOS CLI launched from a piped installer", async () => {
    if (process.platform !== "darwin") return

    const root = await mkdtemp(join(tmpdir(), "onyx-tty-test-"))
    try {
      const entry = join(root, "prompt.ts")
      const binary = join(root, "prompt")
      const runner = join(root, "runner.sh")
      const driver = join(root, "driver.expect")
      await writeFile(
        entry,
        `import { terminalQuestion } from ${JSON.stringify(`${import.meta.dir}/terminal-prompt.ts`)}
const answer = await terminalQuestion("Team [1-2]: ", "Canceled")
console.log("selected:" + answer)
`
      )
      const build = Bun.spawn(
        ["bun", "build", entry, "--compile", `--outfile=${binary}`],
        { stdout: "pipe", stderr: "pipe" }
      )
      const buildOutput = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ])
      expect(buildOutput[2], `${buildOutput[0]}\n${buildOutput[1]}`).toBe(0)

      await writeFile(
        runner,
        `#!/bin/sh
printf '%s\n' '# installer stdin' | sh -c 'ONYX_INSTALLER_LOGIN=1 "$1" < /dev/tty' onyx-installer ${JSON.stringify(binary)}
`
      )
      await chmod(runner, 0o755)

      await writeFile(
        driver,
        `#!/usr/bin/expect -f
set timeout 5
spawn $env(ONYX_TTY_RUNNER)
expect {
  -exact {Team [1-2]: } { send "2\\r" }
  timeout { exit 124 }
  eof { exit 1 }
}
expect {
  -exact {selected:2} {}
  timeout { exit 124 }
  eof { exit 1 }
}
expect eof
set status [wait]
exit [lindex $status 3]
`
      )

      const child = Bun.spawn(["/usr/bin/expect", driver], {
        env: { ...Bun.env, ONYX_TTY_RUNNER: runner },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])

      expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
      expect(`${stdout}\n${stderr}`).toContain("selected:2")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
