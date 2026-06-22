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

import { writeConfig } from "./lib/config"
import { currentCommit, pushRefs } from "./lib/git"
import { runProcess, runStreamingProcess } from "./lib/process"
import {
  buildWorkerInvocation,
  preflightWorkerInvocation,
  writeWorkerLaunchManifest,
  writeWorkerOnyxShim,
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

async function writeFakeOnyx(path: string) {
  await writeFile(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "onyx fake 1.0"',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "developer" && "${2:-}" == "status" ]]; then',
      '  echo "{\\"mode\\":\\"dev\\",\\"apiTarget\\":\\"http://localhost:3000\\"}"',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "status" ]]; then',
      '  echo "{\\"apiTarget\\":\\"http://localhost:3000\\",\\"project\\":null}"',
      "  exit 0",
      "fi",
      'for arg in "$@"; do',
      '  if [[ "$arg" == "--help" ]]; then',
      '    echo "onyx fake command help: $*"',
      "    exit 0",
      "  fi",
      "done",
      'if [[ "${1:-}" == "--help" ]]; then',
      '  echo "onyx research should-stop"',
      '  echo "onyx knowledge add"',
      '  echo "onyx knowledge list"',
      '  echo "onyx summary upsert"',
      '  echo "onyx exp run (--campaign"',
      "  exit 0",
      "fi",
      'echo "onyx fake command $*"',
      "",
    ].join("\n"),
    "utf8"
  )
  await chmod(path, 0o755)
}

describe("worker launchers", () => {
  test("builds direct Codex and Claude invocations with git writable roots", () => {
    const prompt = "SECRET_PROMPT"
    const addedWritableRoots = ["/tmp/worktree/.git", "/tmp/repo/.git"]
    const codex = buildWorkerInvocation({
      agentKind: "codex",
      worktree: "/tmp/worktree",
      prompt,
      addedWritableRoots,
    })
    const claude = buildWorkerInvocation({
      agentKind: "claude",
      worktree: "/tmp/worktree",
      prompt,
      addedWritableRoots,
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
      "--add-dir",
      "/tmp/worktree/.git",
      "--add-dir",
      "/tmp/repo/.git",
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
      "--verbose",
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
      "--add-dir",
      "/tmp/worktree/.git",
      "--add-dir",
      "/tmp/repo/.git",
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
    await runProcess("git", ["init"], { cwd: worktree })
    await writeFakeAgent(join(bin, "codex"), "codex fake 1.0")
    await writeFakeOnyx(join(bin, "onyx"))

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
    const result = await runStreamingProcess(
      invocation.command,
      invocation.args,
      {
        cwd: worktree,
        env,
        stdin: invocation.stdin,
        logPath,
        timeoutMs: 5000,
        startupTimeoutMs: 1000,
        killGraceMs: 100,
      }
    )

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
    await runProcess("git", ["init"], { cwd: worktree })
    await writeFakeAgent(join(bin, "claude"), "claude fake 2.0")
    await writeFakeOnyx(join(bin, "onyx"))

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

  test("writes launch manifests after creating parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-manifest-"))
    const manifestPath = join(root, "missing", "worker.manifest.json")

    await writeWorkerLaunchManifest({
      schemaVersion: 1,
      agentKind: "codex",
      command: "codex",
      args: ["exec"],
      onyxShimPath: null,
      addedWritableRoots: [],
      cwd: root,
      promptPath: join(root, "prompt.md"),
      logPath: join(root, "worker.log"),
      manifestPath,
      sessionId: "session",
      hypothesisId: "hypothesis",
      hypothesisName: "hypothesis-one",
      workerId: "worker",
      version: null,
      startedAt: "2026-06-20T00:00:00.000Z",
      lastOutputAt: null,
      completedAt: null,
      status: "starting",
      exitCode: null,
      signal: null,
      timedOut: false,
      startupTimedOut: false,
      error: null,
      preflight: null,
      finalization: null,
    })

    expect(await readFile(manifestPath, "utf8")).toContain('"schemaVersion": 1')
  })

  test("dev-mode onyx shim dispatches through linked checkout with bypass", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-shim-root-"))
    const configHome = await mkdtemp(join(tmpdir(), "onyx-worker-shim-config-"))
    const checkout = await mkdtemp(join(tmpdir(), "onyx-worker-shim-checkout-"))
    await runProcess("git", ["init"], { cwd: root })
    await mkdir(join(checkout, "bin"), { recursive: true })
    await mkdir(join(checkout, "skills", "onyx"), { recursive: true })
    const binPath = join(checkout, "bin", "onyx.js")
    await writeFile(
      binPath,
      [
        "#!/usr/bin/env bun",
        'if (process.env.ONYX_LAUNCHER_BYPASS !== "1") process.exit(42)',
        'if (process.argv.includes("--help")) {',
        '  console.log("onyx research should-stop")',
        '  console.log("onyx knowledge add")',
        '  console.log("onyx knowledge list")',
        '  console.log("onyx summary upsert")',
        '  console.log("onyx exp run [--campaign")',
        "  process.exit(0)",
        "}",
        'console.log("linked checkout")',
        "",
      ].join("\n"),
      "utf8"
    )
    await chmod(binPath, 0o755)

    const previousConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome
    try {
      await writeConfig({
        currentProfile: "",
        profiles: {},
        developer: {
          mode: "dev",
          checkout: {
            root: checkout,
            binPath,
            skillPath: join(checkout, "skills", "onyx", "SKILL.md"),
          },
        },
      })

      const shim = await writeWorkerOnyxShim({ root, sessionId: "session" })
      expect(shim.mode).toBe("dev")
      expect(shim.target).toBe(binPath)
      const help = await runProcess(shim.onyxPath, ["--help"], {
        timeoutMs: 5000,
      })
      expect(help.code).toBe(0)
      expect(help.stdout).toContain("onyx research should-stop")
      expect(help.stdout).toContain("onyx knowledge list")
      expect(help.stdout).toContain("onyx summary upsert")
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome
      }
    }
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

  test("pushRefs dedupes duplicate destinations and rejects conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-pushrefs-root-"))
    const remote = await mkdtemp(join(tmpdir(), "onyx-pushrefs-remote-"))
    await runProcess("git", ["init"], { cwd: root })
    await runProcess("git", ["init", "--bare"], { cwd: remote })
    await runProcess("git", ["remote", "add", "origin", remote], { cwd: root })
    await writeFile(join(root, "README.md"), "one\n", "utf8")
    await runProcess("git", ["add", "README.md"], { cwd: root })
    await runProcess(
      "git",
      [
        "-c",
        "user.name=Onyx Test",
        "-c",
        "user.email=onyx@example.com",
        "commit",
        "-m",
        "one",
      ],
      { cwd: root }
    )
    const first = await currentCommit(root)
    await writeFile(join(root, "README.md"), "two\n", "utf8")
    await runProcess("git", ["add", "README.md"], { cwd: root })
    await runProcess(
      "git",
      [
        "-c",
        "user.name=Onyx Test",
        "-c",
        "user.email=onyx@example.com",
        "commit",
        "-m",
        "two",
      ],
      { cwd: root }
    )
    const second = await currentCommit(root)

    await pushRefs(root, [
      { commitSha: first, ref: "refs/onyx/experiments/test/run" },
      { commitSha: first, ref: "refs/onyx/experiments/test/run" },
    ])
    await expect(
      pushRefs(root, [
        { commitSha: first, ref: "refs/onyx/experiments/test/conflict" },
        { commitSha: second, ref: "refs/onyx/experiments/test/conflict" },
      ])
    ).rejects.toThrow("Conflicting push destinations")
  })
})
