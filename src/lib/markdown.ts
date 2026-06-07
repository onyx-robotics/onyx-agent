import { readFile, writeFile } from "node:fs/promises"

import { currentBranch, nameFromGitBranch } from "./git"
import { readState } from "./outbox"
import { branchStateKey, onyxPath } from "./project"

export type MetricDirection = "maximize" | "minimize"

export type BranchMetadata = {
  name: string
  description: string | null
  gitBranchName: string
  baseCommitSha: string | null
  metricName: string
  metricUnit: string | null
  metricDirection: MetricDirection
}

export async function resolveBranchName(root: string, branchOption?: string) {
  if (branchOption) return branchOption

  const gitBranchName = await currentBranch(root)
  const name = nameFromGitBranch(gitBranchName)
  if (name) return name

  throw new Error("Missing --branch and no local onyx/* branch is checked out.")
}

function markdownField(section: string, name: string) {
  return section.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim()
}

async function branchFromMarkdown({
  root,
  projectPath,
  name,
  gitBranchName,
}: {
  root: string
  projectPath: string
  name: string
  gitBranchName: string
}): Promise<BranchMetadata | null> {
  let text = ""
  try {
    text = await readFile(onyxPath(root, projectPath, "onyx.md"), "utf8")
  } catch {
    return null
  }

  const start = text.indexOf(`### ${name}`)
  if (start === -1) return null
  const rest = text.slice(start)
  const next = rest.slice(1).search(/\n###\s+/)
  const section = next === -1 ? rest : rest.slice(0, next + 1)
  const metricName = markdownField(section, "Metric") || "score"
  const unit = markdownField(section, "Unit")
  const direction = markdownField(section, "Direction")
  const baseCommitSha = markdownField(section, "Base commit")

  return {
    name,
    description: markdownField(section, "Description") || null,
    gitBranchName,
    baseCommitSha: baseCommitSha || null,
    metricName,
    metricUnit: unit || null,
    metricDirection: direction === "minimize" ? "minimize" : "maximize",
  }
}

export async function branchMetadata({
  root,
  projectPath,
  branchName,
  gitBranchName,
}: {
  root: string
  projectPath: string
  branchName: string
  gitBranchName: string
}): Promise<BranchMetadata> {
  const state = await readState(root)
  const stored = state.branches[branchStateKey(projectPath, branchName)]
  if (stored?.metricName) {
    return {
      name: branchName,
      description: stored.description ?? null,
      gitBranchName: stored.gitBranchName ?? gitBranchName,
      baseCommitSha: stored.baseCommitSha ?? null,
      metricName: stored.metricName,
      metricUnit: stored.metricUnit ?? null,
      metricDirection:
        stored.metricDirection === "minimize" ? "minimize" : "maximize",
    }
  }

  return (
    (await branchFromMarkdown({
      root,
      projectPath,
      name: branchName,
      gitBranchName,
    })) ?? {
      name: branchName,
      description: null,
      gitBranchName,
      baseCommitSha: null,
      metricName: "score",
      metricUnit: null,
      metricDirection: "maximize",
    }
  )
}

export async function appendBranchToMarkdown({
  root,
  projectPath,
  name,
  description,
  baseCommitSha,
  metricName,
  metricUnit,
  metricDirection,
}: {
  root: string
  projectPath: string
  name: string
  description?: string | null
  baseCommitSha?: string | null
  metricName: string
  metricUnit?: string | null
  metricDirection: MetricDirection
}) {
  const file = onyxPath(root, projectPath, "onyx.md")
  const marker = `### ${name}`
  let text = ""
  try {
    text = await readFile(file, "utf8")
  } catch {
    return
  }

  if (text.includes(marker)) return

  const addition = `\n### ${name}\n\nDescription: ${description ?? ""}\n\nMetric: ${metricName}\nUnit: ${metricUnit ?? ""}\nDirection: ${metricDirection}\nBase commit: ${baseCommitSha ?? ""}\n\nPlan:\n\nSuccess criteria:\n\nNext to try:\n\n- Add hypotheses here as a queue. Each iteration pops one and appends a row to Attempts.\n\nAttempts:\n\n| commit | hypothesis | metric | status | learning |\n| ------ | ---------- | ------ | ------ | -------- |\n`
  await writeFile(file, `${text.trimEnd()}\n${addition}`, "utf8")
}
