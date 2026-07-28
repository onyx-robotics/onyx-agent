import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { runProcess } from "../src/lib/process"

const releaseTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64-baseline",
] as const

type BuildOptions = {
  targets: readonly string[]
  outputDirectory: string
  current: boolean
}

function parseArgs(argv: string[]): BuildOptions {
  let target: string | null = null
  let outputDirectory = resolve(import.meta.dir, "..", "dist")
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (!next || next.startsWith("--"))
        throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    if (arg === "--target") target = value()
    else if (arg === "--out-dir") outputDirectory = resolve(value())
    else throw new Error(`Unknown build-release option: ${arg}`)
  }
  return {
    targets: !target || target === "all" ? releaseTargets : [target],
    outputDirectory,
    current: target === "current",
  }
}

function assetName(prefix: string, target: string) {
  return target.replace(/^bun-/, `${prefix}-`)
}

async function run(command: string, args: string[]) {
  const result = await runProcess(command, args, {
    cwd: import.meta.dir + "/..",
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        result.stderr.trim() || result.stdout.trim()
      }`
    )
  }
  return result
}

const options = parseArgs(process.argv.slice(2))
await mkdir(options.outputDirectory, { recursive: true })

const outputs: string[] = []
for (const target of options.targets) {
  for (const [prefix, entry] of [
    ["onyx", "./bin/onyx.js"],
    ["onyx-worker", "./bin/onyx-worker.js"],
  ] as const) {
    const output = join(
      options.outputDirectory,
      options.current ? prefix : assetName(prefix, target)
    )
    const targetArgs = options.current ? [] : [`--target=${target}`]
    await run("bun", [
      "build",
      entry,
      "--compile",
      "--minify",
      ...targetArgs,
      `--outfile=${output}`,
    ])
    outputs.push(output)
  }
}

const checksums: string[] = []
for (const output of outputs) {
  const digest = createHash("sha256")
    .update(Buffer.from(await Bun.file(output).arrayBuffer()))
    .digest("hex")
  checksums.push(`${digest}  ${output.split("/").at(-1)}`)
}
await writeFile(
  join(options.outputDirectory, "checksums.txt"),
  `${checksums.join("\n")}\n`
)
