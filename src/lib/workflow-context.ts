import type { Args } from "./args"
import { readState } from "./runtime-state"

export type WorkerWorkflowContext = {
  sessionId?: string
  workerId?: string
  hypothesisId?: string
}

function optionOrEnv(args: Args, option: string, env: string) {
  return args.options[option] ?? process.env[env] ?? undefined
}

export function resolveWorkerWorkflowContext(
  args: Args
): WorkerWorkflowContext {
  return {
    sessionId: optionOrEnv(args, "session", "ONYX_SESSION_ID"),
    workerId: optionOrEnv(args, "worker", "ONYX_WORKER_ID"),
    hypothesisId: optionOrEnv(args, "hypothesis", "ONYX_HYPOTHESIS_ID"),
  }
}

export async function resolveCampaignNameFromContext(
  root: string,
  args: Args,
  missingMessage = "No active campaign. Run `onyx campaign use --name <name>` or pass `--campaign <name>`."
) {
  const state = await readState(root)
  const campaignName =
    args.options.campaign ??
    process.env.ONYX_CAMPAIGN_NAME ??
    state.activeCampaign
  if (!campaignName) throw new Error(missingMessage)
  return campaignName
}
