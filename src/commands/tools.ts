import { requireOption, type Args } from "../lib/args"
import { readSetupFile } from "../lib/contract"
import { repoRoot } from "../lib/git"
import { resolveProjectPath } from "../lib/project"
import { isHardwareTool, readSimConfig } from "../lib/sim-config"
import { runToolCommand } from "../lib/tools"
import { getWorkerRuntimeContextCached } from "../lib/worker-context"

/** With a hardware queue, workers reach hardware only through the queue. */
async function assertNotHardwareFromWorker(
  root: string,
  projectPath: string,
  name: string
) {
  if (!(await getWorkerRuntimeContextCached())) return
  const sim = await readSimConfig(root, projectPath)
  if (!sim) return
  const setup = await readSetupFile(root, projectPath)
  if (isHardwareTool(setup, name)) {
    throw new Error(
      `Tool ${name} uses shared hardware, which only the hardware queue may run. Develop in simulation with \`onyx-worker sim run\`, then queue a commit with \`onyx-worker exp run --resume --auto\`.`
    )
  }
}

export async function commandToolsRun(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const name = args.positional[2] ?? requireOption(args, "name")
  const extraArgs = args.positional.slice(3)
  await assertNotHardwareFromWorker(root, projectPath, name)
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
