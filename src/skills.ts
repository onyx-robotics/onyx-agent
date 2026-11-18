// the .md imports' types, for every project that compiles this file (apps/web does, through the CLI)
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./text.d.ts" />
/**
 * The package's skills (skills/), as text in the program: `onyx setup` writes them out, so a
 * binary with no files beside it installs them too.
 */
import researchSetupSkill from "../skills/onyx-research-setup/SKILL.md" with { type: "text" }
import onyxSkill from "../skills/onyx/SKILL.md" with { type: "text" }

/** The package's skills, by path under a skills folder. */
export const SKILLS: Record<string, string> = {
  "onyx/SKILL.md": onyxSkill,
  "onyx-research-setup/SKILL.md": researchSetupSkill,
}
