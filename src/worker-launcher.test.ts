import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { runStreamingProcess } from "./lib/process"
import {
  buildWorkerInvocation,
  preflightWorkerInvocation,
} from "./lib/worker-launcher"

async function writeFakeAgent(path: string, version: string) {
  await writeFile(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then',
      `  echo "${version}"`,
      "  exit 0",
      "fi",
      'for arg in "$@"; do',
      '  if [[ "$arg" == "--help" ]]; then',
      `    echo "${version} help"`,
      "    exit 0",
      "  fi",
      "done",
      'printf "%s\\n" "$PWD" > "$FAKE_CWD_FILE"',
      'printf "%s\\n" "$@" > "$FAKE_ARGS_FILE"',
      'cat > "$FAKE_STDIN_FILE"',
      `echo "${version} output"`,
      "",
    ].join("\n"),
    "utf8"
  )
  await chmod(path, 0o755)
}

describe("worker launchers", () => {
  test("builds direct Codex and Claude invocations without prompt argv", () => {
    const prompt = "SECRET_PROMPT"
    const codex = buildWorkerInvocation({
      agentKind: "codex",
      worktree: "/tmp/worktree",
      prompt,
    })
    const claude = buildWorkerInvocation({
      agentKind: "claude",
      worktree: "/tmp/worktree",
      prompt,
    })

    expect(codex.command).toBe("codex")
    expect(codex.args).toEqual([
      "--search",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "exec",
      "--cd",
      "/tmp/worktree",
      "--json",
      "--color",
      "never",
      "--ephemeral",
      "-",
    ])
    expect(codex.stdin).toBe(prompt)
    expect(JSON.stringify(codex.args)).not.toContain(prompt)

    expect(claude.command).toBe("claude")
    expect(claude.args).toEqual([
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "auto",
      "--add-dir",
      "/tmp/worktree",
      "--no-session-persistence",
    ])
    expect(claude.stdin).toBe(prompt)
    expect(JSON.stringify(claude.args)).not.toContain(prompt)
  })

  test("preflights and streams built-in worker stdin to logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-launcher-"))
    const bin = join(root, "bin")
    const worktree = join(root, "worktree")
    await mkdir(bin)
    await mkdir(worktree)
    await writeFakeAgent(join(bin, "codex"), "codex fake 1.0")

    const argsFile = join(root, "args.txt")
    const cwdFile = join(root, "cwd.txt")
    const stdinFile = join(root, "stdin.txt")
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_ARGS_FILE: argsFile,
      FAKE_CWD_FILE: cwdFile,
      FAKE_STDIN_FILE: stdinFile,
    }
    const invocation = buildWorkerInvocation({
      agentKind: "codex",
      worktree,
      prompt: "do useful work",
    })
    const preflight = await preflightWorkerInvocation(invocation, {
      cwd: worktree,
      env,
    })
    expect(preflight.version).toContain("codex fake 1.0")

    const logPath = join(root, "worker.log")
    const result = await runStreamingProcess(invocation.command, invocation.args, {
      cwd: worktree,
      env,
      stdin: invocation.stdin,
      logPath,
      timeoutMs: 5000,
      startupTimeoutMs: 1000,
      killGraceMs: 100,
    })

    expect(result.code).toBe(0)
    expect(await readFile(stdinFile, "utf8")).toBe("do useful work")
    expect(await readFile(cwdFile, "utf8")).toBe(
      `${await realpath(worktree)}\n`
    )
    expect(await readFile(argsFile, "utf8")).not.toContain("do useful work")
    expect(await readFile(logPath, "utf8")).toContain("codex fake 1.0 output")
  })

  test("preflights Claude with its direct print-mode launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-claude-launcher-"))
    const bin = join(root, "bin")
    const worktree = join(root, "worktree")
    await mkdir(bin)
    await mkdir(worktree)
    await writeFakeAgent(join(bin, "claude"), "claude fake 2.0")

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_ARGS_FILE: join(root, "args.txt"),
      FAKE_CWD_FILE: join(root, "cwd.txt"),
      FAKE_STDIN_FILE: join(root, "stdin.txt"),
    }
    const invocation = buildWorkerInvocation({
      agentKind: "claude",
      worktree,
      prompt: "do useful work",
    })
    const preflight = await preflightWorkerInvocation(invocation, {
      cwd: worktree,
      env,
    })

    expect(preflight.version).toContain("claude fake 2.0")
  })

  test("startup timeout kills silent workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-timeout-"))
    const result = await runStreamingProcess("sh", ["-c", "sleep 5"], {
      logPath: join(root, "worker.log"),
      timeoutMs: 5000,
      startupTimeoutMs: 50,
      killGraceMs: 50,
    })

    expect(result.timedOut).toBe(true)
    expect(result.startupTimedOut).toBe(true)
  })
})
