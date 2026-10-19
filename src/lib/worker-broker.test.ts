import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { pathExists } from "./process"
import {
  ONYX_WORKER_BROKER_SOCKET,
  ONYX_WORKER_BROKER_TOKEN,
  runWorkerBrokerClient,
  startWorkerBroker,
  type WorkerBroker,
} from "./worker-broker"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function brokerFixture(script: string) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "onyx-broker-test-")))
  const worktree = join(base, "worktree")
  await mkdir(join(worktree, "sub"), { recursive: true })
  const cli = join(base, "fake-onyx-worker")
  await writeFile(cli, `#!/bin/sh\n${script}\n`)
  await chmod(cli, 0o755)
  const broker = await startWorkerBroker({
    workerCliPath: cli,
    allowedRoot: worktree,
    env: { PATH: process.env.PATH, SUPERVISOR_ONLY: "visible-to-cli" },
  })
  cleanups.push(async () => {
    await broker.close()
    await rm(base, { recursive: true, force: true })
  })
  return { base, worktree, broker }
}

async function captureClient(argv: string[], env: NodeJS.ProcessEnv) {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  const capture =
    (sink: string[]) =>
    (chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
        sink.push(Buffer.from(chunk).toString("utf8"))
      }
      const callback = rest.find((value) => typeof value === "function") as
        | (() => void)
        | undefined
      callback?.()
      return true
    }
  process.stdout.write = capture(stdout) as typeof process.stdout.write
  process.stderr.write = capture(stderr) as typeof process.stderr.write
  try {
    const code = await runWorkerBrokerClient(argv, env)
    return { code, stdout: stdout.join(""), stderr: stderr.join("") }
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
}

function clientEnv(broker: WorkerBroker, token = broker.token) {
  return {
    [ONYX_WORKER_BROKER_SOCKET]: broker.socketPath,
    [ONYX_WORKER_BROKER_TOKEN]: token,
  }
}

async function rawRequest(socketPath: string, payload: unknown) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath)
    let data = ""
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on("data", (chunk: string) => (data += chunk))
    socket.on("close", () => resolve(data))
    socket.on("error", reject)
  })
}

describe("worker broker", () => {
  test("runs the real CLI outside the sandbox and relays its output", async () => {
    const { worktree, broker } = await brokerFixture(
      'echo "args:$*"; pwd; echo "env:$SUPERVISOR_ONLY:${ONYX_WORKER_BROKER_TOKEN:-unset}"; echo oops >&2; exit 3'
    )
    const previous = process.cwd()
    process.chdir(join(worktree, "sub"))
    try {
      const result = await captureClient(
        ["exp", "run", "--auto"],
        clientEnv(broker)
      )
      expect(result.code).toBe(3)
      expect(result.stdout).toContain("args:exp run --auto")
      expect(result.stdout).toContain(join(worktree, "sub"))
      // The CLI gets the supervisor's environment, never the broker secret.
      expect(result.stdout).toContain("env:visible-to-cli:unset")
      expect(result.stderr).toContain("oops")
    } finally {
      process.chdir(previous)
    }
  })

  test("rejects a client without the broker token", async () => {
    const { broker } = await brokerFixture("echo should-not-run")
    const result = await captureClient(["research", "brief"], {
      ...clientEnv(broker, "0".repeat(64)),
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("broker token rejected")
    expect(result.stdout).not.toContain("should-not-run")
  })

  test("rejects requests from outside the worker worktree", async () => {
    const { base, broker } = await brokerFixture("echo should-not-run")
    const response = await rawRequest(broker.socketPath, {
      v: 1,
      token: broker.token,
      argv: ["research", "brief"],
      cwd: base,
    })
    expect(response).toContain("must run inside the worker worktree")
    expect(response).not.toContain(Buffer.from("should-not-run").toString("base64"))
  })

  test("terminates the command when the client disconnects", async () => {
    const { base, worktree, broker } = await brokerFixture(
      `echo $$ > "${"$"}{0%/*}/pid"; exec sleep 30`
    )
    const pidFile = join(base, "pid")
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(broker.socketPath)
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({ v: 1, token: broker.token, argv: [], cwd: worktree })}\n`
        )
        const started = Date.now()
        const waitForPid = setInterval(() => {
          void pathExists(pidFile).then((exists) => {
            if (!exists && Date.now() - started < 5_000) return
            clearInterval(waitForPid)
            socket.destroy()
            resolve()
          })
        }, 25)
      })
      socket.on("error", reject)
    })
    const pid = Number((await readFile(pidFile, "utf8")).trim())
    const deadline = Date.now() + 8_000
    let alive = true
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 50))
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
  }, 15_000)

  test("close removes the socket", async () => {
    const { broker } = await brokerFixture("true")
    expect(await pathExists(broker.socketPath)).toBe(true)
    await broker.close()
    expect(await pathExists(broker.socketPath)).toBe(false)
  })
})
