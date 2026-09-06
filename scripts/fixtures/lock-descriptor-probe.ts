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
// Finite escape hatch if the controller fails. FD 3 is duplicated by the
// actual runProcess spawn path, regardless of the launcher's descriptor number.
const waitForRelease =
  'i=0; while [ ! -f "$1.release" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done; echo done > "$1.child-finished"'
try {
  if (mode === "spawn-failure") {
    let failed = false
    try {
      await runProcess("/missing/onyx-lock-probe", [], { inheritedFds: [fd] })
    } catch {
      failed = true
    }
    if (!failed) throw new Error("Missing executable unexpectedly spawned")
  } else if (mode === "hold-git") {
    if (!repository) throw new Error("Repository required")
    await runProcess("git", ["push", "origin", "HEAD:refs/heads/result"], {
      cwd: repository,
      inheritedFds: [fd],
    })
  } else if (mode === "descendant") {
    // The direct shell exits and closes its copy; its background descendant
    // must still exclude contenders after the launcher also closes.
    await runProcess(
      "sh",
      [
        "-c",
        '(echo $$ > "$1"; ' + waitForRelease + ") >/dev/null 2>&1 &",
        "probe",
        marker,
      ],
      { inheritedFds: [fd] }
    )
  } else if (mode === "timeout") {
    const result = await runProcess(
      "sh",
      [
        "-c",
        'trap "" TERM; echo $$ > "$1"; while :; do sleep 0.1; done',
        "probe",
        marker,
      ],
      { inheritedFds: [fd], timeoutMs: 1500, killGraceMs: 300 }
    )
    if (!result.timedOut || result.code === 0)
      throw new Error("Timeout did not terminate protected execution")
  } else {
    const close = mode === "close" ? "exec 3>&-; " : ""
    await runProcess(
      "sh",
      ["-c", close + 'echo $$ > "$1"; ' + waitForRelease, "probe", marker],
      { inheritedFds: [fd] }
    )
  }
  writeFileSync(`${marker}.finished`, "finished")
} finally {
  // LOCK_UN would also unlock inherited copies; each process must close only.
  closeSync(fd)
}
