import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"

export type ProcessResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type StreamingProcessResult = ProcessResult & {
  signal: NodeJS.Signals | null
  startupTimedOut: boolean
  lastOutputAt: string | null
  logPath: string
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    stdin?: string
    timeoutMs?: number
  } = {}
): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin)
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
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

export async function runStreamingProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    stdin?: string
    timeoutMs?: number
    startupTimeoutMs?: number
    killGraceMs?: number
    logPath: string
    logHeader?: string
    onOutput?: (event: {
      stream: "stdout" | "stderr"
      at: string
      text: string
    }) => void
  }
): Promise<StreamingProcessResult> {
  await mkdir(dirname(options.logPath), { recursive: true })

  return new Promise((resolveProcess, reject) => {
    const useProcessGroup = process.platform !== "win32"
    const log = createWriteStream(options.logPath, { flags: "a" })
    const startedAt = new Date().toISOString()
    log.write(
      [
        "",
        `# onyx worker process started ${startedAt}`,
        `# command: ${command} ${args.join(" ")}`,
        options.cwd ? `# cwd: ${options.cwd}` : null,
        options.logHeader ?? null,
        "",
      ]
        .filter(Boolean)
        .join("\n")
    )

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: useProcessGroup,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    let startupTimedOut = false
    let closed = false
    let forceKill: ReturnType<typeof setTimeout> | null = null
    let lastOutputAt: string | null = null

    const killChild = (signal: NodeJS.Signals) => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall back to killing the direct child below.
        }
      }
      child.kill(signal)
    }

    const terminate = (startup: boolean) => {
      if (closed) return
      timedOut = true
      startupTimedOut = startupTimedOut || startup
      killChild("SIGTERM")
      forceKill = setTimeout(() => {
        if (!closed) killChild("SIGKILL")
      }, options.killGraceMs ?? 5000)
    }

    const timeout =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => terminate(false), options.timeoutMs)
    const startupTimeout =
      options.startupTimeoutMs === undefined || options.startupTimeoutMs <= 0
        ? null
        : setTimeout(() => {
            if (!lastOutputAt) terminate(true)
          }, options.startupTimeoutMs)

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin)
    }

    const recordOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const at = new Date().toISOString()
      const text = chunk.toString("utf8")
      lastOutputAt = at
      if (stream === "stdout") stdout.push(chunk)
      else stderr.push(chunk)
      log.write(`\n[${stream} ${at}]\n`)
      log.write(chunk)
      options.onOutput?.({ stream, at, text })
    }

    child.stdout?.on("data", (chunk: Buffer) => recordOutput("stdout", chunk))
    child.stderr?.on("data", (chunk: Buffer) => recordOutput("stderr", chunk))
    child.on("error", (error) => {
      closed = true
      if (timeout) clearTimeout(timeout)
      if (startupTimeout) clearTimeout(startupTimeout)
      if (forceKill) clearTimeout(forceKill)
      log.end(`\n# onyx worker process failed to start: ${error.message}\n`)
      reject(error)
    })
    child.on("close", (code, signal) => {
      if (closed) return
      closed = true
      if (timeout) clearTimeout(timeout)
      if (startupTimeout) clearTimeout(startupTimeout)
      if (forceKill) clearTimeout(forceKill)
      log.end(
        [
          "",
          `# onyx worker process exited ${new Date().toISOString()}`,
          `# code: ${code ?? "null"}`,
          `# signal: ${signal ?? "null"}`,
          `# timedOut: ${timedOut}`,
          `# startupTimedOut: ${startupTimedOut}`,
          "",
        ].join("\n")
      )
      resolveProcess({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        startupTimedOut,
        lastOutputAt,
        logPath: options.logPath,
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
