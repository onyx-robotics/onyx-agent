import { optionalFlag, type Args } from "../lib/args"
import { displaySkillPath, installOnyxSkill } from "../lib/skill"

export async function commandAgent(args: Args) {
  const sub = args.positional[1]

  if (sub === "skill-path") {
    console.log(await displaySkillPath())
    return
  }

  if (sub === "install-skill") {
    await installOnyxSkill({
      dir: args.options.dir,
      quiet: optionalFlag(args, "quiet"),
    })
    return
  }

  throw new Error(
    "Usage: onyx agent skill-path | onyx agent install-skill [--dir <path>] [--quiet]"
  )
}
