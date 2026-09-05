import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dir, "..")
const verificationDirectory = await mkdtemp(
  join(tmpdir(), "onyx-agent-lockfile-")
)

let exitCode = 1

try {
  await Promise.all(
    ["package.json", "bun.lock"].map((file) =>
      copyFile(join(repositoryRoot, file), join(verificationDirectory, file))
    )
  )

  const child = Bun.spawn(
    [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--lockfile-only",
      "--ignore-scripts",
    ],
    {
      cwd: verificationDirectory,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }
  )

  exitCode = await child.exited
} finally {
  await rm(verificationDirectory, { recursive: true, force: true })
}

if (exitCode !== 0) {
  throw new Error(
    "bun.lock does not match package.json; run bun install in a standalone onyx-agent checkout"
  )
}

console.log("Standalone agent lockfile is current.")
