import { createHash } from "node:crypto"
import path from "node:path"

import type { ResearchEvaluationManifest, ResearchSetupFile } from "../protocol"

import { sortedJson } from "./contract"
import { git } from "./git"

function sha256(value: Uint8Array | string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function normalizeFingerprintPath(value: string) {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `Invalid evaluation fingerprint path ${JSON.stringify(value)}; paths must stay inside projectPath.`
    )
  }
  return normalized
}

async function committedBlob(
  root: string,
  commitSha: string,
  repoPath: string
) {
  const child = Bun.spawn(["git", "show", `${commitSha}:${repoPath}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `Unable to read committed evaluation input ${repoPath}: ${stderr.trim()}`
    )
  }
  return new Uint8Array(stdout)
}

export async function evaluationFingerprint({
  root,
  projectPath,
  commitSha,
  setup,
}: {
  root: string
  projectPath: string
  commitSha: string
  setup: ResearchSetupFile
}): Promise<{ fingerprint: string; manifest: ResearchEvaluationManifest }> {
  const metricSteps = setup.workflow.filter((step) =>
    Boolean(step.run && step.metric)
  )
  if (metricSteps.length !== 1) {
    throw new Error(
      "Evaluation fingerprinting requires exactly one metric workflow step."
    )
  }
  const metricStep = metricSteps[0]!
  const metricToolId = metricStep.run!
  const metricTool = setup.tools[metricToolId]
  if (!metricTool) {
    throw new Error(`Metric workflow tool ${metricToolId} is not declared.`)
  }
  const fingerprintPaths = [
    ...new Set(metricTool.fingerprintPaths.map(normalizeFingerprintPath)),
  ].sort()
  if (fingerprintPaths.length === 0) {
    throw new Error(
      `Metric tool ${metricToolId} must declare at least one fingerprintPaths entry.`
    )
  }

  const repoPrefix = projectPath ? `${projectPath.replace(/\/$/, "")}/` : ""
  const files = new Map<string, string>()
  for (const inputPath of fingerprintPaths) {
    const repoPath = `${repoPrefix}${inputPath}`
    const untracked = await git(
      ["ls-files", "--others", "--exclude-standard", "--", repoPath],
      root
    )
    if (untracked.trim()) {
      throw new Error(
        `Evaluation fingerprint path ${inputPath} contains untracked files: ${untracked
          .split("\n")
          .filter(Boolean)
          .join(", ")}`
      )
    }
    const listing = await git(
      ["ls-tree", "-r", "-z", commitSha, "--", repoPath],
      root
    )
    const entries = listing
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/.exec(line)
        if (!match)
          throw new Error(`Unexpected git tree entry for ${inputPath}.`)
        return { mode: match[1]!, type: match[2]!, path: match[4]! }
      })
    if (entries.length === 0) {
      throw new Error(
        `Evaluation fingerprint path ${inputPath} is missing from commit ${commitSha}.`
      )
    }
    for (const entry of entries) {
      if (
        entry.type !== "blob" ||
        entry.mode === "120000" ||
        !entry.mode.startsWith("100")
      ) {
        throw new Error(
          `Evaluation fingerprint input ${entry.path} must be a tracked regular file, not a symlink or special entry.`
        )
      }
      const relativePath = entry.path.startsWith(repoPrefix)
        ? entry.path.slice(repoPrefix.length)
        : entry.path
      files.set(
        relativePath,
        sha256(await committedBlob(root, commitSha, entry.path))
      )
    }
  }

  const manifest: ResearchEvaluationManifest = {
    algorithmVersion: 1,
    metric: setup.metric,
    metricStep,
    metricToolId,
    metricTool: {
      ...metricTool,
      fingerprintPaths,
    },
    files: [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, fileSha256]) => ({
        path: filePath,
        sha256: fileSha256,
      })),
  }
  return {
    fingerprint: sha256(sortedJson(manifest)),
    manifest,
  }
}
