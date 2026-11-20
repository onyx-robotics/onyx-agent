/**
 * Each endpoint's time limit per experiment in this campaign: a hard cutoff, in seconds. The run
 * holds it (in its directory), and every experiment it sends carries it (`time_limit_s` in the
 * job's props) to the endpoint's driver, which stops the experiment there: the platform and a
 * site's runner only pass it on. It starts as the endpoint's `timeoutS` in the config, and the
 * user or the orchestrator can change it during the run (`onyx research limit`).
 */
import type { LoadedConfig } from "./config"
import type { RunDir } from "./state"

const FILE = "limits.json"

export function timeLimits(run: RunDir, cfg: LoadedConfig): Record<string, number> {
  const set = run.read<Record<string, number>>(FILE) ?? {}
  return Object.fromEntries(cfg.endpoints.map((e) => [e.type, set[e.type] ?? e.timeoutS]))
}

/** One endpoint's limit, for the experiments sent from now on: what it was, and is now. */
export function setTimeLimit(run: RunDir, cfg: LoadedConfig, endpoint: string, seconds: number) {
  if (!cfg.endpoints.some((e) => e.type === endpoint))
    throw new Error(
      `no endpoint ${endpoint}: one of ${cfg.endpoints.map((e) => e.type).join(", ")}`
    )
  const was = timeLimits(run, cfg)[endpoint]!
  run.write(FILE, { ...(run.read<Record<string, number>>(FILE) ?? {}), [endpoint]: seconds })
  return { was, now: seconds }
}

/** The limits as agents read them. */
export function limitsText(limits: Record<string, number>): string {
  return Object.entries(limits)
    .map(([type, s]) => `\`${type}\` ${s} s`)
    .join(", ")
}
