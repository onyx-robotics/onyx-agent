import type { Args } from "./args"

export type FlushResult = {
  flushed: number
  pending: number
  offline: boolean
  skippedDeleted: number
  conflicts: number
  batches: number
  lastDurationMs: number | null
  lastError: string | null
  oldestPendingAgeMs: number | null
}

export function removedSyncCommandMessage(command = "sync") {
  return `\`onyx ${command}\` was removed in the remote-first research architecture. Research state is written directly through /api/v1, and experiment refs are pushed before each report.`
}

export async function flushOutbox(
  _root: string,
  _args: Args,
  _options: { quiet?: boolean; maxBatches?: number } = {}
): Promise<FlushResult> {
  void _root
  void _args
  void _options
  return {
    flushed: 0,
    pending: 0,
    offline: false,
    skippedDeleted: 0,
    conflicts: 0,
    batches: 0,
    lastDurationMs: 0,
    lastError: null,
    oldestPendingAgeMs: null,
  }
}
