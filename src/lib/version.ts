import packageJson from "../../package.json"
import { execFileSync } from "node:child_process"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

export const ONYX_AGENT_PROTOCOL_VERSION = 5
export const ONYX_WORKER_CONTEXT_SCHEMA_VERSION = 7

function sourceBuildSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

export function cliVersionInfo(entrypoint: "onyx" | "onyx-worker") {
  const executablePath = process.argv[1] ?? null
  const distribution =
    process.env.ONYX_DISTRIBUTION ??
    (executablePath?.includes("/packages/agent/") ? "source" : "release")
  return {
    packageVersion: packageJson.version,
    protocolVersion: ONYX_AGENT_PROTOCOL_VERSION,
    workerContextSchemas: [ONYX_WORKER_CONTEXT_SCHEMA_VERSION],
    buildSha:
      process.env.ONYX_BUILD_SHA ??
      (distribution === "source" ? sourceBuildSha() : null),
    distribution,
    entrypoint,
    executablePath,
  }
}

export function renderCliVersion(entrypoint: "onyx" | "onyx-worker") {
  const info = cliVersionInfo(entrypoint)
  return `${entrypoint} ${info.packageVersion} (protocol ${info.protocolVersion}, ${info.distribution}${info.buildSha ? ` ${info.buildSha.slice(0, 12)}` : ""})`
}
