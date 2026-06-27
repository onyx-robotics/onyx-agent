import { mkdir } from "node:fs/promises"

import { runProcess } from "../src/lib/process"

const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64-baseline",
] as const

function assetName(prefix: string, target: string) {
  return target.replace(/^bun-/, `${prefix}-`)
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
  for (const [prefix, entry] of [
    ["onyx", "./bin/onyx.js"],
    ["onyx-worker", "./bin/onyx-worker.js"],
  ] as const) {
    await run("bun", [
      "build",
      entry,
      "--compile",
      "--minify",
      `--target=${target}`,
      `--outfile=dist/${assetName(prefix, target)}`,
    ])
  }
}

await run("sh", [
  "-c",
  "cd dist && sha256sum onyx-* > checksums.txt",
])
