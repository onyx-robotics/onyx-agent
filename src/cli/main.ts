#!/usr/bin/env bun
/** The onyx command: run.ts over this process. */
import { createInterface } from "node:readline"

import { run } from "./run"

if (import.meta.main) {
  const ask = (question: string, hidden = false) =>
    new Promise<string | null>((resolve) => {
      if (!process.stdin.isTTY) return resolve(null)
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
      if (hidden) {
        // don't echo a secret as it's typed
        const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput
        ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) =>
          write.call(rl, s.startsWith(question) ? s : "")
      }
      rl.question(question, (answer) => {
        rl.close()
        if (hidden) process.stderr.write("\n")
        resolve(answer.trim())
      })
    })
  // a reader that stops early (`onyx ls | head`) isn't an error: stop too
  const gone = (e: unknown) => {
    if ((e as { code?: string }).code === "EPIPE") process.exit(0)
    throw e
  }
  process.stdout.on("error", gone)
  // the person's browser, best effort: a launcher that hangs or fails just means "not opened"
  const openUrl = async (url: string) => {
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url]
    try {
      const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      const exited = await Promise.race([
        child.exited,
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ])
      if (exited === null) child.kill()
      return exited === 0
    } catch {
      return false
    }
  }
  const code = await run(process.argv.slice(2), {
    stdout: (t) => {
      try {
        process.stdout.write(t)
      } catch (e) {
        gone(e)
      }
    },
    stderr: (t) => void process.stderr.write(t),
    stdin: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
    isTTY: process.stdout.isTTY === true,
    env: process.env,
    prompt: (q, opts) => ask(q, opts?.hidden),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    openUrl,
  })
  // let stdout drain before leaving
  process.exitCode = code
}
