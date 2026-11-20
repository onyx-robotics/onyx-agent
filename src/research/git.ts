/**
 * Code moves by git: a worker commits in its own worktree and pushes a branch to the project's
 * remote; an endpoint fetches the commit from there. Nothing but git crosses machines.
 */
import { existsSync, rmSync } from "node:fs"

export function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (p.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")}: ${p.stderr.toString().trim() || p.stdout.toString().trim()}`
    )
  return p.stdout.toString().trim()
}

/** A clone of the remote the supervisor makes worktrees from. */
export function ensureClone(remote: string, dir: string) {
  if (!existsSync(`${dir}/.git`)) {
    const p = Bun.spawnSync(["git", "clone", "--quiet", remote, dir], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (p.exitCode !== 0) throw new Error(`git clone ${remote}: ${p.stderr.toString()}`)
  }
  git(dir, "fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*")
}

/** The commit a ref names (a sha, a branch on the remote, or `HEAD`). */
export function resolveCommit(repo: string, ref: string): string {
  for (const r of [ref, `origin/${ref}`]) {
    try {
      return git(repo, "rev-parse", "--verify", `${r}^{commit}`)
    } catch {
      // try the next form
    }
  }
  throw new Error(`no commit ${ref}`)
}

/** A new worktree on a new branch at `base`. */
export function addWorktree(repo: string, path: string, branch: string, base: string) {
  if (existsSync(path)) return
  git(repo, "worktree", "add", "--quiet", "-B", branch, path, base)
}

export function removeWorktree(repo: string, path: string) {
  try {
    git(repo, "worktree", "remove", "--force", path)
  } catch {
    rmSync(path, { recursive: true, force: true })
  }
}

/** Commit everything in the worktree (if anything changed) and push its branch; the commit. */
export function commitAndPush(worktree: string, branch: string, message: string): string {
  git(worktree, "add", "-A")
  const dirty =
    Bun.spawnSync(["git", "diff", "--cached", "--quiet"], { cwd: worktree }).exitCode !== 0
  if (dirty)
    git(
      worktree,
      "-c",
      "user.name=onyx-research",
      "-c",
      "user.email=research@onyx.local",
      "commit",
      "--quiet",
      "-m",
      message
    )
  git(worktree, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`)
  return git(worktree, "rev-parse", "HEAD")
}

/** The paths under `paths` that differ in the worktree from `base`: committed or not, new files too. */
export function changedPaths(worktree: string, base: string, paths: string[]): string[] {
  if (!paths.length) return []
  const diff = git(worktree, "diff", "--name-only", base, "--", ...paths)
  const added = git(worktree, "ls-files", "--others", "--exclude-standard", "--", ...paths)
  return [...new Set([...diff.split("\n"), ...added.split("\n")].filter(Boolean))]
}

/**
 * Which measurement a commit has: one short hash of what's at `paths` in it (a path that isn't
 * there counts as missing), so two commits measure the same way exactly when it's equal.
 */
export function measurementOf(repo: string, commit: string, paths: string[]): string {
  const parts = paths.map((p) => {
    try {
      return `${p}:${git(repo, "rev-parse", `${commit}:${p}`)}`
    } catch {
      return `${p}:none`
    }
  })
  return new Bun.CryptoHasher("sha1").update(parts.join("\n")).digest("hex").slice(0, 10)
}

/**
 * A clean checkout of `commit` at `path`, fetched from the remote by its branch (a remote need not
 * serve commits by sha).
 */
export function checkout(remote: string, path: string, branch: string, commit: string) {
  rmSync(path, { recursive: true, force: true })
  const init = Bun.spawnSync(["git", "init", "--quiet", path], { stdout: "pipe", stderr: "pipe" })
  if (init.exitCode !== 0) throw new Error(`git init: ${init.stderr.toString()}`)
  git(path, "fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/origin/${branch}`)
  git(path, "checkout", "--quiet", "--detach", commit)
}
