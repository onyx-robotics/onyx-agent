import { dlopen, FFIType } from "bun:ffi"
import { openSync, closeSync, writeFileSync } from "node:fs"
import { runProcess } from "../../src/lib/process"
const [mode, path, marker, repository] = process.argv.slice(2)
if (!path) throw new Error("Lock path required")
const lib = dlopen(
  process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }
)
const fd = openSync(path, "a+")
const acquired = lib.symbols.flock(fd, 2 | 4) === 0
if (mode === "contend") {
  closeSync(fd)
  process.exit(acquired ? 0 : 2)
}
if (!acquired || !marker) throw new Error("Cannot acquire probe lock")
try {
  if (mode === "spawn-failure") {
    await runProcess("/missing/onyx-lock-probe", [], {
      inheritedFds: [fd],
    }).catch(() => {})
  } else if (mode === "hold-git") {
    if (!repository) throw new Error("Repository required")
    await runProcess("git", ["push", "origin", "HEAD:refs/heads/result"], {
      cwd: repository,
      inheritedFds: [fd],
    })
  } else {
    await runProcess("sh", ["-c", 'echo $$ > "$1"; sleep 3', "probe", marker], {
      inheritedFds: [fd],
    })
  }
  writeFileSync(`${marker}.finished`, "finished")
} finally {
  closeSync(fd)
}
