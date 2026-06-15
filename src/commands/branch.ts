import type { LocalResearchBranchStartedRecord } from "../protocol"

import {
  deleteBranch,
  listProjectBranches,
  resolveProject,
} from "../lib/api"
import {
  descriptionOption,
  nameOption,
  normalizeName,
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
import { readHistory, rewriteHistory } from "../lib/history"
import { appendBranchToMarkdown, type MetricDirection } from "../lib/markdown"
import {
  appendOutbox,
  readOutbox,
  readState,
  rewriteOutbox,
  writeState,
} from "../lib/outbox"
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

/**
 * Deletes a branch everywhere: the Onyx record (server tombstones every
 * experiment runRef so a stale outbox can't resurrect them), the remote and
 * local git branches (the user's own git credentials), and the local
 * outbox/history/state rows. Online-required by design — a deletion is not
 * a replayable intent, so it is never queued.
 */
export async function commandBranchDelete(args: Args) {
  const root = await repoRoot()
  const projectPath = await resolveProjectPath(root, args)
  const rawName = args.positional[2] ?? args.options.name
  if (!rawName) {
    throw new Error("Usage: onyx branch delete <name>")
  }
  const name = normalizeName(rawName)
  if (!name) {
    throw new Error("Branch name must contain at least one letter or number")
  }
  const gitBranchName = gitBranchForName(name)

  // Resolve server state first: deletion requires connectivity, and failing
  // here leaves everything untouched.
  let project
  try {
    project = await resolveProject(root, args)
  } catch (error) {
    throw new Error(
      `onyx branch delete needs the Onyx API to remove the branch record (${
        error instanceof Error ? error.message : String(error)
      })`
    )
  }

  const branches = await listProjectBranches(project.id, args)
  const branch = branches.find((candidate) => candidate.name === name)

  // Move HEAD off the branch before touching refs; refuse on a dirty tree so
  // the checkout can't eat uncommitted work.
  if ((await currentBranch(root)) === gitBranchName) {
    const dirty = await git(["status", "--porcelain"], root)
    if (dirty.trim()) {
      throw new Error(
        `HEAD is on ${gitBranchName} with uncommitted changes. Commit or stash them first.`
      )
    }
    await git(["checkout", project.defaultBranch || "main"], root)
    console.log(`Checked out ${project.defaultBranch || "main"}`)
  }

  if (branch) {
    await deleteBranch(branch.id, args)
    console.log(`Deleted Onyx branch record ${name}`)
  } else {
    console.log(`No Onyx record for ${name}; cleaning up git and local state.`)
  }

  const remoteResult = await gitResult(
    ["push", "origin", "--delete", gitBranchName],
    root
  )
  if (remoteResult.code === 0) {
    console.log(`Deleted ${gitBranchName} on origin`)
  }

  const localResult = await gitResult(["branch", "-D", gitBranchName], root)
  if (localResult.code === 0) {
    console.log(`Deleted local ${gitBranchName}`)
  }

  // Purge local caches so nothing replays or lists the deleted branch.
  const { records: outbox } = await readOutbox(root)
  const keptOutbox = outbox.filter((record) =>
    record.type === "branch_started"
      ? record.name !== name
      : record.branchName !== name
  )
  if (keptOutbox.length !== outbox.length) {
    await rewriteOutbox(root, keptOutbox)
  }

  const { records: history } = await readHistory(root)
  const keptHistory = history.filter((record) => record.branchName !== name)
  if (keptHistory.length !== history.length) {
    await rewriteHistory(root, keptHistory)
  }

  const state = await readState(root)
  delete state.branches[branchStateKey(projectPath, name)]
  await writeState(root, state)

  await emitEvent(root, {
    type: "branch_deleted",
    branchName: name,
    message: gitBranchName,
  })
  console.log(`Deleted branch ${name}`)
}
