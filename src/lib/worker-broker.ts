import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { createConnection, createServer, type Socket } from "node:net"
import { constants, tmpdir } from "node:os"
import { join, sep } from "node:path"

/**
 * Sandboxed workers reach the real `onyx-worker` through this broker. The
 * in-sandbox `onyx-worker` is a thin client: it forwards argv and cwd over a
 * per-worker Unix socket, and the supervisor runs the pinned worker CLI
 * outside the agent sandbox with the worker credential and `.git/onyx`
 * state the agent itself cannot reach. Evaluation tools that CLI launches
 * get their own sandbox (see tools.ts).
 */
export const ONYX_WORKER_BROKER_SOCKET = "ONYX_WORKER_BROKER_SOCKET"
export const ONYX_WORKER_BROKER_TOKEN = "ONYX_WORKER_BROKER_TOKEN"

const PROTOCOL_VERSION = 1
const MAX_REQUEST_BYTES = 1024 * 1024
const KILL_GRACE_MS = 5_000
/** sockaddr_un.sun_path is 104 bytes on macOS and 108 on Linux. */
const MAX_SOCKET_PATH = 100

type BrokerRequest = {
  v: number
  token: string
  argv: string[]
  cwd: string
}

type BrokerFrame =
  | { t: "o" | "e"; d: string }
  | { t: "x"; code: number | null; signal: string | null }
  | { t: "err"; message: string }

export type WorkerBroker = {
  socketPath: string
  token: string
  close(): Promise<void>
}

function writeFrame(socket: Socket, frame: BrokerFrame) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`)
}

function isWithin(path: string, ancestor: string) {
  return path === ancestor || path.startsWith(`${ancestor}${sep}`)
}

function tokensMatch(expected: string, received: unknown) {
  if (typeof received !== "string") return false
  const left = Buffer.from(expected)
  const right = Buffer.from(received)
  return left.length === right.length && timingSafeEqual(left, right)
}

function parseRequest(line: string, token: string): BrokerRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error("malformed broker request")
  }
  const request = value as Partial<BrokerRequest>
  if (request?.v !== PROTOCOL_VERSION) {
    throw new Error("unsupported broker protocol version")
  }
  if (!tokensMatch(token, request.token)) {
    throw new Error("broker token rejected")
  }
  if (
    !Array.isArray(request.argv) ||
    !request.argv.every((arg) => typeof arg === "string") ||
    typeof request.cwd !== "string"
  ) {
    throw new Error("malformed broker request")
  }
  return request as BrokerRequest
}

async function socketDirectory() {
  for (const base of [tmpdir(), "/tmp"]) {
    const dir = await mkdtemp(join(base, "onyx-broker-"))
    const real = await realpath(dir)
    if (join(real, "s").length <= MAX_SOCKET_PATH) return real
    await rm(dir, { recursive: true, force: true })
  }
  throw new Error("Unable to place the worker broker socket in a short path")
}

export async function startWorkerBroker({
  workerCliPath,
  allowedRoot,
  env,
}: {
  /** Pinned worker CLI wrapper, executed outside the sandbox. */
  workerCliPath: string
  /** Requests must originate inside this directory (the worktree). */
  allowedRoot: string
  /** Environment for the real worker CLI (credential context, ONYX_HOME). */
  env: NodeJS.ProcessEnv
}): Promise<WorkerBroker> {
  const dir = await socketDirectory()
  const socketPath = join(dir, "s")
  const token = randomBytes(32).toString("hex")
  const root = await realpath(allowedRoot)
  const children = new Set<ChildProcess>()
  const childEnv = { ...env }
  delete childEnv[ONYX_WORKER_BROKER_SOCKET]
  delete childEnv[ONYX_WORKER_BROKER_TOKEN]

  const terminate = (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid)
      return
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal)
      } catch {
        child.kill(signal)
      }
    }
    kill("SIGTERM")
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) kill("SIGKILL")
    }, KILL_GRACE_MS).unref()
  }

  const handle = (socket: Socket) => {
    let buffer = ""
    let started = false
    socket.setEncoding("utf8")
    socket.on("error", () => {})
    socket.on("data", (chunk: string) => {
      if (started) return
      buffer += chunk
      if (buffer.length > MAX_REQUEST_BYTES) {
        writeFrame(socket, { t: "err", message: "broker request too large" })
        socket.end()
        return
      }
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      started = true
      void run(socket, buffer.slice(0, newline))
    })
  }

  const run = async (socket: Socket, line: string) => {
    let request: BrokerRequest
    let cwd: string
    try {
      request = parseRequest(line, token)
      cwd = await realpath(request.cwd)
      if (!isWithin(cwd, root)) {
        throw new Error(
          `onyx-worker must run inside the worker worktree ${root} (cwd ${cwd})`
        )
      }
    } catch (error) {
      writeFrame(socket, {
        t: "err",
        message: error instanceof Error ? error.message : String(error),
      })
      socket.end()
      return
    }
    const child = spawn(workerCliPath, request.argv, {
      cwd,
      env: childEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    children.add(child)
    child.stdout?.on("data", (data: Buffer) =>
      writeFrame(socket, { t: "o", d: data.toString("base64") })
    )
    child.stderr?.on("data", (data: Buffer) =>
      writeFrame(socket, { t: "e", d: data.toString("base64") })
    )
    child.on("error", (error) => {
      children.delete(child)
      writeFrame(socket, { t: "err", message: error.message })
      socket.end()
    })
    child.on("close", (code, signal) => {
      children.delete(child)
      writeFrame(socket, { t: "x", code, signal })
      socket.end()
    })
    // A client that goes away (agent tool timeout, kill) takes its command
    // down with it, exactly as a directly executed CLI would.
    socket.on("close", () => terminate(child))
  }

  const server = createServer(handle)
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(socketPath, () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })

  return {
    socketPath,
    token,
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      for (const child of children) terminate(child)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/**
 * Client half, run by the `onyx-worker` entrypoint inside the sandbox.
 * Returns the remote exit status (128 + signal number for signals).
 */
export async function runWorkerBrokerClient(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const socketPath = env[ONYX_WORKER_BROKER_SOCKET]
  const token = env[ONYX_WORKER_BROKER_TOKEN]
  if (!socketPath || !token) {
    throw new Error("onyx-worker broker environment is incomplete")
  }
  return new Promise<number>((resolveClient) => {
    const socket = createConnection(socketPath)
    let buffer = ""
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.off(signal, onSignal)
      }
      // Callers may process.exit() on a nonzero status; flush output first.
      process.stdout.write("", () =>
        process.stderr.write("", () => resolveClient(code))
      )
    }
    const onSignal = (signal: NodeJS.Signals) => {
      socket.destroy()
      finish(signal === "SIGINT" ? 130 : 143)
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, onSignal)
    }
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          v: PROTOCOL_VERSION,
          token,
          argv,
          cwd: process.cwd(),
        } satisfies BrokerRequest)}\n`
      )
    })
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        let frame: BrokerFrame
        try {
          frame = JSON.parse(line) as BrokerFrame
        } catch {
          continue
        }
        if (frame.t === "o") process.stdout.write(Buffer.from(frame.d, "base64"))
        else if (frame.t === "e")
          process.stderr.write(Buffer.from(frame.d, "base64"))
        else if (frame.t === "err") {
          process.stderr.write(`onyx-worker broker: ${frame.message}\n`)
          finish(1)
        } else if (frame.t === "x") {
          const signal = frame.signal as NodeJS.Signals | null
          finish(
            frame.code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)
          )
        }
      }
    })
    socket.on("error", (error) => {
      process.stderr.write(
        `onyx-worker broker unavailable at ${socketPath}: ${error.message}\n`
      )
      finish(1)
    })
    socket.on("close", () => finish(1))
  })
}
