import type { Args } from "../lib/args"
import { repoRoot } from "../lib/git"
import { readState } from "../lib/outbox"
import { resolveProjectPath } from "../lib/project"
import {
  listWorkflowSteps,
  readLatestActiveWorkflowRun,
  readLatestWorkflowRun,
  readWorkflowRun,
} from "../lib/research-db"

async function activeCampaignName(root: string, args: Args) {
  const state = await readState(root)
  const campaignName = args.options.campaign ?? state.activeCampaign
  if (!campaignName) {
    throw new Error(
      "No active campaign. Pass --campaign <name> or --run <workflowRunId>."
    )
  }
  return campaignName
}

export async function commandWorkflowStatus(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const campaignName = args.options.run
    ? null
    : await activeCampaignName(root, args)
  const run = args.options.run
    ? await readWorkflowRun(root, args.options.run)
    : args.options.active === "true"
      ? await readLatestActiveWorkflowRun({
          root,
          campaignName: campaignName!,
          projectPath,
        })
      : await readLatestWorkflowRun({
          root,
          campaignName: campaignName!,
          projectPath,
        })
  if (!run) {
    throw new Error(
      args.options.run
        ? `No workflow run ${args.options.run} was found.`
        : args.options.active === "true"
          ? `No active workflow runs exist for campaign ${campaignName} in project path "${projectPath}".`
          : `No workflow runs exist for campaign ${campaignName} in project path "${projectPath}".`
    )
  }
  const steps = await listWorkflowSteps(root, run.id)
  const payload = {
    run,
    steps,
    currentStep: steps.find((step) => step.stepIndex === run.currentStepIndex),
    nextStep: steps.find((step) => step.stepIndex >= run.currentStepIndex),
  }

  if (args.options.json === "true") {
    console.log(JSON.stringify(payload, null, 2))
    return payload
  }

  console.log(`Workflow run: ${run.id}`)
  console.log(`Run ref: ${run.runRef}`)
  console.log(`Status: ${run.status}`)
  console.log(`Campaign: ${run.campaignName}`)
  console.log(`Base: ${run.baseCommitSha}`)
  console.log(`Result: ${run.resultCommitSha ?? "pending"}`)
  if (run.blockReason) console.log(`Block reason: ${run.blockReason}`)
  console.log("Steps:")
  for (const step of steps) {
    const marker = step.stepIndex === run.currentStepIndex ? "*" : "-"
    console.log(
      `${marker} ${step.stepId}: ${step.status}${step.toolId ? ` (${step.toolId})` : ""}`
    )
    if (step.outputSummary) console.log(`  ${step.outputSummary}`)
    if (step.logPath) console.log(`  log: ${step.logPath}`)
  }
  return payload
}
