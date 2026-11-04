/** Autoresearch on this machine (src/research): its arguments are its own, flags included. */
import { research as researchMain, RESEARCH_USAGE } from "../../research/main"
import type { Command } from "../command"

export const research: Command = {
  summary: "autoresearch on this machine: setup, run, steer (onyx research help)",
  usage: RESEARCH_USAGE,
  run: (c) => researchMain(c.argv),
}
