import { mkdir } from "node:fs/promises"

import { runProcess } from "../src/lib/process"

const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64-baseline",
] as const

function assetName(target: string) {
  return target.replace(/^bun-/, "onyx-")
}

async function run(command: string, args: string[]) {
  const result = await runProcess(command, args, { cwd: import.meta.dir + "/.." })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        result.stderr.trim() || result.stdout.trim()
      }`
    )
  }
  return result
}

await mkdir("dist", { recursive: true })

for (const target of targets) {
  await run("bun", [
    "build",
    "./bin/onyx.js",
    "--compile",
    "--minify",
    `--target=${target}`,
    `--outfile=dist/${assetName(target)}`,
  ])
}

await run("sh", [
  "-c",
  "cd dist && sha256sum onyx-* > checksums.txt",
])
