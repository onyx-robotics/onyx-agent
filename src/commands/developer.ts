import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

import type {
  DeveloperCheckout,
  DeveloperConfig,
  DeveloperMode,
} from "../lib/config"

import { type Args } from "../lib/args"
import {
  apiTarget,
  describeApiTarget,
  readConfig,
  writeConfig,
} from "../lib/config"
import { pathExists } from "../lib/process"
import {
  defaultSkillInstallRoot,
  installDeveloperSkill,
  installReleaseSkill,
  skillInstallTarget,
} from "../lib/skill"

export const DEVELOPER_USAGE = `Usage:
  onyx developer status
  onyx developer link [path]
  onyx developer use dev [--skill-dir <path>] [--quiet]
  onyx developer use release [--skill-dir <path>] [--quiet]
  onyx developer sync-skill [--skill-dir <path>] [--quiet]
  onyx developer unlink [--skill-dir <path>] [--quiet]`

function developerConfig(config: { developer?: DeveloperConfig }) {
  return config.developer ?? { mode: "release" as const }
}

function isQuiet(args: Args) {
  return args.options.quiet === "true"
}

function skillDirOption(args: Args) {
  return args.options["skill-dir"]
}

async function existingPath(path: string) {
  return pathExists(path)
}

export async function detectDeveloperCheckout(
  path = "."
): Promise<DeveloperCheckout> {
  const inputRoot = await realpath(resolve(path))
  const candidates: DeveloperCheckout[] = [
    {
      root: inputRoot,
      binPath: join(inputRoot, "bin", "onyx.js"),
      skillPath: join(inputRoot, "skills", "onyx", "SKILL.md"),
    },
    {
      root: inputRoot,
      binPath: join(inputRoot, "packages", "agent", "bin", "onyx.js"),
      skillPath: join(
        inputRoot,
        "packages",
        "agent",
        "skills",
        "onyx",
        "SKILL.md"
      ),
    },
  ]

  for (const candidate of candidates) {
    if (
      (await existingPath(candidate.binPath)) &&
      (await existingPath(candidate.skillPath))
    ) {
      return candidate
    }
  }

  throw new Error(
    `No Onyx agent checkout found at ${inputRoot}. Expected either bin/onyx.js plus skills/onyx/SKILL.md, or packages/agent/bin/onyx.js plus packages/agent/skills/onyx/SKILL.md.`
  )
}

export async function validateDeveloperCheckout(checkout: DeveloperCheckout) {
  if (!(await existingPath(checkout.binPath))) {
    throw new Error(
      `Developer mode is linked to ${checkout.root}, but the CLI entrypoint is missing: ${checkout.binPath}. Run \`onyx developer link <path>\` again or switch back with \`onyx developer use release\`.`
    )
  }
  if (!(await existingPath(checkout.skillPath))) {
    throw new Error(
      `Developer mode is linked to ${checkout.root}, but the skill file is missing: ${checkout.skillPath}. Run \`onyx developer link <path>\` again or switch back with \`onyx developer use release\`.`
    )
  }
}

async function readDeveloperConfig() {
  const config = await readConfig()
  return developerConfig(config)
}

async function apiTargetLine(args?: Args) {
  const target = await apiTarget(args)
  return target
    ? describeApiTarget(target)
    : "not configured (run `onyx login`)"
}

async function writeDeveloperConfig(developer: DeveloperConfig) {
  const config = await readConfig()
  await writeConfig({ ...config, developer })
}

export async function linkedDeveloperCheckout() {
  const developer = await readDeveloperConfig()
  const checkout = developer.checkout
  if (!checkout) {
    throw new Error(
      "No developer checkout linked. Run `onyx developer link <path>` first."
    )
  }
  await validateDeveloperCheckout(checkout)
  return checkout
}

async function syncSkill({
  mode,
  checkout,
  skillDir,
  quiet,
}: {
  mode: DeveloperMode
  checkout?: DeveloperCheckout
  skillDir?: string
  quiet?: boolean
}) {
  if (mode === "dev") {
    if (!checkout) {
      throw new Error(
        "No developer checkout linked. Run `onyx developer link <path>` first."
      )
    }
    await validateDeveloperCheckout(checkout)
    return installDeveloperSkill({
      source: checkout.skillPath,
      dir: skillDir,
      quiet,
    })
  }

  return installReleaseSkill({ dir: skillDir, quiet })
}

export async function commandDeveloper(args: Args) {
  const sub = args.positional[1]

  if (sub === "link") {
    const checkout = await detectDeveloperCheckout(args.positional[2] ?? ".")
    const current = await readDeveloperConfig()
    if (current.mode === "dev") {
      await syncSkill({ mode: "dev", checkout, quiet: isQuiet(args) })
    }
    await writeDeveloperConfig({ ...current, checkout })
    if (!isQuiet(args)) {
      console.log(`Linked developer checkout: ${checkout.root}`)
      console.log(`CLI: ${checkout.binPath}`)
      console.log(`Skill: ${checkout.skillPath}`)
      if (current.mode === "dev") {
        console.log("Developer mode is active; synced the managed skill.")
      } else {
        console.log("Run `onyx developer use dev` to activate it.")
      }
    }
    return
  }

  if (sub === "use") {
    const mode = args.positional[2]
    if (mode !== "dev" && mode !== "release") {
      throw new Error(DEVELOPER_USAGE)
    }

    const current = await readDeveloperConfig()
    const checkout =
      mode === "dev"
        ? current.checkout ?? (await linkedDeveloperCheckout())
        : current.checkout
    await syncSkill({
      mode,
      checkout,
      skillDir: skillDirOption(args),
      quiet: isQuiet(args),
    })
    await writeDeveloperConfig({ mode, ...(checkout ? { checkout } : {}) })
    if (!isQuiet(args)) {
      console.log(`Using ${mode} Onyx CLI mode.`)
      console.log(
        "Restart or reload active agent sessions if they cache skill files."
      )
      if (mode === "dev") {
        console.log(
          "Developer mode changes which CLI source runs, not which app it targets."
        )
        console.log(`API target: ${await apiTargetLine(args)}`)
        console.log("To log to a locally running app: onyx login --local")
      }
    }
    return
  }

  if (sub === "sync-skill") {
    const current = await readDeveloperConfig()
    await syncSkill({
      mode: current.mode,
      checkout: current.checkout,
      skillDir: skillDirOption(args),
      quiet: isQuiet(args),
    })
    if (!isQuiet(args)) {
      console.log(`Synced ${current.mode} Onyx agent skill.`)
    }
    return
  }

  if (sub === "unlink") {
    await syncSkill({
      mode: "release",
      skillDir: skillDirOption(args),
      quiet: isQuiet(args),
    })
    await writeDeveloperConfig({ mode: "release" })
    if (!isQuiet(args)) {
      console.log("Unlinked developer checkout and restored release mode.")
      console.log(
        "Restart or reload active agent sessions if they cache skill files."
      )
    }
    return
  }

  if (sub === "status") {
    const current = await readDeveloperConfig()
    console.log(`Mode: ${current.mode}`)
    console.log(`API target: ${await apiTargetLine(args)}`)
    console.log(`Skill target: ${skillInstallTarget(defaultSkillInstallRoot())}`)
    if (current.checkout) {
      console.log(`Developer checkout: ${current.checkout.root}`)
      console.log(`Developer CLI: ${current.checkout.binPath}`)
      console.log(`Developer skill: ${current.checkout.skillPath}`)
    } else {
      console.log("Developer checkout: none")
    }
    return
  }

  throw new Error(DEVELOPER_USAGE)
}
