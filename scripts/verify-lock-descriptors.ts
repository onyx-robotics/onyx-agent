import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { runProcess } from "../src/lib/process"

const expected = process.env.ONYX_LOCK_PROBE_PLATFORM
const platform = `${process.platform}/${process.arch}`
if (expected && expected !== platform)
  throw new Error(`Expected ${expected}, got ${platform}`)
const dir = await mkdtemp(join(tmpdir(), "onyx-lock-proof-"))
const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await pause()
  }
  throw new Error(message)
}
try {
  const binary = join(dir, "probe")
  const target = process.env.ONYX_LOCK_PROBE_TARGET
  const built = await runProcess(process.execPath, [
    "build",
    "--compile",
    "--minify",
    ...(target ? [`--target=${target}`] : []),
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
  const contend = () => runProcess(binary, ["contend", path])
  for (const mode of ["hold", "hold-git", "descendant", "close", "timeout"]) {
    const marker = join(dir, mode)
    if (mode === "hold-git") {
      const hook = join(remote, "hooks/pre-receive")
      const quoted = `'${marker.replaceAll("'", "'\\''")}'`
      await writeFile(
        hook,
        `#!/bin/sh\nmarker=${quoted}\necho $$ > "$marker"\ni=0\nwhile [ ! -f "$marker.release" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done\ncat >/dev/null\n`
      )
      await chmod(hook, 0o700)
    }
    const launcher = spawn(binary, [mode, path, marker, repository], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    launcher.stderr?.on("data", (data) => {
      stderr += String(data)
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      launcher.once("error", reject)
      launcher.once("exit", resolve)
    })
    try {
      await waitFor(
        async () => Boolean(await readFile(marker, "utf8").catch(() => "")),
        `${mode}: child never ready: ${stderr}`
      )
      if (mode === "descendant") {
        if ((await exited) !== 0)
          throw new Error(`${mode}: launcher failed: ${stderr}`)
      } else if (mode !== "timeout") {
        launcher.kill("SIGKILL")
        await exited
      }
      const contender = await contend()
      const expectedCode = mode === "close" ? 0 : 2
      if (contender.code !== expectedCode)
        throw new Error(
          `${mode}: expected contender ${expectedCode}, got ${contender.code}: ${stderr}`
        )
      if (mode === "timeout") {
        if ((await exited) !== 0)
          throw new Error(`${mode}: launcher failed: ${stderr}`)
      }
      await writeFile(`${marker}.release`, "release")
      if (mode === "close") {
        await waitFor(
          async () =>
            Boolean(
              await readFile(`${marker}.child-finished`, "utf8").catch(() => "")
            ),
          "Descriptor-closing child did not finish"
        )
      }
      await waitFor(
        async () => (await contend()).code === 0,
        `${mode}: final descriptor never released`
      )
      if ((await contend()).code !== 0)
        throw new Error(`${mode}: contender leaked descriptor`)
      console.log(`PASS ${platform} ${mode}`)
    } finally {
      await writeFile(`${marker}.release`, "release")
      if (launcher.exitCode === null && launcher.signalCode === null)
        launcher.kill("SIGKILL")
      await exited.catch(() => undefined)
    }
  }
  const failed = await runProcess(binary, [
    "spawn-failure",
    path,
    join(dir, "failed-spawn"),
  ])
  if (failed.code !== 0 || (await contend()).code !== 0)
    throw new Error(`Spawn failure leaked protection: ${failed.stderr}`)
  console.log(
    `PASS ${platform} spawn-failure; compiled descriptor feasibility only, production kernel locks remain disabled`
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}
