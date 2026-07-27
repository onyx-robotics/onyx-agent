import { requireOption, type Args } from "../lib/args"
import { repoRoot } from "../lib/git"
import { resolveProjectPath } from "../lib/project"
import { runToolCommand } from "../lib/tools"

export async function commandToolsRun(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const name = args.positional[2] ?? requireOption(args, "name")
  const extraArgs = args.positional.slice(3)
  const result = await runToolCommand({
    root,
    projectPath,
    name,
    extraArgs,
    timeoutSeconds: args.options.timeout
      ? Number(args.options.timeout)
      : undefined,
  })

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.timedOut) {
    console.error(`Tool ${name} timed out`)
    process.exitCode = 124
    return
  }
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1
  }
}
