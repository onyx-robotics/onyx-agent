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
import { ONYX_WORKER_CONTEXT_SCHEMA_VERSION } from "./lib/version"
import {
  runProcess,
  runStreamingProcess,
  StreamingSecretRedactor,
} from "./lib/process"
import {
  buildWorkerInvocation,
  preflightProviderModel,
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
      'if [[ "${1:-}" == "diagnostics" && "${2:-}" == "handshake" ]]; then',
      '  echo "{\\"protocolVersion\\":5,\\"workerContextSchemas\\":[6],\\"capabilities\\":[]}"',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "research" && "${2:-}" == "session-state-brief" ]]; then',
      '  echo "{\\"schemaVersion\\":1,\\"worker\\":{\\"id\\":null,\\"sessionId\\":null,\\"assignment\\":{\\"id\\":null}}}"',
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
      '  echo "onyx research session-state-brief"',
      '  echo "onyx knowledge add"',
      '  echo "onyx knowledge list"',
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
  test("redacts secrets split across provider output chunks", async () => {
    const secret = "owx_worker_v1_abcdefghijklmnopqrstuvwxyz123456"
    const redactor = new StreamingSecretRedactor([secret])
    const direct =
      redactor.push("before owx_worker_v1_abcdefgh") +
      redactor.push("ijklmnopqrstuvwxyz123456 after") +
      redactor.flush()
    expect(direct).not.toContain(secret)
    expect(direct).toContain("[REDACTED]")

    const root = await mkdtemp(join(tmpdir(), "onyx-redaction-"))
    const logPath = join(root, "worker.log")
    const activityLogPath = join(root, "worker.activity.log")
    const result = await runStreamingProcess(
      "sh",
      [
        "-c",
        'printf "before owx_worker_v1_abcdefgh"; sleep 0.05; printf "ijklmnopqrstuvwxyz123456 after\\n"; printf "owx_worker_v1_abcdefgh" >&2; sleep 0.05; printf "ijklmnopqrstuvwxyz123456\\n" >&2',
      ],
      { logPath, activityLogPath, redactValues: [secret] }
    )
    const retained = [
      result.stdout,
      result.stderr,
      await readFile(logPath, "utf8"),
      await readFile(activityLogPath, "utf8"),
    ].join("\n")
    expect(retained).not.toContain(secret)
    expect(retained).toContain("[REDACTED]")
  })

  test("builds direct Codex, Claude, and OpenCode invocations", () => {
    const prompt = "SECRET_PROMPT"
    const addedWritableRoots = ["/tmp/worktree/.git", "/tmp/repo/.git"]
    const codex = buildWorkerInvocation({
      agentKind: "codex",
      worktree: "/tmp/worktree",
      launchDir: "/tmp/worktree/apps/ml",
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
      launchDir: "/tmp/worktree/apps/ml",
      prompt,
      workerModel: "openrouter/qwen/qwen3-coder",
      workerTitle: "worker_123",
    })

    expect(codex.command).toBe("codex")
    expect(codex.args).toEqual([
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--config",
      "sandbox_workspace_write.network_access=true",
      "--sandbox",
      "workspace-write",
      "--model",
      "gpt-5-codex",
      "--cd",
      "/tmp/worktree/apps/ml",
      "--add-dir",
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
      "/tmp/worktree/apps/ml",
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

  test("model preflight invokes the resolved executable despite a hostile PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-exact-provider-"))
    const hostileBin = join(root, "hostile")
    const trustedBin = join(root, "trusted")
    await mkdir(hostileBin)
    await mkdir(trustedBin)
    const hostileMarker = join(root, "hostile-ran")
    await writeFile(
      join(hostileBin, "codex"),
      `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(hostileMarker)}\nexit 19\n`,
      "utf8"
    )
    await chmod(join(hostileBin, "codex"), 0o755)
    const trusted = join(trustedBin, "codex")
    await writeFile(
      trusted,
      [
        "#!/bin/sh",
        'if [ "${1:-}" = "--version" ]; then echo "codex trusted 1.0"; exit 0; fi',
        "prompt=$(/bin/cat)",
        "marker=${prompt##*: }",
        `printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$marker"`,
        "",
      ].join("\n"),
      "utf8"
    )
    await chmod(trusted, 0o755)
    const invocation = buildWorkerInvocation({
      agentKind: "codex",
      providerExecutable: trusted,
      worktree: root,
      prompt: "worker prompt",
    })
    const result = await preflightProviderModel({
      invocation,
      cwd: root,
      env: { ...process.env, PATH: hostileBin },
    })

    expect(result.skipped).toBe(false)
    expect(result.version).toContain("codex trusted 1.0")
    await expect(readFile(hostileMarker, "utf8")).rejects.toThrow()
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
      HOME: root,
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
      onyxWorkerPath: join(bin, "onyx-worker"),
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
    expect(activity).toContain("[stdout] thought: hello from opencode")
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

  test("rotates raw provider logs within the per-worker byte cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-log-cap-"))
    const logPath = join(root, "worker.log")
    const result = await runStreamingProcess(
      "sh",
      ["-c", "printf '%01000d' 0"],
      {
        logPath,
        timeoutMs: 5000,
        startupTimeoutMs: 1000,
        killGraceMs: 100,
        logLimitBytes: 512,
      }
    )

    expect(result.code).toBe(0)
    const first = await readFile(logPath)
    const second = await readFile(`${logPath}.1`)
    expect(first.byteLength).toBeLessThanOrEqual(256)
    expect(second.byteLength).toBeLessThanOrEqual(256)
    expect(first.byteLength + second.byteLength).toBe(512)
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
      HOME: root,
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
      onyxWorkerPath: join(bin, "onyx-worker"),
    })

    expect(preflight.version).toContain("claude fake 2.0")
  })

  test("preflight fails when a stale onyx-worker shadows the wrapper in login shells", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-shadowed-"))
    const bin = join(root, "bin")
    const staleBin = join(root, "stale-bin")
    const worktree = join(root, "worktree")
    await mkdir(bin)
    await mkdir(staleBin)
    await mkdir(worktree)
    await runProcess("git", ["init"], { cwd: worktree })
    await writeFakeAgent(join(bin, "codex"), "codex fake 1.0")
    await writeFakeOnyx(join(bin, "onyx-worker"))
    // A stale install answering an old worker-context schema, resolved ahead
    // of the wrapper the way a profile-prepended ~/.local/bin would be.
    await writeFile(
      join(staleBin, "onyx-worker"),
      [
        "#!/usr/bin/env bash",
        'echo "{\\"protocolVersion\\":5,\\"workerContextSchemas\\":[5],\\"capabilities\\":[]}"',
        "",
      ].join("\n"),
      "utf8"
    )
    await chmod(join(staleBin, "onyx-worker"), 0o755)

    const invocation = buildWorkerInvocation({
      agentKind: "codex",
      worktree,
      prompt: "do useful work",
    })
    await expect(
      preflightWorkerInvocation(invocation, {
        cwd: worktree,
        env: {
          ...process.env,
          HOME: root,
          PATH: `${staleBin}:${bin}:${process.env.PATH ?? ""}`,
          FAKE_ARGS_FILE: join(root, "args.txt"),
          FAKE_CWD_FILE: join(root, "cwd.txt"),
          FAKE_STDIN_FILE: join(root, "stdin.txt"),
        },
        onyxWorkerPath: join(bin, "onyx-worker"),
      })
    ).rejects.toThrow("onyx-worker PATH resolution")
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
        onyxWorkerPath: join(bin, "onyx-worker"),
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
        HOME: root,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      campaignName: "smoke",
      onyxWorkerPath: join(bin, "onyx-worker"),
    })

    expect(preflight.checks.map((item) => item.name)).not.toContain(
      "onyx evaluation tool"
    )
  })

  test("writes launch manifests after creating parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "onyx-worker-manifest-"))
    const manifestPath = join(root, "missing", "worker.manifest.json")

    await writeWorkerLaunchManifest({
      schemaVersion: 2,
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
      startingCommitSha: "base-commit",
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
      teardown: null,
    })

    expect(await readFile(manifestPath, "utf8")).toContain('"schemaVersion": 2')
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
        schemaVersion: ONYX_WORKER_CONTEXT_SCHEMA_VERSION,
        campaignId: "campaign-id",
        campaignName: "campaign",
        sessionId: "session/one",
        assignmentId: "assignment-id",
        startingCommitSha: "abc123",
        hypothesisId: "hypothesis-id",
        hypothesisName: "hypothesis",
        assignment: {
          id: "assignment-id",
          startingCommitSha: "abc123",
          sourceExperimentId: null,
        },
        hypothesis: {
          id: "hypothesis-id",
          name: "hypothesis",
          description: null,
          status: "active",
          plan: {
            focus: "Test worker isolation",
            statement: "The worker receives immutable hypothesis guidance.",
            startingPoints: [],
            avoidList: [],
            successSignals: [],
            giveUpSignals: [],
          },
          bestMetricValue: null,
          bestCommitSha: null,
          experimentCount: 0,
          lastWorkedAt: null,
        },
        workerId: "worker/one",
        workerCredential: "owx_worker_v1_test-credential-0000000000000000",
        workerCliPath: null,
        worktreeRoot: join(root, "worktree"),
        projectPath: "",
        projectRoot: join(root, "worktree"),
        setupFile: join(root, "worktree", "onyx", "setup.json"),
        validationFile: join(root, "worktree", "onyx", "validation.json"),
        researchSpecFile: join(root, "worktree", "onyx", "onyx.md"),
        researchDeadlineAt: null,
        shutdownDeadlineAt: null,
        shutdownCushionSeconds: null,
      },
    })

    const wrapper = {
      binDir: paths.binDir,
      workerPath: join(paths.binDir, "onyx-worker"),
      mode: "source" as const,
      target: join(root, "bin", "onyx-worker.js"),
    }
    const env = workerRuntimeEnvironment({
      baseEnv: {
        PATH: "/usr/bin",
        ONYX_API_KEY: "must-not-be-inherited",
        UNRELATED_SECRET: "must-not-be-inherited",
      },
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
    expect(env).not.toHaveProperty("ONYX_API_KEY")
    expect(env).not.toHaveProperty("UNRELATED_SECRET")
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
      expect(help.stdout).not.toContain("onyx-worker summary")
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
