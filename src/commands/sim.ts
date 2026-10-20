import type { Args } from "../lib/args"
import { repoRoot } from "../lib/git"
import { resolveProjectPath } from "../lib/project"
import { readSimConfig } from "../lib/sim-config"
import { runToolCommand } from "../lib/tools"

/**
 * Runs the simulator on the current working tree, committed or not. Nothing
 * is recorded: simulation results are for developing ideas, never campaign
 * experiments. `exp run --resume` runs the same simulator as the gate before
 * a commit may queue for hardware.
 */
export async function commandSimRun(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const sim = await readSimConfig(root, projectPath)
  if (!sim) {
    throw new Error(
      "This project has no simulator: onyx/sim.json is missing. Set one up during `onyx setup` to use the hardware queue."
    )
  }
  const result = await runToolCommand({
    root,
    projectPath,
    name: sim.tool,
    extraArgs: args.positional.slice(2),
    timeoutSeconds: args.options.timeout
      ? Number(args.options.timeout)
      : undefined,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.timedOut) {
    console.error(`Simulator ${sim.tool} timed out`)
    process.exitCode = 124
    return
  }
  if (result.code !== 0) process.exitCode = result.code ?? 1
}
