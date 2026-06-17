import { commandOutput, runProcess } from "./process"

export async function git(args: string[], cwd?: string) {
  return commandOutput("git", args, cwd)
}

export async function gitResult(args: string[], cwd?: string) {
  return runProcess("git", args, { cwd })
}

export async function repoRoot(cwd = process.cwd()) {
  return git(["rev-parse", "--show-toplevel"], cwd)
}

/** Absolute path to the repo's git directory (handles worktrees). */
export async function gitDir(root: string) {
  return git(["rev-parse", "--absolute-git-dir"], root)
}

export async function currentBranch(cwd: string) {
  return git(["branch", "--show-current"], cwd)
}

export async function currentCommit(cwd: string) {
  return git(["rev-parse", "HEAD"], cwd)
}

/** Pushes an immutable local commit SHA to a remote ref. */
export async function pushRef(root: string, commitSha: string, ref: string) {
  await git(["push", "origin", `${commitSha}:${ref}`], root)
}

export function normalizeRepositoryUrl(value: string) {
  const ssh = value.match(/^git@github\.com:(.+?)\/(.+?)(?:\.git)?$/)
  if (ssh)
    return `https://github.com/${ssh[1]}/${ssh[2]!.replace(/\.git$/, "")}`
  return value.replace(/\.git$/, "")
}

export async function repositoryUrl(
  root: string,
  explicitUrl?: string
): Promise<string> {
  if (explicitUrl) return normalizeRepositoryUrl(explicitUrl)
  const origin = await git(["remote", "get-url", "origin"], root)
  return normalizeRepositoryUrl(origin)
}
