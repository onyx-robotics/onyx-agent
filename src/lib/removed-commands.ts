export function removedResearchSyncCommandMessage(command: string) {
  return `\`onyx ${command}\` was removed in the remote-first research architecture. Research state now writes directly to the Onyx API, immutable experiment refs are pushed by the worker/reporting flow, and there is no local sync queue to flush.`
}
