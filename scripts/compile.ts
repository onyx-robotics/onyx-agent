/**
 * The onyx command as one file that runs without Bun or Node, in dist/:
 *
 *   bun run compile            # for this machine
 *   bun run compile -- --all   # linux and macOS, x64 and arm64 (downloads Bun's runtimes)
 */
import { join } from "node:path"
import { parseArgs } from "node:util"

const ROOT = join(import.meta.dir, "..")

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: { all: { type: "boolean" } },
})

const here = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const targets = args.all ? ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"] : [here]
for (const t of targets) {
  const out = `dist/onyx-${t}`
  const r = Bun.spawnSync(
    [
      "bun",
      "build",
      "src/cli/main.ts",
      "--compile",
      // configuration comes from flags, the environment and the config file: never from a .env
      // or bunfig.toml in whatever directory onyx runs in
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--minify",
      `--target=bun-${t}`,
      `--outfile=${out}`,
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" }
  )
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1)
  console.log(`built ${out}`)
}
