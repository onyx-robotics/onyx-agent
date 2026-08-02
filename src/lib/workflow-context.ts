import type { Args } from "./args"
import { readState } from "./runtime-state"
import { getWorkerRuntimeContextCached } from "./worker-context"

export type WorkerWorkflowContext = {
  sessionId?: string
  workerId?: string
  hypothesisId?: string
}

export async function resolveWorkerWorkflowContext(
  args: Args
): Promise<WorkerWorkflowContext> {
  const context = await getWorkerRuntimeContextCached()
  return {
    sessionId: args.options.session ?? context?.sessionId ?? undefined,
    workerId: args.options.worker ?? context?.workerId ?? undefined,
    hypothesisId:
      args.options.hypothesis ?? context?.hypothesisId ?? undefined,
  }
}

export async function resolveCampaignNameFromContext(
  root: string,
  args: Args,
  missingMessage = "No active campaign. Run `onyx campaign use --name <name>` or pass `--campaign <name>`."
) {
  const context = await getWorkerRuntimeContextCached()
  const state = await readState(root)
  const campaignName =
    args.options.campaign ?? context?.campaignName ?? state.activeCampaign
  if (!campaignName) throw new Error(missingMessage)
  return campaignName
}
