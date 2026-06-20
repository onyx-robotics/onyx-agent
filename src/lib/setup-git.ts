import { git, gitResult } from "./git"

export function setupRepoPath(projectPath: string, ...segments: string[]) {
  return [projectPath, "onyx", ...segments].filter(Boolean).join("/")
}

export function requiredSetupRepoPaths(projectPath: string) {
  return [
    setupRepoPath(projectPath, "setup.json"),
    setupRepoPath(projectPath, "validation.json"),
    setupRepoPath(projectPath, "onyx.md"),
    setupRepoPath(projectPath, "eval.sh"),
  ]
}

export function protectedSetupRepoPaths(projectPath: string) {
  return [
    ...requiredSetupRepoPaths(projectPath),
    setupRepoPath(projectPath, "checks.sh"),
    setupRepoPath(projectPath, "tools"),
  ]
}

export async function assertSetupCommitted({
  root,
  projectPath,
  baseCommitSha = "HEAD",
  requireBaseMatchesHead = false,
}: {
  root: string
  projectPath: string
  baseCommitSha?: string
  requireBaseMatchesHead?: boolean
}) {
  const protectedPaths = protectedSetupRepoPaths(projectPath)
  const status = await git(
    ["status", "--porcelain", "--", ...protectedPaths],
    root
  )
  if (status.trim()) {
    throw new Error(
      [
        "The protected Onyx setup surface has uncommitted changes.",
        "Commit the setup files before creating or starting a campaign:",
        `  git add ${protectedPaths.join(" ")}`,
        '  git commit -m "Add Onyx setup"',
      ].join("\n")
    )
  }

  const missing: string[] = []
  for (const path of requiredSetupRepoPaths(projectPath)) {
    const result = await gitResult(
      ["cat-file", "-e", `${baseCommitSha}:${path}`],
      root
    )
    if (result.code !== 0) missing.push(path)
  }
  if (missing.length > 0) {
    throw new Error(
      [
        `Campaign base ${baseCommitSha} does not contain required Onyx setup file(s): ${missing.join(", ")}.`,
        "Commit the setup surface, then create a new campaign or update the campaign base.",
      ].join("\n")
    )
  }

  if (requireBaseMatchesHead) {
    const changed = await git(
      [
        "diff",
        "--name-only",
        `${baseCommitSha}..HEAD`,
        "--",
        ...protectedPaths,
      ],
      root
    )
    if (changed.trim()) {
      throw new Error(
        [
          `The committed Onyx setup surface differs from campaign base ${baseCommitSha}.`,
          "Create a new campaign, or update/recreate the campaign after committing the current setup.",
          "",
          changed.trim(),
        ].join("\n")
      )
    }
  }
}
