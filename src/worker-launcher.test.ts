import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, test } from "bun:test"

import { writeConfig } from "./lib/config"
import { currentCommit, pushRefs } from "./lib/git"
import { runProcess, runStreamingProcess } from "./lib/process"
import {
  buildWorkerInvocation,
  preflightWorkerInvocation,
  workerRuntimeEnvironment,
  workerRuntimePaths,
  writeWorkerLaunchManifest,
  writeWorkerCliWrapper,
  writeWorkerRuntimeContext,
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
      'if [[ "${1:-}" == "tools" && "${2:-}" == "run" ]]; then',
      '  echo "unexpected tools run: $*" >&2',
      "  exit 99",
      "fi",
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
  test("builds direct Codex, Claude, and OpenCode invocations", () => {
    const prompt = "SECRET_PROMPT"
    const addedWritableRoots = ["/tmp/worktree/.git", "/tmp/repo/.git"]
    const codex = buildWorkerInvocation({
      agentKind: "codex",
      worktree: "/tmp/worktree",
      prompt,
      addedWritableRoots,
      workerModel: "gpt-5-codex",
    })
    const claude = buildWorkerInvocation({
      agentKind: "claude",
      worktree: "/tmp/worktree",
      prompt,
      addedWritableRoots,
      workerModel: "sonnet",
    })
    const opencode = buildWorkerInvocation({
      agentKind: "opencode",
      worktree: "/tmp/worktree",
      prompt,
      workerModel: "openrouter/qwen/qwen3-coder",
      workerTitle: "worker_123",
    })

    expect(codex.command).toBe("codex")
    expect(codex.args).toEqual([
      "--search",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--model",
      "gpt-5-codex",
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
      "--model",
      "sonnet",
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

    expect(opencode.command).toBe("opencode")
    expect(opencode.args).toEqual([
      "run",
      "--pure",
      "--dir",
      "/tmp/worktree",
      "--format",
      "json",
      "--title",
      "worker_123",
      "--model",
      "openrouter/qwen/qwen3-coder",
      "--print-logs",
      "--log-level",
      "ERROR",
      "--dangerously-skip-permissions",
    ])
    expect(opencode.preflightArgs).toEqual(["run", "--help"])
    expect(opencode.stdin).toBe(prompt)
    expect(JSON.stringify(opencode.args)).not.toContain(prompt)
  })

  test("preflights and streams built-in worker stdin to logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-launcher-"))
    const bin = join(root, "bin")
    const worktree = join(root, "worktree")
    await mkdir(bin)
    await mkdir(worktree)
    await runProcess("git", ["init"], { cwd: worktree })
    await writeFakeAgent(join(bin, "codex"), "codex fake 1.0")
    await writeFakeOnyx(join(bin, "onyx-worker"))

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
    const activityLogPath = join(root, "worker.activity.log")
    const result = await runStreamingProcess(
      invocation.command,
      invocation.args,
      {
        cwd: worktree,
        env,
        stdin: invocation.stdin,
        logPath,
        activityLogPath,
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
    expect(await readFile(activityLogPath, "utf8")).toContain(
      "codex fake 1.0 output"
    )
    expect(result.activityLogPath).toBe(activityLogPath)
  })

  test("streams common OpenCode JSON events to activity logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-opencode-activity-"))
    const logPath = join(root, "worker.log")
    const activityLogPath = join(root, "worker.activity.log")
    const result = await runStreamingProcess(
      "sh",
      [
        "-c",
        [
          `printf '%s\\n' '{"type":"step_start"}'`,
          `printf '%s\\n' '{"type":"text","text":"hello from opencode"}'`,
          `printf '%s\\n' '{"type":"tool_use","name":"bash"}'`,
          `printf '%s\\n' '{"type":"tool_use","part":{"type":"tool","tool":"bash","input":{"command":"bun test"}}}'`,
          `printf '%s\\n' '{"type":"step_finish"}'`,
          `printf '%s\\n' '{"type":"error","message":"provider failed"}'`,
        ].join("; "),
      ],
      {
        logPath,
        activityLogPath,
        timeoutMs: 5000,
        startupTimeoutMs: 1000,
        killGraceMs: 100,
      }
    )

    expect(result.code).toBe(0)
    const activity = await readFile(activityLogPath, "utf8")
    expect(activity).toContain("[stdout] step: start")
    expect(activity).toContain("[stdout] hello from opencode")
    expect(activity).toContain("[stdout] tool: bash")
    expect(activity).toContain("[stdout] tool: bash bun test")
    expect(activity).toContain("[stdout] step: finish")
    expect(activity).toContain("[stdout] error: provider failed")
  })

  test("can terminate streaming processes on matched provider output", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-provider-terminate-"))
    const logPath = join(root, "worker.log")
    const activityLogPath = join(root, "worker.activity.log")
    const result = await runStreamingProcess(
      "sh",
      [
        "-c",
        "printf '%s\\n' 'AI_APICallError: Rate limit exceeded. Please try again later.' >&2; sleep 5",
      ],
      {
        logPath,
        activityLogPath,
        timeoutMs: 5000,
        startupTimeoutMs: 1000,
        killGraceMs: 100,
        terminateOnOutput: ({ text }) => text.includes("Rate limit exceeded"),
      }
    )

    expect(result.timedOut).toBe(false)
    expect(result.stderr).toContain("Rate limit exceeded")
    expect(await readFile(activityLogPath, "utf8")).toContain(
      "terminal provider output detected"
    )
  })

  test("streams full output to logs while retaining only bounded tails", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-tail-"))
    const logPath = join(root, "worker.log")
    const result = await runStreamingProcess(
      "sh",
      [
        "-c",
        "printf 'abcdefghijklmnopqrstuvwxyz'; printf '0123456789abcdef' >&2",
      ],
      {
        logPath,
        timeoutMs: 5000,
        startupTimeoutMs: 1000,
        killGraceMs: 100,
        outputTailBytes: 10,
      }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toBe("qrstuvwxyz")
    expect(result.stderr).toBe("6789abcdef")
    expect(result.stdoutBytes).toBe(26)
    expect(result.stderrBytes).toBe(16)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    const log = await readFile(logPath, "utf8")
    expect(log).toContain("abcdefghijklmnopqrstuvwxyz")
    expect(log).toContain("0123456789abcdef")
  })

  test("preflights Claude with its direct print-mode launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-claude-launcher-"))
    const bin = join(root, "bin")
    const worktree = join(root, "worktree")
    await mkdir(bin)
    await mkdir(worktree)
    await runProcess("git", ["init"], { cwd: worktree })
    await writeFakeAgent(join(bin, "claude"), "claude fake 2.0")
    await writeFakeOnyx(join(bin, "onyx-worker"))

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

  test("OpenCode preflight failures include install guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-opencode-preflight-"))
    const bin = join(root, "bin")
    const worktree = join(root, "worktree")
    await mkdir(bin)
    await mkdir(worktree)
    await writeFile(
      join(bin, "opencode"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'echo "opencode auth missing" >&2',
        "exit 7",
        "",
      ].join("\n"),
      "utf8"
    )
    await chmod(join(bin, "opencode"), 0o755)

    const invocation = buildWorkerInvocation({
      agentKind: "opencode",
      worktree,
      prompt: "do useful work",
      workerModel: "openrouter/qwen/qwen3-coder",
    })
    await expect(
      preflightWorkerInvocation(invocation, {
        cwd: worktree,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        },
      })
    ).rejects.toThrow(
      "Install or authenticate OpenCode before using `--agent opencode`."
    )
  })

  test("preflight does not run the evaluation tool before worker launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-no-eval-"))
    const bin = join(root, "bin")
    const worktree = join(root, "worktree")
    await mkdir(bin)
    await mkdir(worktree)
    await runProcess("git", ["init"], { cwd: worktree })
    await writeFakeAgent(join(bin, "codex"), "codex fake 1.0")
    await writeFakeOnyx(join(bin, "onyx-worker"))

    const invocation = buildWorkerInvocation({
      agentKind: "codex",
      worktree,
      prompt: "do useful work",
    })
    const preflight = await preflightWorkerInvocation(invocation, {
      cwd: worktree,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      campaignName: "smoke",
    })

    expect(preflight.checks.map((item) => item.name)).not.toContain(
      "onyx evaluation tool"
    )
  })

  test("writes launch manifests after creating parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-manifest-"))
    const manifestPath = join(root, "missing", "worker.manifest.json")

    await writeWorkerLaunchManifest({
      schemaVersion: 1,
      agentKind: "codex",
      workerModel: null,
      command: "codex",
      args: ["exec"],
      onyxWorkerPath: null,
      workerContextPath: null,
      addedWritableRoots: [],
      cwd: root,
      promptPath: join(root, "prompt.md"),
      logPath: join(root, "worker.log"),
      activityLogPath: join(root, "worker.activity.log"),
      activityJsonlPath: join(root, "worker.activity.jsonl"),
      latestStatePath: join(root, "worker.latest.json"),
      manifestPath,
      sessionId: "session",
      hypothesisId: "hypothesis",
      hypothesisName: "hypothesis-one",
      workerId: "worker",
      workerName: "hypothesis-one-codex",
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

  test("creates isolated worker runtime context and environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-runtime-"))
    await runProcess("git", ["init"], { cwd: root })
    const paths = await workerRuntimePaths({
      root,
      sessionId: "session/one",
      workerId: "worker/one",
    })

    await writeWorkerRuntimeContext({
      paths,
      context: {
        schemaVersion: 1,
        campaignId: "campaign-id",
        campaignName: "campaign",
        sessionId: "session/one",
        hypothesisId: "hypothesis-id",
        hypothesisName: "hypothesis",
        workerId: "worker/one",
        workerLeaseToken: "lease-token",
        workerBranch: "onyx/session/worker",
        worktreeRoot: join(root, "worktree"),
        projectPath: "",
        projectRoot: join(root, "worktree"),
        setupFile: join(root, "worktree", "onyx", "setup.json"),
        validationFile: join(root, "worktree", "onyx", "validation.json"),
        researchSpecFile: join(root, "worktree", "onyx", "onyx.md"),
      },
    })

    const wrapper = {
      binDir: paths.binDir,
      workerPath: join(paths.binDir, "onyx-worker"),
      mode: "source" as const,
      target: join(root, "bin", "onyx-worker.js"),
    }
    const env = workerRuntimeEnvironment({
      baseEnv: { PATH: "/usr/bin" },
      wrapper,
      paths,
    })

    expect(await readFile(paths.contextPath, "utf8")).toContain(
      '"campaignName": "campaign"'
    )
    expect(env.PATH).toBe(`${paths.binDir}${delimiter}/usr/bin`)
    expect(env.ONYX_WORKER_CONTEXT).toBe(paths.contextPath)
    expect(env.ONYX_HOME).toBe(paths.homeDir)
    expect(env.TMPDIR).toBe(paths.tempDir)
  })

  test("dev-mode worker wrapper dispatches through linked checkout with bypass", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-shim-root-"))
    const configHome = await mkdtemp(join(tmpdir(), "onyx-worker-shim-config-"))
    const checkout = await mkdtemp(join(tmpdir(), "onyx-worker-shim-checkout-"))
    await runProcess("git", ["init"], { cwd: root })
    await mkdir(join(checkout, "bin"), { recursive: true })
    await mkdir(join(checkout, "skills", "onyx"), { recursive: true })
    const binPath = join(checkout, "bin", "onyx.js")
    const workerBinPath = join(checkout, "bin", "onyx-worker.js")
    await writeFile(
      workerBinPath,
      [
        "#!/usr/bin/env bun",
        'if (process.env.ONYX_LAUNCHER_BYPASS !== "1") process.exit(42)',
        'if (process.argv.includes("--help")) {',
        '  console.log("onyx-worker research session-state-brief")',
        '  console.log("onyx-worker knowledge add")',
        '  console.log("onyx-worker summary upsert")',
        '  console.log("onyx-worker exp run [--campaign")',
        "  process.exit(0)",
        "}",
        'console.log("linked checkout")',
        "",
      ].join("\n"),
      "utf8"
    )
    await writeFile(binPath, "#!/usr/bin/env bun\n", "utf8")
    await chmod(binPath, 0o755)
    await chmod(workerBinPath, 0o755)

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
            workerBinPath,
            skillPath: join(checkout, "skills", "onyx", "SKILL.md"),
          },
        },
      })

      const paths = await workerRuntimePaths({
        root,
        sessionId: "session",
        workerId: "worker",
      })
      const wrapper = await writeWorkerCliWrapper({ paths })
      expect(wrapper.mode).toBe("dev")
      expect(wrapper.target).toBe(workerBinPath)
      const help = await runProcess(wrapper.workerPath, ["--help"], {
        timeoutMs: 5000,
      })
      expect(help.code).toBe(0)
      expect(help.stdout).toContain("onyx-worker research session-state-brief")
      expect(help.stdout).not.toContain("onyx-worker research should-stop")
      expect(help.stdout).toContain("onyx-worker summary upsert")
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome
      }
    }
  })

  test("worker wrapper falls back to the source checkout when PATH has no onyx-worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-source-shim-"))
    const configHome = await mkdtemp(
      join(tmpdir(), "onyx-worker-source-config-")
    )
    await runProcess("git", ["init"], { cwd: root })
    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousPath = process.env.PATH
    process.env.XDG_CONFIG_HOME = configHome
    process.env.PATH = "/usr/bin:/bin"

    try {
      await writeConfig({
        currentProfile: "",
        profiles: {},
        developer: { mode: "release" },
      })

      const paths = await workerRuntimePaths({
        root,
        sessionId: "session",
        workerId: "worker",
      })
      const wrapper = await writeWorkerCliWrapper({ paths })
      expect(wrapper.mode).toBe("source")
      expect(wrapper.target).toContain("/bin/onyx-worker.js")

      if (previousPath !== undefined) process.env.PATH = previousPath
      const help = await runProcess(wrapper.workerPath, ["--help"], {
        timeoutMs: 5000,
      })
      expect(help.code).toBe(0)
      expect(help.stdout).toContain("onyx-worker research brief")
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome
      }
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
    }
  })

  test("worker wrapper prefers the source checkout over an installed onyx-worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-source-first-"))
    const configHome = await mkdtemp(
      join(tmpdir(), "onyx-worker-source-first-config-")
    )
    const bin = join(root, "bin")
    await mkdir(bin)
    await writeFakeOnyx(join(bin, "onyx-worker"))
    await runProcess("git", ["init"], { cwd: root })
    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousPath = process.env.PATH
    process.env.XDG_CONFIG_HOME = configHome
    process.env.PATH = [bin, previousPath ?? ""].filter(Boolean).join(delimiter)

    try {
      await writeConfig({
        currentProfile: "",
        profiles: {},
        developer: { mode: "release" },
      })

      const paths = await workerRuntimePaths({
        root,
        sessionId: "session",
        workerId: "worker",
      })
      const wrapper = await writeWorkerCliWrapper({ paths })
      expect(wrapper.mode).toBe("source")
      expect(wrapper.target).toContain("/bin/onyx-worker.js")

      const help = await runProcess(wrapper.workerPath, ["--help"], {
        timeoutMs: 5000,
      })
      expect(help.code).toBe(0)
      expect(help.stdout).toContain("onyx-worker research brief")
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome
      }
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
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

  test("cancellation terminates workers after grace and writes activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-cancel-"))
    const activityLogPath = join(root, "worker.activity.log")
    const result = await runStreamingProcess(
      "sh",
      ["-c", "trap '' TERM; echo ready; sleep 5"],
      {
        logPath: join(root, "worker.log"),
        activityLogPath,
        timeoutMs: 5000,
        startupTimeoutMs: 1000,
        killGraceMs: 50,
        cancel: {
          pollMs: 10,
          graceMs: 50,
          shouldCancel: () => true,
        },
      }
    )

    expect(result.cancelled).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(await readFile(activityLogPath, "utf8")).toContain("stop requested")
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
