import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { runProcess } from "../src/lib/process"
const dir = await mkdtemp(join(tmpdir(), "onyx-lock-proof-"))
try {
  const binary = join(dir, "probe")
  const built = await runProcess(process.execPath, [
    "build",
    "--compile",
    join(import.meta.dir, "fixtures/lock-descriptor-probe.ts"),
    "--outfile",
    binary,
  ])
  if (built.code !== 0) throw new Error(built.stderr)
  const path = join(dir, "lock")
  const repository = join(dir, "repository")
  const remote = join(dir, "remote.git")
  for (const args of [
    ["init", "--quiet", repository],
    ["init", "--bare", "--quiet", remote],
    [
      "-C",
      repository,
      "-c",
      "user.name=Probe",
      "-c",
      "user.email=probe@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "probe",
    ],
    ["-C", repository, "remote", "add", "origin", remote],
  ]) {
    const result = await runProcess("git", args)
    if (result.code !== 0) throw new Error(result.stderr)
  }
  const failures: string[] = []
  for (const mode of ["hold", "hold-git"]) {
    const marker = join(dir, mode)
    if (mode === "hold-git") {
      const hook = join(remote, "hooks/pre-receive")
      // Test paths are generated here, not external shell input.
      await writeFile(
        hook,
        `#!/bin/sh\necho $$ > '${marker.replaceAll("'", "'\\''")}'\nsleep 3\ncat >/dev/null\n`
      )
      await chmod(hook, 0o700)
    }
    const launcher = spawn(binary, [mode, path, marker, repository], {
      stdio: "ignore",
    })
    let ready = false
    for (let i = 0; i < 250; i++) {
      if (await readFile(marker, "utf8").catch(() => "")) {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    launcher.kill("SIGKILL")
    if (!ready) {
      failures.push(`${mode}: protected child never became ready`)
      continue
    }
    const contender = await runProcess(binary, ["contend", path])
    await new Promise((resolve) => setTimeout(resolve, 3200))
    const released = await runProcess(binary, ["contend", path])
    if (contender.code !== 2 || released.code !== 0)
      failures.push(`${mode}: live=${contender.code}, exited=${released.code}`)
  }
  await runProcess(binary, ["spawn-failure", path, join(dir, "failed-spawn")])
  if ((await runProcess(binary, ["contend", path])).code !== 0)
    failures.push("spawn failure retained descriptor")
  if (failures.length)
    throw new Error(`Compiled descriptor gate failed: ${failures.join("; ")}`)
  console.log(
    `PASS compiled shell/Git/failed-spawn descriptor checks ${process.platform}/${process.arch}; other release targets remain unverified`
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}
