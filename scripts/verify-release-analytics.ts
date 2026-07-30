import { join, resolve } from "node:path"

const directory = process.argv[2]
const expectedProjectToken = process.argv[3]
if (!directory || !expectedProjectToken) {
  throw new Error(
    "Usage: bun scripts/verify-release-analytics.ts <release-directory> <expected-project-token>"
  )
}
const releaseDirectory = directory

async function binaryText(name: "onyx" | "onyx-worker") {
  const path = join(resolve(releaseDirectory), name)
  if (!(await Bun.file(path).exists())) throw new Error(`${path} is missing`)
  return new TextDecoder("latin1").decode(await Bun.file(path).arrayBuffer())
}

const cli = await binaryText("onyx")
const worker = await binaryText("onyx-worker")

if (!cli.includes(expectedProjectToken)) {
  throw new Error(
    "Official CLI binary did not embed the configured public token"
  )
}
for (const forbidden of [
  expectedProjectToken,
  "cli:command_complete",
  "research:preflight_fail",
  "captureImmediate",
  "onyx.telemetry",
  "e.onyxresearch.ai",
]) {
  if (worker.toLowerCase().includes(forbidden.toLowerCase())) {
    throw new Error(`onyx-worker unexpectedly contains ${forbidden}`)
  }
}

console.log("Release analytics binary boundary is valid.")
