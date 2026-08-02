// Public surface barrel: keeps the `onyx` bin and tests importing from "./onyx"
// while the implementation lives in focused modules under lib/ and commands/.
export { parseArgs, type Args } from "./lib/args"
export {
  parseMetricLines,
  parseWorkflowMetricLines,
  primaryMetric,
  summarizeOutput,
} from "./lib/metrics"
export {
  campaignStateKey,
  normalizeProjectPath,
  onyxPath,
  resolveProjectPath,
  scopedRoot,
} from "./lib/project"
export {
  onyxStateDir,
  readState,
  updateState,
  statePath,
  writeState,
  withOnyxLock,
  type CliState,
} from "./lib/runtime-state"
export {
  appendHistory,
  apiExperimentToHistory,
  applyHistorySyncUpdates,
  experimentRecordToHistory,
  historyPath,
  hydrateHistoryFromApi,
  mergeHistory,
  readHistory,
  rewriteHistory,
  type HistorySyncUpdate,
  type HydrateResult,
} from "./lib/history"
export { emitEvent, eventsPath, readEvents, truncateEvents } from "./lib/events"
export {
  formatAge,
  formatMetricCell,
  formatMetricValue,
  pad,
  renderExperimentTable,
  renderFrame,
  spinnerChar,
  stripAnsi,
  truncate,
  truncateAnsi,
  type ExperimentRow,
  type ListenModel,
} from "./lib/tui"
export {
  currentBranch,
  currentCommit,
  gitCommonDir,
  gitDir,
  normalizeRepositoryUrl,
  repoRoot,
} from "./lib/git"
export {
  assertSetupCommitted,
  protectedSetupRepoPaths,
  requiredSetupRepoPaths,
  setupRepoPath,
} from "./lib/setup-git"
export {
  buildWorkerInvocation,
  preflightWorkerInvocation,
  readWorkerLaunchManifests,
  workerRuntimeEnvironment,
  workerRuntimePaths,
  workerGitWritableRoots,
  workerLaunchPaths,
  writeWorkerCliWrapper,
  writeWorkerLaunchManifest,
  writeWorkerRuntimeContext,
  type WorkerInvocation,
  type WorkerLaunchManifest,
} from "./lib/worker-launcher"
export {
  claudeSkillInstallRoot,
  codexHomeSkillInstallRoot,
  codexUserSkillInstallRoot,
  defaultSkillInstallRoot,
  defaultSkillInstallTargets,
  displaySkillPath,
  installDeveloperSkill,
  installOnyxSkill,
  installReleaseSkill,
  opencodeSkillInstallRoot,
  packagedSkillPath,
  readPackagedSkill,
  skillInstallTarget,
} from "./lib/skill"
export * from "./protocol"
export {
  commandDeveloper,
  detectDeveloperCheckout,
  linkedDeveloperCheckout,
  validateDeveloperCheckout,
} from "./commands/developer"
export { commandAgent } from "./commands/agent"
export { commandLogin } from "./commands/login"
export {
  commandProfile,
  commandProfileDelete,
  commandProfileList,
  commandProfileSetApiKeyEnv,
  commandProfileUse,
} from "./commands/profile"
export {
  commandCampaignCreate,
  commandCampaignDelete,
  commandCampaignStatus,
  commandCampaignUse,
} from "./commands/campaign"
export { commandExpList, commandExpLog, commandExpRun } from "./commands/exp"
export { commandListen } from "./commands/listen"
export { commandStatus } from "./commands/status"
export { commandToolsRun } from "./commands/tools"
export {
  commandResearchBrief,
  commandResearchHypothesisAdd,
  commandResearchHypotheses,
  commandResearchSessionStateBrief,
  commandResearchRun,
  commandResearchStatus,
  commandResearchStop,
  commandKnowledgeAdd,
  commandKnowledgeList,
  teardownStatusLabel,
  teardownHypothesisAttempt,
  summarizeWorkerOutput,
  commandWorkerRun,
} from "./commands/research"
export { commandSetupInit, commandSetupValidate } from "./commands/setup"
export { commandWorkflowStatus } from "./commands/workflow"
export { commandTelemetry } from "./commands/telemetry"
export {
  normalizeSetupFile,
  normalizeValidationFile,
  readSetupFile,
  readValidationFile,
  setupHash,
  setupPath,
  validationMatchesSetup,
  validationPath,
  writeSetupFile,
  writeValidationFile,
  type ResearchSetupFile,
  type ResearchSetupId,
  type ResearchSetupValidationFile,
} from "./lib/contract"
export {
  protectedToolPaths,
  resolveToolApiPath,
  runToolCommand,
  type ToolApi,
  type ToolCommand,
  type ToolRunResult,
} from "./lib/tools"
export { USAGE, main } from "./main"
export { WORKER_USAGE, workerMain } from "./worker-main"
export {
  ONYX_WORKER_CONTEXT,
  parseWorkerRuntimeContext,
  readWorkerRuntimeContext,
  resolveWorkerScope,
  type WorkerRuntimeContext,
} from "./lib/worker-context"
export {
  ONYX_LAUNCHER_BYPASS,
  defaultDevCommandRunner,
  runCli,
  runLauncher,
  runWorkerCli,
  type DevCommandRunner,
} from "./launcher"
