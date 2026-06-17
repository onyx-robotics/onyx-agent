// Public surface barrel: keeps the `onyx` bin and tests importing from "./onyx"
// while the implementation lives in focused modules under lib/ and commands/.
export { parseArgs, type Args } from "./lib/args"
export { parseMetricLines, primaryMetric, summarizeOutput } from "./lib/metrics"
export {
  campaignStateKey,
  normalizeProjectPath,
  onyxPath,
  resolveProjectPath,
  scopedRoot,
} from "./lib/project"
export {
  appendOutbox,
  clearLastRun,
  clientRunRef,
  lastRunPath,
  onyxStateDir,
  outboxPath,
  readLastRun,
  readOutbox,
  readState,
  rewriteOutbox,
  statePath,
  writeLastRun,
  writeState,
  type CliState,
  type LastRunRecord,
} from "./lib/outbox"
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
export { flushOutbox, type FlushResult } from "./lib/sync"
export {
  currentBranch,
  currentCommit,
  gitDir,
  normalizeRepositoryUrl,
  repoRoot,
} from "./lib/git"
export {
  defaultSkillInstallRoot,
  displaySkillPath,
  installDeveloperSkill,
  installOnyxSkill,
  installReleaseSkill,
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
export { commandPush, commandStatus, commandSync } from "./commands/sync"
export {
  commandSwarmStart,
  commandSwarmStatus,
  commandWorkerRun,
} from "./commands/swarm"
export { USAGE, main } from "./main"
export {
  ONYX_LAUNCHER_BYPASS,
  defaultDevCommandRunner,
  runCli,
  runLauncher,
  type DevCommandRunner,
} from "./launcher"
