/**
 * The package's JavaScript for Node, in dist/: the CLI in process (`.`) and the SDK (`./sdk`), as
 * ES modules that import their dependencies. Bun runs the TypeScript in src as it is (the `bun`
 * export condition, and the `onyx` command); types come from src too.
 *
 *   bun run build
 */
import { existsSync, readdirSync, rmSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dir, "..")
const DIST = join(ROOT, "dist")

// what an earlier build made; the binaries (bun run compile, dist/onyx-*) are kept
if (existsSync(DIST))
  for (const f of readdirSync(DIST))
    if (!f.startsWith("onyx-")) rmSync(join(DIST, f), { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [join(ROOT, "src/index.ts"), join(ROOT, "src/sdk/index.ts")],
  root: join(ROOT, "src"),
  outdir: DIST,
  target: "node",
  format: "esm",
  // one copy of the SDK for both entry points, so its classes are the same for each
  splitting: true,
  packages: "external",
  sourcemap: "linked",
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const o of result.outputs)
  if (o.kind !== "sourcemap") console.log(`built ${relative(ROOT, o.path)}`)
