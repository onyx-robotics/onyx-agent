// the .md imports' types, for every project that compiles this file (apps/web does, through the CLI)
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./text.d.ts" />
/**
 * The package's skills (skills/), as text in the program: `onyx setup` writes them out, so a
 * binary with no files beside it installs them too.
 */
import researchBaseSkill from "../skills/onyx-research-base/SKILL.md" with { type: "text" }
import researchSetupSkill from "../skills/onyx-research-setup/SKILL.md" with { type: "text" }
import researchVaropSkill from "../skills/onyx-research-varop/SKILL.md" with { type: "text" }
import researchWorkerSkill from "../skills/onyx-research-worker/SKILL.md" with { type: "text" }
import onyxSkill from "../skills/onyx/SKILL.md" with { type: "text" }

/** The package's skills, by path under a skills folder. */
export const SKILLS: Record<string, string> = {
  "onyx/SKILL.md": onyxSkill,
  "onyx-research-setup/SKILL.md": researchSetupSkill,
  // a research run's own agents: `onyx research` builds each into its agent's first message
  "onyx-research-base/SKILL.md": researchBaseSkill,
  "onyx-research-varop/SKILL.md": researchVaropSkill,
  "onyx-research-worker/SKILL.md": researchWorkerSkill,
}
