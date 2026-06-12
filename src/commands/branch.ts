import type { LocalResearchBranchStartedRecord } from "../protocol"

import {
  descriptionOption,
  nameOption,
  requireOption,
  type Args,
} from "../lib/args"
import { emitEvent } from "../lib/events"
import {
  gitBranchForName,
  currentBranch,
  currentCommit,
  git,
  gitResult,
  repoRoot,
} from "../lib/git"
import { appendBranchToMarkdown, type MetricDirection } from "../lib/markdown"
import { appendOutbox, readState, writeState } from "../lib/outbox"
import { branchStateKey, resolveProjectPath } from "../lib/project"
import { flushOutbox } from "../lib/sync"

export async function commandBranchCreate(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const name = nameOption(args)
  const metricName = requireOption(args, "metric")
  const metricUnit = args.options.unit ?? null
  const metricDirection = (args.options.direction ??
    "maximize") as MetricDirection

  if (metricDirection !== "maximize" && metricDirection !== "minimize") {
    throw new Error("--direction must be maximize or minimize")
  }

  const gitBranchName = gitBranchForName(name)
  const baseCommitSha = await currentCommit(root)
  const headBranch = await currentBranch(root)
  const exists = await gitResult(["rev-parse", "--verify", gitBranchName], root)
  // The parent is the branch HEAD was on when the git branch is actually
  // created. Checking out a pre-existing branch records no parent (the
  // server keeps any previously stored one), and detached HEAD yields "".
  const parentGitBranchName =
    exists.code !== 0 && headBranch && headBranch !== gitBranchName
      ? headBranch
      : null
  if (exists.code === 0) {
    await git(["checkout", gitBranchName], root)
  } else {
    await git(["checkout", "-b", gitBranchName], root)
  }

  const description = descriptionOption(args)
  await appendBranchToMarkdown({
    root,
    projectPath,
    name,
    description,
    baseCommitSha,
    parentGitBranchName,
    metricName,
    metricUnit,
    metricDirection,
  })

  const record: LocalResearchBranchStartedRecord = {
    schemaVersion: 1,
    type: "branch_started",
    createdAt: new Date().toISOString(),
    name,
    description,
    gitBranchName,
    ...(parentGitBranchName ? { parentGitBranchName } : {}),
    projectPath,
    baseCommitSha,
    metricName,
    metricUnit,
    metricDirection,
  }
  await appendOutbox(root, record)

  const state = await readState(root)
  state.projectPath = projectPath
  state.branches[branchStateKey(projectPath, name)] = {
    ...state.branches[branchStateKey(projectPath, name)],
    projectPath,
    gitBranchName,
    ...(parentGitBranchName ? { parentGitBranchName } : {}),
    baseCommitSha,
    description,
    metricName,
    metricUnit,
    metricDirection,
  }
  await writeState(root, state)

  await emitEvent(root, {
    type: "branch_created",
    branchName: name,
    commitSha: baseCommitSha,
    message: gitBranchName,
  })
  console.log(`Created ${gitBranchName}`)
  console.log(`Base commit: ${baseCommitSha}`)

  // Best-effort: register the branch with the app now; it stays queued if offline.
  await flushOutbox(root, args, { quiet: true }).catch(() => {})
}
