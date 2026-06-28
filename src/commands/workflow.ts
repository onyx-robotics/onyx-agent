import type { Args } from "../lib/args"
import { repoRoot } from "../lib/git"
import { resolveProjectPath } from "../lib/project"
import {
  listWorkflowSteps,
  listWorkflowRuns,
  readLatestActiveWorkflowRun,
  readLatestBlockedWorkflowRun,
  readLatestWorkflowRun,
  readWorkflowRun,
  type LocalWorkflowRun,
  type LocalWorkflowRunStatus,
} from "../lib/research-runtime"
import {
  resolveCampaignNameFromContext,
  resolveWorkerWorkflowContext,
  type WorkerWorkflowContext,
} from "../lib/workflow-context"

async function activeCampaignName(root: string, args: Args) {
  return resolveCampaignNameFromContext(
    root,
    args,
    "No active campaign. Pass --campaign <name> or --run <workflowRunId>."
  )
}

function statusFilter(args: Args): LocalWorkflowRunStatus[] | undefined {
  if (args.options.blocked === "true") return ["blocked"]
  if (args.options.active === "true") return ["running", "paused"]
  return undefined
}

function workflowRunLine(run: LocalWorkflowRun) {
  return `- ${run.id}: ${run.status}, runRef ${run.runRef}, worker ${run.workerId ?? "none"}, hypothesis ${run.hypothesisId ?? "none"}`
}

async function readWorkerScopedWorkflowRun({
  root,
  args,
  campaignName,
  projectPath,
  context,
}: {
  root: string
  args: Args
  campaignName: string
  projectPath: string
  context: WorkerWorkflowContext
}) {
  if (!context.workerId) return null
  const statuses = statusFilter(args)
  const runs = await listWorkflowRuns(root, {
    campaignName,
    projectPath,
    sessionId: context.sessionId,
    workerId: context.workerId,
    hypothesisId: context.hypothesisId,
    statuses,
  })
  if (
    (args.options.active === "true" || args.options.blocked === "true") &&
    runs.length > 1
  ) {
    throw new Error(
      [
        `Worker ${context.workerId} has ${runs.length} matching workflow runs; pass --run <workflowRunId> to choose explicitly.`,
        runs.map(workflowRunLine).join("\n"),
      ].join("\n")
    )
  }
  return runs[0] ?? null
}

export async function commandWorkflowStatus(args: Args) {
  const root = await repoRoot(args.options.cwd)
  const projectPath = await resolveProjectPath(root, args)
  const campaignName = args.options.run
    ? null
    : await activeCampaignName(root, args)
  const context = resolveWorkerWorkflowContext(args)
  const shouldUseWorkerScope = Boolean(!args.options.run && context.workerId)
  const workerScopedRun =
    !shouldUseWorkerScope || !campaignName
      ? null
      : await readWorkerScopedWorkflowRun({
          root,
          args,
          campaignName,
          projectPath,
          context,
        })
  const run = args.options.run
    ? await readWorkflowRun(root, args.options.run)
    : shouldUseWorkerScope
      ? workerScopedRun
      : args.options.blocked === "true"
        ? await readLatestBlockedWorkflowRun({
            root,
            campaignName: campaignName!,
            projectPath,
          })
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
        : args.options.blocked === "true"
          ? `No blocked workflow runs exist for campaign ${campaignName} in project path "${projectPath}".`
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
