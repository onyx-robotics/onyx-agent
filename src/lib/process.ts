import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"

export type ProcessResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled?: boolean
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  stdoutBytes?: number
  stderrBytes?: number
}

export type StreamingProcessResult = ProcessResult & {
  signal: NodeJS.Signals | null
  startupTimedOut: boolean
  lastOutputAt: string | null
  logPath: string
  activityLogPath: string | null
  cancelled: boolean
}

function compact(value: string, limit = 500) {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 1))}...`
    : normalized
}

function textFromClaudeMessage(record: Record<string, unknown>) {
  const message = record.message
  if (!message || typeof message !== "object") return []
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return []
  const lines: string[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const block = item as Record<string, unknown>
    if (block.type === "text" && typeof block.text === "string") {
      lines.push(compact(block.text))
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      lines.push(`tool: ${block.name}`)
    }
  }
  return lines
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string")
}

function nestedErrorMessage(value: unknown): string | null {
  const record = recordObject(value)
  if (!record) return typeof value === "string" ? value : null
  const direct = firstString(record.message, record.name, record.code)
  const cause = nestedErrorMessage(record.cause)
  const error = nestedErrorMessage(record.error)
  return [direct, cause, error].filter(Boolean).join(": ") || null
}

function openCodeToolLine(record: Record<string, unknown>) {
  const part = recordObject(record.part)
  const input = recordObject(record.input) ?? recordObject(part?.input)
  const name =
    firstString(record.name, record.tool, part?.name, part?.tool) ?? "tool"
  const command = firstString(
    record.command,
    input?.command,
    input?.cmd,
    input?.args
  )
  if (command && command !== name) return `tool: ${name} ${compact(command, 180)}`
  return `tool: ${name}`
}

function activityLinesFromOpenCodeEvent(record: Record<string, unknown>) {
  const type = record.type
  if (type === "text" && typeof record.text === "string") {
    return [compact(record.text)]
  }
  if (type === "tool_use" || type === "tool") {
    return [openCodeToolLine(record)]
  }
  if (recordObject(record.part)?.type === "tool") {
    return [openCodeToolLine(record)]
  }
  if (type === "step_start") return ["step: start"]
  if (type === "step_finish") return ["step: finish"]
  if (type === "error") {
    return [`error: ${compact(nestedErrorMessage(record) ?? "opencode")}`]
  }
  const errorMessage = nestedErrorMessage(record.error)
  if (errorMessage) return [`error: ${compact(errorMessage)}`]
  return []
}

function activityLinesForOutput(
  stream: "stdout" | "stderr",
  text: string
): string[] {
  const lines: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (
        parsed.type === "content_block_delta" &&
        parsed.delta &&
        typeof parsed.delta === "object" &&
        (parsed.delta as Record<string, unknown>).type === "text_delta" &&
        typeof (parsed.delta as Record<string, unknown>).text === "string"
      ) {
        lines.push(
          compact((parsed.delta as Record<string, unknown>).text as string)
        )
        continue
      }
      if (parsed.type === "assistant") {
        lines.push(...textFromClaudeMessage(parsed))
        continue
      }
      const openCodeLines = activityLinesFromOpenCodeEvent(parsed)
      if (openCodeLines.length > 0) {
        lines.push(...openCodeLines)
        continue
      }
      if (parsed.type === "result" && typeof parsed.subtype === "string") {
        lines.push(`result: ${parsed.subtype}`)
        continue
      }
      if (parsed.type === "system" && typeof parsed.subtype === "string") {
        lines.push(`system: ${parsed.subtype}`)
        continue
      }
      if (typeof parsed.message === "string") {
        lines.push(compact(parsed.message))
        continue
      }
      if (typeof parsed.type === "string") {
        lines.push(compact(`${parsed.type}`))
        continue
      }
    } catch {
      lines.push(compact(line))
      continue
    }
  }
  return lines.map((line) => `[${stream}] ${line}`)
}

function appendTail(existing: Buffer, chunk: Buffer, limit: number) {
  if (limit <= 0) return Buffer.alloc(0)
  const combined = Buffer.concat([existing, chunk])
  if (combined.byteLength <= limit) return combined
  return combined.subarray(combined.byteLength - limit)
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
    outputTailBytes?: number
    logPath: string
    activityLogPath?: string
    logHeader?: string
    cancel?: {
      shouldCancel: () => boolean | Promise<boolean>
      graceMs?: number
      pollMs?: number
      reason?: string
    }
    onOutput?: (event: {
      stream: "stdout" | "stderr"
      at: string
      text: string
    }) => void
    terminateOnOutput?: (event: {
      stream: "stdout" | "stderr"
      at: string
      text: string
    }) => boolean
  }
): Promise<StreamingProcessResult> {
  await mkdir(dirname(options.logPath), { recursive: true })
  if (options.activityLogPath) {
    await mkdir(dirname(options.activityLogPath), { recursive: true })
  }

  return new Promise((resolveProcess, reject) => {
    const useProcessGroup = process.platform !== "win32"
    const log = createWriteStream(options.logPath, { flags: "a" })
    const activityLog = options.activityLogPath
      ? createWriteStream(options.activityLogPath, { flags: "a" })
      : null
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
    activityLog?.write(
      [
        `# onyx worker activity started ${startedAt}`,
        `# command: ${command} ${args.join(" ")}`,
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
    const outputTailBytes = options.outputTailBytes ?? 256 * 1024
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let startupTimedOut = false
    let cancelled = false
    let closed = false
    let forceKill: ReturnType<typeof setTimeout> | null = null
    let cancelPoll: ReturnType<typeof setInterval> | null = null
    let cancelCheckRunning = false
    let lastOutputAt: string | null = null
    let interrupted = false

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

    const terminate = ({
      startup = false,
      markTimedOut = true,
      markCancelled = false,
    }: {
      startup?: boolean
      markTimedOut?: boolean
      markCancelled?: boolean
    } = {}) => {
      if (closed) return
      timedOut = timedOut || markTimedOut
      startupTimedOut = startupTimedOut || startup
      cancelled = cancelled || markCancelled
      killChild("SIGTERM")
      forceKill = setTimeout(
        () => {
          if (!closed) killChild("SIGKILL")
        },
        markCancelled
          ? (options.cancel?.graceMs ?? options.killGraceMs ?? 5000)
          : (options.killGraceMs ?? 5000)
      )
    }

    const signalHandlers = new Map<NodeJS.Signals, () => void>()
    for (const signal of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
      const handler = () => {
        if (closed) return
        if (interrupted) {
          killChild("SIGKILL")
          return
        }
        interrupted = true
        terminate()
      }
      signalHandlers.set(signal, handler)
      process.on(signal, handler)
    }

    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler)
      }
      signalHandlers.clear()
    }

    const timeout =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => terminate(), options.timeoutMs)
    const startupTimeout =
      options.startupTimeoutMs === undefined || options.startupTimeoutMs <= 0
        ? null
        : setTimeout(() => {
            if (!lastOutputAt) terminate({ startup: true })
          }, options.startupTimeoutMs)
    if (options.cancel) {
      cancelPoll = setInterval(() => {
        if (closed || cancelled || cancelCheckRunning) return
        cancelCheckRunning = true
        Promise.resolve(options.cancel!.shouldCancel())
          .then((shouldCancel) => {
            if (!shouldCancel || closed || cancelled) return
            const at = new Date().toISOString()
            activityLog?.write(
              `[harness ${at}] stop requested; terminating provider process after ${Math.round((options.cancel?.graceMs ?? options.killGraceMs ?? 5000) / 1000)}s grace\n`
            )
            terminate({ markTimedOut: false, markCancelled: true })
          })
          .catch((error) => {
            const at = new Date().toISOString()
            activityLog?.write(
              `[harness ${at}] stop check failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`
            )
          })
          .finally(() => {
            cancelCheckRunning = false
          })
      }, options.cancel.pollMs ?? 2000)
    }

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin)
    }

    const recordOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const at = new Date().toISOString()
      const text = chunk.toString("utf8")
      lastOutputAt = at
      if (stream === "stdout") {
        stdoutBytes += chunk.byteLength
        stdout = appendTail(stdout, chunk, outputTailBytes)
      } else {
        stderrBytes += chunk.byteLength
        stderr = appendTail(stderr, chunk, outputTailBytes)
      }
      log.write(`\n[${stream} ${at}]\n`)
      log.write(chunk)
      for (const line of activityLinesForOutput(stream, text)) {
        activityLog?.write(`[${at}] ${line}\n`)
      }
      options.onOutput?.({ stream, at, text })
      if (options.terminateOnOutput?.({ stream, at, text })) {
        activityLog?.write(
          `[harness ${at}] terminal provider output detected; terminating provider process\n`
        )
        terminate({ markTimedOut: false })
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => recordOutput("stdout", chunk))
    child.stderr?.on("data", (chunk: Buffer) => recordOutput("stderr", chunk))
    child.on("error", (error) => {
      closed = true
      if (timeout) clearTimeout(timeout)
      if (startupTimeout) clearTimeout(startupTimeout)
      if (forceKill) clearTimeout(forceKill)
      if (cancelPoll) clearInterval(cancelPoll)
      removeSignalHandlers()
      log.end(`\n# onyx worker process failed to start: ${error.message}\n`)
      activityLog?.end(
        `# onyx worker activity failed to start: ${error.message}\n`
      )
      reject(error)
    })
    child.on("close", async (code, signal) => {
      if (closed) return
      closed = true
      if (timeout) clearTimeout(timeout)
      if (startupTimeout) clearTimeout(startupTimeout)
      if (forceKill) clearTimeout(forceKill)
      if (cancelPoll) clearInterval(cancelPoll)
      removeSignalHandlers()
      await Promise.all([
        new Promise<void>((resolve) => {
          log.end(
            [
              "",
              `# onyx worker process exited ${new Date().toISOString()}`,
              `# code: ${code ?? "null"}`,
              `# signal: ${signal ?? "null"}`,
              `# timedOut: ${timedOut}`,
              `# startupTimedOut: ${startupTimedOut}`,
              `# cancelled: ${cancelled}`,
              "",
            ].join("\n"),
            resolve
          )
        }),
        activityLog
          ? new Promise<void>((resolve) => {
              activityLog.end(
                [
                  `# onyx worker activity exited ${new Date().toISOString()}`,
                  `# code: ${code ?? "null"}`,
                  `# signal: ${signal ?? "null"}`,
                  `# cancelled: ${cancelled}`,
                  "",
                ].join("\n"),
                resolve
              )
            })
          : Promise.resolve(),
      ])
      resolveProcess({
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        cancelled,
        stdoutTruncated: stdoutBytes > stdout.byteLength,
        stderrTruncated: stderrBytes > stderr.byteLength,
        stdoutBytes,
        stderrBytes,
        startupTimedOut,
        lastOutputAt,
        logPath: options.logPath,
        activityLogPath: options.activityLogPath ?? null,
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
