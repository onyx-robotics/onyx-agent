import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { git } from "./git"
import { runProcess } from "./process"
import {
  bwrapArguments,
  resolveSandboxPolicy,
  sandboxCommand,
  seatbeltProfile,
  type ResolvedSandboxPolicy,
} from "./sandbox"
import { defaultSandboxConfig, type SandboxConfig } from "./sandbox-config"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function commandAvailable(command: string, args: string[]) {
  const result = await runProcess(command, args, { timeoutMs: 5_000 }).catch(
    () => null
  )
  return result?.code === 0
}

const bwrapWorks =
  process.platform === "linux" &&
  (await commandAvailable("bwrap", [
    "--ro-bind",
    "/",
    "/",
    "--unshare-pid",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "true",
  ]))
const landlockWorks =
  bwrapWorks &&
  (await commandAvailable("setpriv", [
    "--landlock-access",
    "fs:execute",
    "--landlock-rule",
    "path-beneath:execute:/",
    "--",
    "true",
  ]))
const seatbeltWorks =
  process.platform === "darwin" &&
  (await commandAvailable("/usr/bin/sandbox-exec", [
    "-p",
    "(version 1)(allow default)",
    "/usr/bin/true",
  ]))

/** A repository laid out the way the supervisor lays out a worker. */
async function workerFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "onyx-sandbox-")))
  roots.push(base)
  const root = join(base, "repo")
  const home = join(base, "home")
  await mkdir(join(root, "src"), { recursive: true })
  await mkdir(join(root, "onyx", "tools"), { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(join(home, "secret.txt"), "home-secret\n")
  await git(["init", "-q"], root)
  await writeFile(join(root, "src", "a.txt"), "base\n")
  await writeFile(join(root, "notes.txt"), "notes\n")
  await writeFile(join(root, "README.md"), "main checkout\n")
  await writeFile(join(root, "onyx", "setup.json"), "{}\n")
  await writeFile(
    join(root, "onyx", "tools", "run.sh"),
    "#!/bin/sh\necho tool-ran\n"
  )
  await chmod(join(root, "onyx", "tools", "run.sh"), 0o755)
  await git(["add", "."], root)
  await git(
    ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "base"],
    root
  )
  const common = join(root, ".git")
  const worktree = join(common, "onyx", "worktrees", "session", "worker")
  await mkdir(join(common, "onyx", "worktrees", "session"), { recursive: true })
  await git(["worktree", "add", "-q", "--detach", worktree, "HEAD"], root)
  const tempDir = join(common, "onyx", "worker-runtime", "session", "worker", "tmp")
  await mkdir(tempDir, { recursive: true })
  await writeFile(join(common, "onyx", "state.json"), "supervisor-state\n")
  await writeFile(
    join(common, "onyx", "worker-runtime", "session", "worker", "context.json"),
    "worker-credential\n"
  )
  const gitDir = await git(["rev-parse", "--absolute-git-dir"], worktree)
  return { base, root, home, common, worktree, tempDir, gitDir }
}

async function policyFor(
  fixture: Awaited<ReturnType<typeof workerFixture>>,
  config: Partial<SandboxConfig> = {}
) {
  return resolveSandboxPolicy({
    config: { ...defaultSandboxConfig(), ...config },
    role: "agent",
    env: { HOME: fixture.home, PATH: process.env.PATH },
    worktreeRoot: fixture.worktree,
    projectRoot: fixture.worktree,
    gitDir: fixture.gitDir,
    gitCommonDir: fixture.common,
    tempDir: fixture.tempDir,
    protectedPaths: ["onyx/setup.json", "onyx/tools"],
    editablePaths: ["src"],
  })
}

async function runConfined(
  policy: ResolvedSandboxPolicy,
  cwd: string,
  script: string,
  home: string
) {
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: policy.tempDir }
  const wrapped = await sandboxCommand(
    policy,
    { command: "/bin/sh", args: ["-c", script], cwd },
    env
  )
  const result = await runProcess(wrapped.command, wrapped.args, {
    cwd,
    env,
    timeoutMs: 20_000,
  })
  return `${result.stdout}\n${result.stderr}`
}

function escapeScript(
  fixture: Awaited<ReturnType<typeof workerFixture>>
) {
  return [
    "echo change > src/a.txt",
    "git add src/a.txt",
    "git -c user.email=t@e -c user.name=t commit -q -m change && echo COMMIT_OK",
    `cat ${fixture.home}/secret.txt 2>/dev/null || echo NO_HOME_SECRET`,
    `cat ${fixture.root}/README.md 2>/dev/null || echo NO_MAIN_CHECKOUT`,
    `cat ${fixture.common}/onyx/state.json 2>/dev/null || echo NO_SUPERVISOR_STATE`,
    `cat ${fixture.common}/onyx/worker-runtime/session/worker/context.json 2>/dev/null || echo NO_WORKER_CREDENTIAL`,
    "(echo x > onyx/setup.json) 2>/dev/null || echo NO_PROTECTED_WRITE",
    `(echo x >> ${fixture.common}/config) 2>/dev/null || echo NO_GIT_CONFIG_WRITE`,
    `(echo x > ${fixture.common}/hooks/pre-push) 2>/dev/null || echo NO_HOOK_WRITE`,
    "(echo 'gitdir: /tmp/evil' > .git) 2>/dev/null || echo NO_GITFILE_WRITE",
    `(echo x > ${fixture.gitDir}/commondir) 2>/dev/null || echo NO_COMMONDIR_WRITE`,
    "(echo x > $TMPDIR/scratch) 2>/dev/null && echo TMP_OK",
  ].join("\n")
}

const CONFINED_MARKERS = [
  "COMMIT_OK",
  "NO_HOME_SECRET",
  "NO_MAIN_CHECKOUT",
  "NO_SUPERVISOR_STATE",
  "NO_WORKER_CREDENTIAL",
  "NO_PROTECTED_WRITE",
  "NO_GIT_CONFIG_WRITE",
  "NO_HOOK_WRITE",
  "NO_GITFILE_WRITE",
  "NO_COMMONDIR_WRITE",
]

describe("resolveSandboxPolicy", () => {
  test("confines writes to the worktree and hides supervisor state", async () => {
    const fixture = await workerFixture()
    const policy = await policyFor(fixture)
    expect(policy.readWrite).toContain(fixture.worktree)
    expect(policy.readWrite).toContain(join(fixture.common, "objects"))
    expect(policy.readWrite).not.toContain(join(fixture.common, "refs"))
    expect(policy.readWrite).not.toContain(fixture.home)
    expect(policy.hidden).toEqual([join(fixture.common, "onyx")])
    expect(policy.protectedPaths).toEqual(
      expect.arrayContaining([
        join(fixture.worktree, "onyx", "setup.json"),
        join(fixture.worktree, ".git"),
        join(fixture.common, "config"),
        join(fixture.common, "hooks"),
        join(fixture.gitDir, "commondir"),
      ])
    )
    expect(policy.exec).toBeNull()
  })

  test("editable mode only opens scope.editable inside the worktree", async () => {
    const fixture = await workerFixture()
    const policy = await policyFor(fixture, { worktreeWrites: "editable" })
    expect(policy.readWrite).toContain(join(fixture.worktree, "src"))
    expect(policy.readWrite).not.toContain(fixture.worktree)
    expect(policy.readOnly).toContain(fixture.worktree)
  })

  test("expands home-relative and project-relative config paths", async () => {
    const fixture = await workerFixture()
    await mkdir(join(fixture.home, ".cargo"), { recursive: true })
    const policy = await policyFor(fixture, {
      read: ["~/.cargo", "notes.txt", "/does/not/exist"],
    })
    expect(policy.readOnly).toContain(join(fixture.home, ".cargo"))
    expect(policy.readOnly).toContain(join(fixture.worktree, "notes.txt"))
    expect(policy.readOnly).not.toContain("/does/not/exist")
  })

  test("bwrap mounts apply shallowest first and drop redundant binds", async () => {
    const fixture = await workerFixture()
    const policy = await policyFor(fixture)
    const { args } = await bwrapArguments(policy, { cwd: fixture.worktree })
    const index = (flag: string, path: string) =>
      args.findIndex((arg, i) => arg === flag && args[i + 1] === path)
    expect(index("--tmpfs", fixture.home)).toBeGreaterThan(-1)
    expect(index("--tmpfs", join(fixture.common, "onyx"))).toBeGreaterThan(
      index("--ro-bind-try", fixture.common)
    )
    expect(index("--bind-try", fixture.worktree)).toBeGreaterThan(
      index("--tmpfs", join(fixture.common, "onyx"))
    )
    expect(
      index("--ro-bind-try", join(fixture.worktree, "onyx", "setup.json"))
    ).toBeGreaterThan(index("--bind-try", fixture.worktree))
    // Already read-only beneath the common git dir bind.
    expect(index("--ro-bind-try", join(fixture.common, "hooks"))).toBe(-1)
    expect(args).toContain("--unshare-pid")
  })
})

describe("seatbeltProfile", () => {
  test("denies by default and carves protected and hidden paths out of allows", async () => {
    const fixture = await workerFixture()
    const policy = {
      ...(await policyFor(fixture)),
      platform: "darwin" as const,
      brokerSocket: "/private/tmp/onyx-broker-x/s",
    }
    const profile = seatbeltProfile(policy)
    expect(profile).toStartWith("(version 1)\n(deny default)\n")
    expect(profile).toContain(
      `(allow file-write* (require-all (subpath "${fixture.worktree}") (require-not (subpath "${join(fixture.worktree, ".git")}"))`
    )
    expect(profile).toContain(
      `(allow file-read* (require-all (subpath "${fixture.common}") (require-not (subpath "${join(fixture.common, "onyx")}"))))`
    )
    expect(profile).toContain(
      '(remote unix-socket (path-literal "/private/tmp/onyx-broker-x/s"))'
    )
    expect(profile).not.toContain(`(subpath "${fixture.home}")`)
  })

  test("escapes quotes and backslashes in paths", () => {
    const profile = seatbeltProfile({
      schemaVersion: 1,
      platform: "darwin",
      role: "tool",
      home: "/Users/u",
      readOnly: ['/Users/u/we"ird\\dir'],
      readWrite: [],
      protectedPaths: [],
      hidden: [],
      devices: [],
      exec: null,
      tempDir: "/tmp",
      brokerSocket: null,
    })
    expect(profile).toContain('(subpath "/Users/u/we\\"ird\\\\dir")')
  })
})

describe.skipIf(!bwrapWorks)("bubblewrap enforcement", () => {
  test("a worker can commit in its worktree but cannot escape it", async () => {
    const fixture = await workerFixture()
    const policy = await policyFor(fixture)
    const output = await runConfined(
      policy,
      fixture.worktree,
      escapeScript(fixture),
      fixture.home
    )
    for (const marker of [...CONFINED_MARKERS, "TMP_OK"]) {
      expect(output).toContain(marker)
    }
    expect(output).not.toContain("home-secret")
    expect(output).not.toContain("worker-credential")
    expect(await git(["log", "-1", "--format=%s"], fixture.worktree)).toBe(
      "change"
    )
    expect(await readFile(join(fixture.worktree, "onyx", "setup.json"), "utf8")).toBe(
      "{}\n"
    )
  }, 30_000)

  test("editable mode rejects writes outside scope.editable", async () => {
    const fixture = await workerFixture()
    const policy = await policyFor(fixture, { worktreeWrites: "editable" })
    const output = await runConfined(
      policy,
      fixture.worktree,
      [
        "(echo ok > src/a.txt) && echo EDITABLE_OK",
        "(echo x > notes.txt) 2>/dev/null || echo OUT_OF_SCOPE_DENIED",
        "cat notes.txt",
      ].join("\n"),
      fixture.home
    )
    expect(output).toContain("EDITABLE_OK")
    expect(output).toContain("OUT_OF_SCOPE_DENIED")
    expect(output).toContain("notes")
  }, 30_000)

  test.skipIf(!landlockWorks)(
    "exec rules block running unlisted files but not interpreters reading them",
    async () => {
      const fixture = await workerFixture()
      const script = join(fixture.worktree, "src", "tool.sh")
      await writeFile(script, "#!/bin/sh\necho script-ran\n")
      await chmod(script, 0o755)
      const run = [
        "./src/tool.sh 2>/dev/null || echo EXEC_DENIED",
        "sh ./src/tool.sh",
        "./onyx/tools/run.sh",
      ].join("\n")
      const denied = await runConfined(
        await policyFor(fixture, { exec: [] }),
        fixture.worktree,
        run,
        fixture.home
      )
      expect(denied).toContain("EXEC_DENIED")
      // Documented limit: an allowed interpreter may still read the file.
      expect(denied).toContain("script-ran")
      expect(denied).toContain("tool-ran")
      const allowed = await runConfined(
        await policyFor(fixture, { exec: ["src"] }),
        fixture.worktree,
        "./src/tool.sh",
        fixture.home
      )
      expect(allowed).toContain("script-ran")
    },
    30_000
  )
})

describe.skipIf(!seatbeltWorks)("Seatbelt enforcement", () => {
  test("a worker can commit in its worktree but cannot escape it", async () => {
    const fixture = await workerFixture()
    const policy = await policyFor(fixture)
    const output = await runConfined(
      policy,
      fixture.worktree,
      escapeScript(fixture),
      fixture.home
    )
    for (const marker of CONFINED_MARKERS) expect(output).toContain(marker)
    expect(output).not.toContain("home-secret")
    expect(await git(["log", "-1", "--format=%s"], fixture.worktree)).toBe(
      "change"
    )
  }, 30_000)
})
