/**
 * What each agent of a run is told. A role's instructions are its skill (`skills/onyx-research-*`),
 * built into the onyx command as text (`skills.ts`), so a skill file is the one place a role is
 * written; this adds only facts. The base agent's first message is its skill and the run's brief
 * (the goal, the metrics, what's editable and what measures, each endpoint with its guide and time
 * limit). Every other agent is a fork of the base agent's session, so it already has the brief: its
 * first message is its own skill and its task (a worker's hypothesis, the var-op's wake).
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { SKILLS } from "../skills"

import type { LoadedConfig } from "./config"
import { limitsText } from "./limits"

const BASE_SKILL = SKILLS["onyx-research-base/SKILL.md"]!
const VAROP_SKILL = SKILLS["onyx-research-varop/SKILL.md"]!
const WORKER_SKILL = SKILLS["onyx-research-worker/SKILL.md"]!

/** Where a worker writes its experiments' packets, in its worktree, beside the editable paths. */
export const PACKETS_DIR = "onyx/packets"

/** A skill's instructions: its text without the front matter that names it to Claude Code. */
export function skillBody(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .trim()
}

function guide(c: LoadedConfig, path: string): string {
  const p = join(c.root, path)
  return existsSync(p)
    ? readFileSync(p, "utf8").replace(/\r\n/g, "\n").trim()
    : `(no guide at ${path})`
}

/** The run's brief: the facts every agent of the run works from. */
export function runBrief(c: LoadedConfig): string {
  const metrics = c.metrics.map(
    (m) =>
      `- \`${m.key}\`: ${m.better} is better${m.label ? ` (${m.label}${m.unit ? `, ${m.unit}` : ""})` : ""}`
  )
  const endpoints = c.endpoints.map(
    (e) =>
      `- \`${e.type}\`: ${e.label}. Runs ${e.capacity} at a time${e.site ? ", on a site" : ""}. Time limit per experiment: ${e.timeoutS} s, a hard cutoff (it can change during the run: you'll be told).\n\n<guide endpoint="${e.type}" path="${e.guide}">\n${guide(c, e.guide)}\n</guide>`
  )
  return `# The run's brief

**Goal:** ${c.goal}

**Metrics:**
${metrics.join("\n")}

**Editable:** ${c.editable.map((p) => `\`${p}\``).join(", ")}. Workers write experiments' packets in \`${PACKETS_DIR}/\`. Everything else is read only.

**Measurement:** ${c.measurement.map((p) => `\`${p}\``).join(", ")} define how results are measured. They change only in a measurement hypothesis.


**Workers:** ${c.workers} slots. At most ${c.experimentsPerTask} experiments per hypothesis. The run proposes for ${c.minutes} minutes.

**Endpoints:**

${endpoints.join("\n\n")}`
}

export function basePrompt(c: LoadedConfig): string {
  return `You are the base agent of an autoresearch run on this repository. How to work:

${skillBody(BASE_SKILL)}

${runBrief(c)}`
}

/** The var-op's wake: a fresh fork of the base agent, told its role and what the wake shows it. */
export function varopPrompt(wake: string): string {
  return `You are now the variational operator of this run. The run's brief is above, in the base agent's first message. How to work:

${skillBody(VAROP_SKILL)}

# This wake

${wake}`
}

export function workerPrompt(w: {
  hypothesis: string
  why: string
  baseCommit: string
  worktree: string
  cited: string
  related: string
  /** a measurement hypothesis: the measurement paths its worker may change */
  measurement?: string[]
  /** each endpoint's time limit per experiment now */
  limits: Record<string, number>
}): string {
  return `You are now a worker of this run. The run's brief is above, in the base agent's first message. How to work:

${skillBody(WORKER_SKILL)}

# Your hypothesis

**${w.hypothesis}**

Why: ${w.why}

Your worktree is ${w.worktree}, a branch at commit ${w.baseCommit}, and your working directory.

Time limit per experiment now: ${limitsText(w.limits)}.
${w.measurement ? `\nThis is a measurement hypothesis: you may change the measurement (${w.measurement.join(", ")}) as well as the editable paths.\n` : ""}${w.cited ? `\nIt builds on these insights:\n${w.cited}\n` : ""}${w.related ? `\nRelated insights from the knowledge graph (\`onyx research ask <id> "<question>"\` asks their author):\n${w.related}\n` : ""}`
}

export function ghostPrompt(name: string, state: string, question: string): string {
  return `You are the ghost of ${name}, a worker of this run that has finished. This was its state when it stopped:

${state}

Answer this question from what it knew, briefly and with numbers where it had them. If it didn't know, say so; don't guess.

Question: ${question}`
}
