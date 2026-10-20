import { lstat, readlink, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path"

import type { SandboxConfig } from "./sandbox-config"
import { runProcess } from "./process"

export type SandboxRole = "agent" | "tool"
export type SandboxPlatform = "linux" | "darwin"

/**
 * Fully resolved, platform-neutral confinement rules for one worker. Every
 * path is absolute and canonical. The supervisor resolves it once per worker
 * and persists the tool-role copy for the out-of-sandbox `onyx-worker`.
 */
export type ResolvedSandboxPolicy = {
  schemaVersion: 1
  platform: SandboxPlatform
  role: SandboxRole
  home: string
  readOnly: string[]
  readWrite: string[]
  /** Always read-only, even inside a writable tree. */
  protectedPaths: string[]
  /** Never visible, even inside a readable tree (paths re-exposed beneath
   * them, such as the worker's own worktree, stay visible). */
  hidden: string[]
  devices: string[]
  /** null: anything readable may be executed. */
  exec: string[] | null
  tempDir: string
  brokerSocket: string | null
}

export type SandboxPolicyInput = {
  config: SandboxConfig
  role: SandboxRole
  platform?: NodeJS.Platform
  env: NodeJS.ProcessEnv
  worktreeRoot: string
  projectRoot: string
  gitDir: string
  gitCommonDir: string
  tempDir: string
  binDir?: string | null
  brokerSocket?: string | null
  /** Project-relative protected paths (setup surface + scope.protected). */
  protectedPaths: string[]
  /** Project-relative scope.editable entries. */
  editablePaths: string[]
  agentKind?: string | null
  providerExecutable?: string | null
  /** Paths the in-sandbox `onyx-worker` broker client needs to start. */
  workerClientPaths?: string[]
}

const LINUX_SYSTEM_READ = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
  "/nix",
  "/sys",
  "/run/systemd/resolve",
  "/run/current-system",
]

const LINUX_SYSTEM_EXEC = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt",
  "/nix",
  "/run/current-system",
]

const DARWIN_SYSTEM_READ = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/private/etc",
  "/private/var/db/timezone",
  "/opt",
  "/Applications/Xcode.app",
]

const DARWIN_SYSTEM_EXEC = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library/Developer",
  "/Applications/Xcode.app",
  "/opt",
]

/** Top-level symlinks whose targets the macOS profile must let callers walk. */
const DARWIN_ROOT_LITERALS = [
  "/",
  "/etc",
  "/var",
  "/tmp",
  "/private",
  "/private/var",
]

function sandboxPlatform(platform: NodeJS.Platform): SandboxPlatform {
  if (platform === "linux" || platform === "darwin") return platform
  throw new Error(
    `Onyx worker sandboxing supports Linux (bubblewrap) and macOS (Seatbelt), not ${platform}.`
  )
}

async function canonical(path: string) {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

function isWithin(path: string, ancestor: string) {
  return (
    path === ancestor ||
    ancestor === sep ||
    path.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`)
  )
}

function isStrictlyWithin(path: string, ancestor: string) {
  return path !== ancestor && isWithin(path, ancestor)
}

function expandConfigPath(value: string, home: string, projectRoot: string) {
  if (value === "~") return home
  if (value.startsWith("~/")) return join(home, value.slice(2))
  if (isAbsolute(value)) return value
  return resolve(projectRoot, value)
}

async function canonicalAll(paths: Array<string | null | undefined>) {
  const resolved = await Promise.all(
    paths.filter((path): path is string => Boolean(path)).map(canonical)
  )
  return [...new Set(resolved.filter((path): path is string => !!path))]
}

/** Directories on PATH, so the provider's and the user's shells resolve
 * commands. Never the filesystem root, the home directory, or its parents. */
async function pathEntries(env: NodeJS.ProcessEnv, home: string) {
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean)
  const dirs = await canonicalAll(entries)
  const result: string[] = []
  for (const dir of dirs) {
    if (dir === sep || isWithin(home, dir)) continue
    result.push(dir)
    // Prefix layouts (nvm, ~/.local, Homebrew) keep libraries beside bin/.
    if (dir.endsWith(`${sep}bin`)) {
      const lib = await canonical(join(dirname(dir), "lib"))
      if (lib && lib !== sep && !isWithin(home, lib)) result.push(lib)
    }
  }
  return result
}

/** The provider's install root: the enclosing node_modules for npm installs
 * (native optional dependencies live beside the package), otherwise the
 * executable's own directory. */
export async function providerInstallDirs(executable: string | null) {
  if (!executable) return []
  const real = await canonical(executable)
  if (!real) return []
  const parts = real.split(sep)
  const nodeModules = parts.lastIndexOf("node_modules")
  if (nodeModules > 0) return [parts.slice(0, nodeModules + 1).join(sep)]
  return [dirname(real)]
}

function providerStateDirs(
  agentKind: string | null | undefined,
  env: NodeJS.ProcessEnv,
  home: string
) {
  const config = env.XDG_CONFIG_HOME ?? join(home, ".config")
  const cache = env.XDG_CACHE_HOME ?? join(home, ".cache")
  if (agentKind === "claude") {
    return [
      env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
      join(home, ".claude.json"),
    ]
  }
  if (agentKind === "codex") return [env.CODEX_HOME ?? join(home, ".codex")]
  if (agentKind === "opencode") {
    return [
      env.OPENCODE_CONFIG_DIR ?? join(config, "opencode"),
      join(home, ".local", "share", "opencode"),
      join(home, ".local", "state", "opencode"),
      join(cache, "opencode"),
    ]
  }
  return []
}

async function darwinUserCacheDir() {
  const result = await runProcess("getconf", ["DARWIN_USER_CACHE_DIR"], {
    timeoutMs: 5_000,
  }).catch(() => null)
  const value = result?.code === 0 ? result.stdout.trim() : ""
  return value || null
}

/** The active Xcode/CLT developer dir. /usr/bin shims (git, clang, make)
 * load libxcrun from it, and runners often install Xcode as Xcode_N.app. */
async function darwinDeveloperRoots(env: NodeJS.ProcessEnv) {
  let dir = env.DEVELOPER_DIR?.trim() || ""
  if (!dir) {
    const result = await runProcess("xcode-select", ["-p"], {
      timeoutMs: 5_000,
    }).catch(() => null)
    dir = result?.code === 0 ? result.stdout.trim() : ""
  }
  if (!dir) return []
  // Allow the whole bundle: the toolchain reaches outside Contents/Developer.
  const app = dir.match(/^(.*?\.app)(\/|$)/)
  return [app ? app[1] : dir]
}

export async function resolveSandboxPolicy(
  input: SandboxPolicyInput
): Promise<ResolvedSandboxPolicy> {
  const platform = sandboxPlatform(input.platform ?? process.platform)
  const home =
    (await canonical(input.env.HOME ?? homedir())) ??
    (input.env.HOME ?? homedir())
  const projectRoot = (await canonical(input.projectRoot)) ?? input.projectRoot
  const worktreeRoot =
    (await canonical(input.worktreeRoot)) ?? input.worktreeRoot
  const commonDir = (await canonical(input.gitCommonDir)) ?? input.gitCommonDir
  const expand = (value: string) =>
    expandConfigPath(value, home, projectRoot)
  const system = platform === "linux" ? LINUX_SYSTEM_READ : DARWIN_SYSTEM_READ
  const systemExec =
    platform === "linux" ? LINUX_SYSTEM_EXEC : DARWIN_SYSTEM_EXEC
  const developerRoots =
    platform === "darwin" ? await darwinDeveloperRoots(input.env) : []
  const providerInstall = await providerInstallDirs(
    input.role === "agent" ? (input.providerExecutable ?? null) : null
  )
  const clientPaths = await canonicalAll(input.workerClientPaths ?? [])
  const binDir = input.binDir ? await canonicalAll([input.binDir]) : []
  const projectTools = await canonicalAll([join(projectRoot, "onyx", "tools")])
  const userExec =
    input.config.exec === null
      ? null
      : await canonicalAll(input.config.exec.map(expand))

  const readOnly = await canonicalAll([
    ...(platform === "linux" ? system : []),
    // Often a symlink into /run (systemd-resolved, NetworkManager, resolvconf).
    ...(platform === "linux" ? ["/etc/resolv.conf"] : []),
    ...(await pathEntries(input.env, home)),
    ...developerRoots,
    join(home, ".gitconfig"),
    join(input.env.XDG_CONFIG_HOME ?? join(home, ".config"), "git"),
    input.env.GIT_CONFIG_GLOBAL,
    input.env.SSL_CERT_FILE,
    input.env.SSL_CERT_DIR,
    input.env.NODE_EXTRA_CA_CERTS,
    commonDir,
    ...providerInstall,
    ...clientPaths,
    ...binDir,
    ...input.config.read.map(expand),
    ...(userExec ?? []),
  ])

  const worktreeWritable =
    input.config.worktreeWrites === "all"
      ? [worktreeRoot]
      : input.editablePaths.map((path) => join(projectRoot, path))
  const readWrite = await canonicalAll([
    ...worktreeWritable,
    // A detached worktree commit only needs its own admin dir and objects.
    input.gitDir,
    join(commonDir, "objects"),
    input.tempDir,
    ...(input.role === "agent"
      ? providerStateDirs(input.agentKind, input.env, home)
      : []),
    ...(platform === "darwin" ? [await darwinUserCacheDir()] : []),
    ...input.config.write.map(expand),
  ])
  if (input.config.worktreeWrites === "editable") {
    // The rest of the worktree stays readable.
    readOnly.push(worktreeRoot)
  }

  // Git files that decide which repository and config the supervisor's own
  // git commands load in this worktree: rewriting any of them could point
  // supervisor-side git at worker-authored config (filters, diff drivers).
  const protectedPaths = await canonicalAll([
    ...input.protectedPaths.map((path) => join(projectRoot, path)),
    join(projectRoot, "onyx", "sandbox.json"),
    join(worktreeRoot, ".git"),
    join(commonDir, "config"),
    join(commonDir, "hooks"),
    join(input.gitDir, "commondir"),
    join(input.gitDir, "gitdir"),
    join(input.gitDir, "config.worktree"),
  ])

  const hidden = await canonicalAll([join(commonDir, "onyx")])
  const devices = await canonicalAll(input.config.devices.map(expand))
  const exec =
    userExec === null
      ? null
      : await canonicalAll([
          ...systemExec,
          ...developerRoots,
          ...providerInstall,
          ...clientPaths,
          ...binDir,
          ...projectTools,
          ...userExec,
        ])

  return {
    schemaVersion: 1,
    platform,
    role: input.role,
    home,
    readOnly: [...new Set(readOnly)].sort(),
    readWrite: readWrite.sort(),
    protectedPaths: protectedPaths.sort(),
    hidden,
    devices: devices.sort(),
    exec: exec?.sort() ?? null,
    tempDir: (await canonical(input.tempDir)) ?? input.tempDir,
    brokerSocket: input.brokerSocket ?? null,
  }
}

type MountKind = "ro" | "rw" | "dev" | "hidden" | "protected"
const MOUNT_PRECEDENCE: Record<MountKind, number> = {
  ro: 1,
  rw: 2,
  dev: 3,
  hidden: 4,
  protected: 5,
}

function pathDepth(path: string) {
  return path.split(sep).filter(Boolean).length
}

/**
 * bubblewrap mount program. Only mounted paths exist: the root is an empty
 * tmpfs, so anything not listed (the home directory, the main checkout,
 * other workers' worktrees, `.git/onyx` state) is invisible. Mounts apply
 * shallowest first so protected and hidden paths overlay their parents.
 */
export async function bwrapArguments(
  policy: ResolvedSandboxPolicy,
  options: { cwd: string; setprivPath?: string | null }
) {
  const args: string[] = ["--unshare-pid", "--unshare-ipc"]
  const mounts = new Map<string, MountKind | "scratch">()
  const add = (path: string, kind: MountKind) => {
    const existing = mounts.get(path)
    if (
      !existing ||
      existing === "scratch" ||
      MOUNT_PRECEDENCE[kind] > MOUNT_PRECEDENCE[existing]
    ) {
      mounts.set(path, kind)
    }
  }
  const systemSymlinks: string[] = []
  for (const path of LINUX_SYSTEM_READ) {
    const stat = await lstat(path).catch(() => null)
    if (!stat) continue
    if (stat.isSymbolicLink()) {
      systemSymlinks.push("--symlink", await readlink(path), path)
    } else {
      add(path, "ro")
    }
  }
  for (const path of ["/tmp", "/var/tmp", policy.home]) {
    if (path !== sep && !mounts.has(path)) mounts.set(path, "scratch")
  }
  for (const path of policy.readOnly) add(path, "ro")
  for (const path of policy.readWrite) add(path, "rw")
  for (const path of policy.devices) add(path, "dev")
  for (const path of policy.hidden) add(path, "hidden")
  for (const path of policy.protectedPaths) add(path, "protected")

  const sorted = [...mounts.entries()]
    .map(([path, kind]) => ({ path, kind }))
    .sort(
      (left, right) =>
        pathDepth(left.path) - pathDepth(right.path) ||
        left.path.localeCompare(right.path)
    )
  const effect = (kind: MountKind | "scratch") =>
    kind === "protected" ? "ro" : kind === "scratch" ? "hidden" : kind
  // Drop mounts that would not change what their nearest mounted ancestor
  // already provides (e.g. /usr/bin under /usr).
  const ordered: typeof sorted = []
  for (const entry of sorted) {
    const ancestor = ordered
      .filter((kept) => isStrictlyWithin(entry.path, kept.path))
      .sort((left, right) => right.path.length - left.path.length)[0]
    // Scratch tmpfs mounts always apply so $HOME and /tmp exist writable.
    if (
      ancestor &&
      effect(ancestor.kind) === effect(entry.kind) &&
      entry.kind !== "dev" &&
      entry.kind !== "scratch"
    ) {
      continue
    }
    ordered.push(entry)
  }

  args.push(...systemSymlinks, "--dev", "/dev", "--proc", "/proc")
  for (const { path, kind } of ordered) {
    if (kind === "scratch" || kind === "hidden") args.push("--tmpfs", path)
    else if (kind === "ro" || kind === "protected")
      args.push("--ro-bind-try", path, path)
    else if (kind === "rw") args.push("--bind-try", path, path)
    else args.push("--dev-bind-try", path, path)
  }
  if (policy.brokerSocket) {
    args.push("--bind", policy.brokerSocket, policy.brokerSocket)
  }
  args.push("--chdir", options.cwd)

  const prefix: string[] = []
  if (policy.exec) {
    if (!options.setprivPath) {
      throw new Error(
        "sandbox.json exec rules need util-linux setpriv with Landlock support (2.40 or newer) on PATH."
      )
    }
    prefix.push(options.setprivPath, "--landlock-access", "fs:execute")
    for (const path of policy.exec) {
      prefix.push("--landlock-rule", `path-beneath:execute:${path}`)
    }
    prefix.push("--")
  }
  return { args, prefix }
}

function sbpl(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function subpathFilter(path: string, excluded: string[]) {
  const inside = excluded.filter((other) => isStrictlyWithin(other, path))
  if (inside.length === 0) return `(subpath ${sbpl(path)})`
  return `(require-all (subpath ${sbpl(path)}) ${inside
    .map((other) => `(require-not (subpath ${sbpl(other)}))`)
    .join(" ")})`
}

/**
 * Seatbelt (sandbox-exec) profile. Reads, writes, and process execution are
 * denied unless a rule allows them. Hidden and protected carve-outs are
 * expressed with require-not inside each allow, so correctness never depends
 * on rule ordering.
 */
export function seatbeltProfile(policy: ResolvedSandboxPolicy) {
  const readable = [
    ...DARWIN_SYSTEM_READ,
    ...policy.readOnly,
    ...policy.readWrite,
  ]
  const executable = policy.exec ?? readable
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-sem)",
    "(allow ipc-posix-shm)",
    "(allow iokit-open)",
    "(allow user-preference-read)",
    "(allow pseudo-tty)",
    "(allow file-read-metadata)",
    "(allow file-map-executable)",
    `(allow file-read* ${DARWIN_ROOT_LITERALS.map((path) => `(literal ${sbpl(path)})`).join(" ")})`,
    '(allow file-read* file-write* file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))',
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper"))',
  ]
  for (const path of policy.devices) {
    lines.push(`(allow file-read* file-write* file-ioctl (literal ${sbpl(path)}))`)
  }
  for (const path of readable) {
    lines.push(`(allow file-read* ${subpathFilter(path, policy.hidden)})`)
  }
  for (const path of policy.readWrite) {
    lines.push(
      `(allow file-write* ${subpathFilter(path, [
        ...policy.hidden,
        ...policy.protectedPaths,
      ])})`
    )
  }
  for (const path of executable) {
    lines.push(`(allow process-exec ${subpathFilter(path, policy.hidden)})`)
  }
  lines.push(
    '(allow network-outbound (remote ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
    '(allow network-bind (local ip "*:*"))',
    "(allow system-socket)"
  )
  if (policy.brokerSocket) {
    lines.push(
      `(allow network-outbound (remote unix-socket (path-literal ${sbpl(policy.brokerSocket)})))`,
      `(allow file-read* file-write* (literal ${sbpl(policy.brokerSocket)}))`
    )
  }
  return `${lines.join("\n")}\n`
}

async function commandOnPath(command: string, env: NodeJS.ProcessEnv) {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command)
    const stat = await lstat(candidate).catch(() => null)
    if (stat && !stat.isDirectory()) return (await canonical(candidate)) ?? null
  }
  return null
}

export type SandboxedCommand = { command: string; args: string[] }

/** Rewrites one command so it runs confined by `policy`. */
export async function sandboxCommand(
  policy: ResolvedSandboxPolicy,
  invocation: { command: string; args: string[]; cwd: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<SandboxedCommand> {
  if (policy.platform === "darwin") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", seatbeltProfile(policy), invocation.command, ...invocation.args],
    }
  }
  const bwrap = await commandOnPath("bwrap", env)
  if (!bwrap) {
    throw new Error(
      "Sandbox mode requires bubblewrap (bwrap) on PATH. Install it (e.g. `apt install bubblewrap`) or set sandbox mode to off."
    )
  }
  const { args, prefix } = await bwrapArguments(policy, {
    cwd: invocation.cwd,
    setprivPath: policy.exec ? await commandOnPath("setpriv", env) : null,
  })
  return {
    command: bwrap,
    args: [...args, "--", ...prefix, invocation.command, ...invocation.args],
  }
}

/** Runs a trivial command under the policy so a missing backend, blocked
 * user namespaces, or absent Landlock fail before any worker starts. */
export async function probeSandbox(
  policy: ResolvedSandboxPolicy,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
) {
  const wrapped = await sandboxCommand(
    policy,
    { command: "/bin/sh", args: ["-c", "exit 0"], cwd },
    env
  )
  const result = await runProcess(wrapped.command, wrapped.args, {
    cwd,
    env,
    timeoutMs: 15_000,
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `Sandbox probe failed (${policy.platform === "linux" ? "bubblewrap" : "Seatbelt"}): ${
        result.timedOut
          ? "timed out"
          : result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
      }`
    )
  }
}
