/**
 * A project's research config (`onyx/research.json` in its repository): what to improve, how
 * it's measured, where experiments run, and the agents' models. Written at setup, by the base
 * agent with the user (docs/research.md, "Setup").
 */
import { readFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

import { z } from "zod"

const endpoint = z.object({
  /** the unit type its runner offers (a subtype of research_endpoint, from the project's pack) */
  type: z.string().min(1),
  /** what it's for, in a line */
  label: z.string().min(1),
  /** a short guide for workers: what a packet is, what it measures, how long it takes (repo path) */
  guide: z.string().min(1),
  /**
   * the driver, run in a checkout of the experiment's commit with the packet's path appended. It
   * prints its log; a last line `METRICS {json}` carries the metrics (property keys)
   */
  driver: z.string().min(1),
  /** how many experiments it runs at once */
  capacity: z.number().int().min(1).max(64).default(1),
  /** give up on an experiment after this long */
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
  /** a quick metric evaluation workers run on their code before they commit it */
  evaluate: z.string().min(1),
  /** the metrics that matter, as property keys, each with its direction */
  metrics: z
    .array(z.object({ key: z.string().min(1), better: z.enum(["higher", "lower"]) }))
    .min(1),
  endpoints: z.array(endpoint).min(1),
  models: z
    .object({
      base: z.string().default("opus"),
      varop: z.string().default("sonnet"),
      worker: z.string().default("sonnet"),
      ghost: z.string().default("haiku"),
    })
    .default({ base: "opus", varop: "sonnet", worker: "sonnet", ghost: "haiku" }),
  workers: z.number().int().min(1).max(64).default(2),
  /** experiments a worker may run on one hypothesis */
  experimentsPerTask: z.number().int().min(1).max(20).default(3),
  /** stop proposing after this long; what's running is let finish */
  minutes: z.number().min(1).max(10_080).default(30),
})
export type ResearchConfig = z.infer<typeof researchConfig>

export interface LoadedConfig extends ResearchConfig {
  /** the repository's root (the config is at <root>/onyx/research.json) */
  root: string
  path: string
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
