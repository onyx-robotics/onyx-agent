/**
 * A project's research config (`onyx/research.json` in its repository): what to improve, how
 * it's measured, where experiments run, and the agents' models. Written at setup, by the base
 * agent with the user (docs/research.md, "Setup").
 */
import { readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

import { z } from "zod"

import { AGENT_CLIS, DEFAULT_AGENT, type AgentModelRole } from "./agents"

const endpoint = z.object({
  /**
   * the unit type its runner offers, `<pack>.<name>`: declared in the org as a research_endpoint
   * when the run starts, if it isn't there
   */
  type: z.string().min(1),
  /** what it's for, in a line (the type's description, when the run declares it) */
  label: z.string().min(1),
  /** a short guide for workers: what a packet is, what it measures, how long it takes (repo path) */
  guide: z.string().min(1),
  /**
   * the driver, run in a checkout of the experiment's commit with the packet's path appended. It
   * prints its log; a last line `METRICS {json}` carries the metrics (property keys). Unused for a
   * site's endpoint
   */
  driver: z.string().default(""),
  /**
   * run by a site (docs/jobs.md, "Personal runners": a site takes anyone's jobs, a run's too), not
   * by this run's supervisor: it doesn't offer the unit, the site fetches the experiment's commit
   * from `remote` (its `git` prop), and the result is read from the experiment's record
   */
  site: z.boolean().default(false),
  /** how many experiments it runs at once */
  capacity: z.number().int().min(1).max(64).default(1),
  /**
   * the time limit for each experiment on it, in seconds, as the run starts: a hard cutoff sent with
   * every experiment to the driver (`time_limit_s`). The user or the orchestrator can change it
   * during the run (`onyx research limit`), for that run only
   */
  timeoutS: z.number().int().min(10).max(86_400).default(1800),
})

export const researchConfig = z.object({
  /** the run's name, and the campaign it's recorded under */
  name: z.string().min(1).max(200),
  /** what to improve, for every agent */
  goal: z.string().min(1).max(8000),
  /** the git remote experiments are pushed to and endpoints fetch from */
  remote: z.string().min(1),
  /** the branch runs start from */
  baseBranch: z.string().min(1).default("main"),
  /** what workers may edit (repo paths); the rest is read only to them */
  editable: z.array(z.string().min(1)).min(1),
  /**
   * what defines how results are measured (repo paths: drivers, evaluators, their data). It
   * changes only in a measurement hypothesis (`propose --measurement`), and each experiment records
   * which measurement it ran with, so results measured differently are never compared
   */
  measurement: z.array(z.string().min(1)).default(["onyx/endpoints"]),
  /**
   * every metric its endpoints report, as property keys (`<pack>.<name>`, or a built-in one), each
   * with its direction; declared in the org when the run starts, if it isn't there
   */
  metrics: z
    .array(
      z.object({
        key: z.string().min(1),
        better: z.enum(["higher", "lower"]),
        label: z.string().min(1).optional(),
        unit: z.string().min(1).optional(),
      })
    )
    .min(1),
  endpoints: z
    .array(endpoint)
    .min(1)
    .refine((eps) => eps.every((e) => e.site || e.driver), "an endpoint needs a driver, or site"),
  /**
   * the coding agent the run's agents are sessions of, signed in on this machine: one of
   * AGENT_CLIS (claude: Claude Code)
   */
  agent: z
    .string()
    .default(DEFAULT_AGENT)
    .refine((a) => a in AGENT_CLIS, {
      message: `agent: one of ${Object.keys(AGENT_CLIS).join(", ")}`,
    }),
  /** each agent's model; one left out is its CLI's choice for it (modelFor) */
  models: z
    .object({
      base: z.string().min(1).optional(),
      varop: z.string().min(1).optional(),
      worker: z.string().min(1).optional(),
      ghost: z.string().min(1).optional(),
    })
    .default({}),
  workers: z.number().int().min(1).max(64).default(2),
  /**
   * A safety ceiling on the experiments one worker runs for its hypothesis, not a budget: a worker
   * keeps going until it has a proper insight (the hypothesis answered), and stops there.
   */
  experimentsPerTask: z.number().int().min(1).max(20).default(10),
  /** stop proposing after this long; what's running is let finish */
  minutes: z.number().min(1).max(10_080).default(30),
})
export type ResearchConfig = z.infer<typeof researchConfig>

/** A role's model: the config's, else its CLI's for that role; unset is the CLI's own default. */
export function modelFor(
  cfg: Pick<ResearchConfig, "agent" | "models">,
  role: AgentModelRole
): string | undefined {
  return cfg.models[role] ?? AGENT_CLIS[cfg.agent]?.models[role]
}

export interface LoadedConfig extends ResearchConfig {
  /** the repository's root (the config is at <root>/onyx/research.json) */
  root: string
  path: string
}

const humanize = (key: string) => {
  const s = key.replace(/[._]/g, " ")
  return s[0]!.toUpperCase() + s.slice(1)
}

/**
 * What the config's endpoints and metrics need in the org's registry (each declared only if it
 * isn't there: `extendRegistry` leaves what exists as it is).
 */
export function vocabularyOf(cfg: ResearchConfig) {
  return {
    types: cfg.endpoints
      .filter((e, i, all) => all.findIndex((x) => x.type === e.type) === i)
      .map((e) => ({
        key: e.type,
        kind: "asset" as const,
        parent: "research_endpoint",
        label: humanize(e.type),
        description: e.label,
      })),
    properties: cfg.metrics.map((m) => ({
      key: m.key,
      label: m.label ?? humanize(m.key.split(".").pop()!),
      type: "number" as const,
      unit: m.unit,
      metric: true,
      better: m.better,
    })),
  }
}

export function loadConfig(path: string): LoadedConfig {
  const abs = resolve(path)
  const cfg = researchConfig.parse(JSON.parse(readFileSync(abs, "utf8")))
  const root = resolve(dirname(abs), "..")
  return {
    ...cfg,
    remote:
      isAbsolute(cfg.remote) || cfg.remote.includes(":") ? cfg.remote : resolve(root, cfg.remote),
    root,
    path: abs,
  }
}
