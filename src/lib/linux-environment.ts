import { readFileSync, existsSync } from "node:fs"
import { access, lstat, open, readFile, realpath } from "node:fs/promises"
import { constants } from "node:fs"
import { release } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type WslVersion = "none" | "1" | "2" | "unknown"

export function classifyWsl(platform: string, kernel: string): WslVersion {
  if (platform !== "linux" || !/microsoft|wsl/i.test(kernel)) return "none"
  if (/wsl2|microsoft-standard/i.test(kernel)) return "2"
  if (/microsoft/i.test(kernel) && !/standard/i.test(kernel)) return "1"
  return "unknown"
}

// Kernel evidence survives env -i and provider environment allowlists.
export function wslVersion(): WslVersion {
  if (process.platform !== "linux") return "none"
  let kernel = release()
  try {
    kernel += ` ${readFileSync("/proc/version", "utf8")}`
  } catch {
    /* Retain uname evidence. */
  }
  const detected = classifyWsl(process.platform, kernel)
  if (detected !== "none") return detected
  return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") ||
    existsSync("/run/WSL")
    ? "unknown"
    : "none"
}

export function linuxBootId(): string | null {
  if (process.platform !== "linux") return null
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    return /^[a-f0-9-]{36}$/.test(value) ? value : null
  } catch {
    return null
  }
}

export type LinuxMount = { path: string; type: string; source: string }
const unescapeMount = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8))
  )

export function parseMountInfo(input: string): LinuxMount[] {
  return input.split("\n").flatMap((line) => {
    const [left, right] = line.split(" - ")
    const fields = left?.split(" ")
    const filesystem = right?.split(" ")
    if (!fields?.[4] || !filesystem?.[0] || !filesystem[1]) return []
    return [
      {
        path: unescapeMount(fields[4]),
        type: filesystem[0],
        source: unescapeMount(filesystem[1]),
      },
    ]
  })
}

export function storageMount(path: string, mounts: LinuxMount[]) {
  return (
    mounts
      .filter(
        (mount) =>
          path === mount.path ||
          path.startsWith(mount.path === "/" ? "/" : `${mount.path}/`)
      )
      .sort(
        (a, b) =>
          b.path.length - a.path.length ||
          Number(isLinuxLocalMount(a)) - Number(isLinuxLocalMount(b))
      )[0] ?? null
  )
}

export function isLinuxLocalMount(mount: LinuxMount | null) {
  return (
    !!mount &&
    ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "tmpfs", "ramfs"].includes(
      mount.type
    )
  )
}

/** Resolve the nearest existing ancestor without creating anything. Dangling
 * symlinks and unreadable ancestors are errors, not permission to use a parent. */
export async function resolveStoragePath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    await lstat(absolute)
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      dirname(absolute) === absolute
    )
      throw error
    return join(
      await resolveStoragePath(dirname(absolute)),
      absolute.slice(dirname(absolute).length)
    )
  }
  return realpath(absolute)
}

export async function assertWslStorage(
  paths: string[],
  purpose: string,
  inspection = {
    version: wslVersion(),
    mounts: () => readFile("/proc/self/mountinfo", "utf8"),
  }
) {
  if (inspection.version === "none") return
  if (inspection.version !== "2")
    throw new Error(
      `${purpose} requires WSL2; detected WSL ${inspection.version}. Use Ubuntu 24.04 in WSL2.`
    )
  let mounts: LinuxMount[]
  try {
    mounts = parseMountInfo(await inspection.mounts())
  } catch {
    throw new Error(
      `Cannot inspect Linux mounts for ${purpose}; no protected operation was started.`
    )
  }
  for (const path of paths) {
    const resolved = await resolveStoragePath(path)
    const mount = storageMount(resolved, mounts)
    if (!isLinuxLocalMount(mount)) {
      throw new Error(
        `${purpose} requires Linux-local storage: ${path} resolves to ${resolved} (${mount?.type ?? "unclassified"}). Move it into this distribution's Linux home directory and update any ONYX_HOME/XDG_CONFIG_HOME override. Windows and network mounts are unsupported.`
      )
    }
  }
}

async function executablePath(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string
) {
  const candidates = command.includes("/")
    ? [resolve(cwd, command)]
    : (env.PATH ?? "")
        .split(":")
        .map((dir) => resolve(cwd, dir || ".", command))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Executable ${command} was not found in the Linux PATH.`)
}

/** Inspect bounded launcher contents and interpreter chains, without executing
 * a Windows shim to discover its version. This is preflight, not a sandbox. */
export function isWindowsExecutable(path: string, source: string) {
  // Some Linux distributions of providers retain an .exe filename. The ELF
  // header is stronger evidence than that suffix.
  if (source.startsWith("\u007fELF")) return false
  if (source.startsWith("MZ") || /\.(exe|cmd|bat|ps1)$/i.test(path)) return true
  const shebang = source.split("\n", 1)[0] ?? ""
  const shell = /^#!.*(?:\/|\s)(?:sh|bash|dash|zsh)(?:\s|$)/.test(shebang)
  // Reject shell installation shims that execute Windows programs. Do not
  // mistake platform-selection strings inside a Node launcher for execution.
  return (
    shell &&
    /(?:^|\n)\s*(?:exec\s+[^\n]*(?:\b[\w.-]+\.exe\b|[A-Za-z]:\\|\/mnt\/[a-z]\/)|["']?[^\s\n]*\.exe(?:["'\s]|$))/i.test(
      source
    )
  )
}

export async function assertWslExecutable(
  command: string,
  env = process.env,
  cwd = process.cwd(),
  seen = new Set<string>()
): Promise<void> {
  if (wslVersion() === "none") return
  const path = await executablePath(command, env, cwd)
  await assertWslStorage([path], "Linux executable")
  if (seen.has(path) || seen.size >= 8)
    throw new Error(`Cannot establish interpreter identity for ${path}`)
  seen.add(path)
  const file = await open(path, "r")
  const bytes = Buffer.alloc(8192)
  const { bytesRead } = await file.read(bytes).finally(() => file.close())
  const source = bytes.subarray(0, bytesRead).toString("utf8")
  if (isWindowsExecutable(path, source)) {
    throw new Error(
      `Windows executable or installation shim resolved at ${path}. Install ${command} inside this Linux distribution and put its Linux installation first on PATH.`
    )
  }
  if (source.startsWith("#!")) {
    const words = source.split("\n", 1)[0]!.slice(2).trim().split(/\s+/)
    const interpreter = words.shift()!
    if (!isAbsolute(interpreter))
      throw new Error(`Non-absolute interpreter in ${path}`)
    await assertWslExecutable(interpreter, env, cwd, new Set(seen))
    if (interpreter.endsWith("/env")) {
      if (words[0] === "-S") words.shift()
      const target = words.shift()
      if (!target || target.startsWith("-") || target.includes("="))
        throw new Error(
          `Cannot resolve env interpreter in ${path}; use a Linux launcher with an explicit interpreter.`
        )
      await assertWslExecutable(target, env, cwd, new Set(seen))
    }
  } else if (!source.startsWith("\u007fELF")) {
    throw new Error(
      `Cannot identify Linux executable format at ${path}; install a native Linux binary or a script with a Linux shebang.`
    )
  }
}
