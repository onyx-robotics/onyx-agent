import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"

export type ProcessResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    const timeout =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true
            child.kill("SIGTERM")
          }, options.timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout)
      resolveProcess({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      })
    })
  })
}

export async function commandOutput(
  command: string,
  args: string[],
  cwd?: string
) {
  const result = await runProcess(command, args, { cwd })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        result.timedOut
          ? "timed out"
          : result.stderr.trim() || result.stdout.trim()
      }`
    )
  }
  return result.stdout.trim()
}

export async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
