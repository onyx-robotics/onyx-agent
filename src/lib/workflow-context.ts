import type { Args } from "./args"
import { readState } from "./runtime-state"
import { getWorkerRuntimeContextCached } from "./worker-context"

export type WorkerWorkflowContext = {
  sessionId?: string
  workerId?: string
  hypothesisId?: string
  /** Worker research deadline from the runtime context; never flag-provided. */
  researchDeadlineAt?: string
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
    researchDeadlineAt: context?.researchDeadlineAt ?? undefined,
  }
}

export async function resolveCampaignNameFromContext(
  root: string,
  args: Args,
  missingMessage = "No active campaign. Run `onyx campaign use --name <name>` or pass `--campaign <name>`."
) {
  const context = await getWorkerRuntimeContextCached()
  if (args.options.campaign) {
    if (context && args.options.campaign !== context.campaignName) {
      throw new Error(
        `--campaign conflicts with supervised worker context campaign ${context.campaignName}`
      )
    }
    return args.options.campaign
  }
  if (context) return context.campaignName

  const state = await readState(root)
  if (!state.activeCampaign) throw new Error(missingMessage)
  return state.activeCampaign
}
