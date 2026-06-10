import type { Args } from "../lib/args"
import { normalizeProfileName, readConfig, writeConfig } from "../lib/config"

const API_KEY_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

export async function commandProfile(args: Args) {
  const sub = args.positional[1]

  if (sub === "list") {
    return commandProfileList()
  }

  if (sub === "use") {
    return commandProfileUse(args)
  }

  if (sub === "delete") {
    return commandProfileDelete(args)
  }

  if (sub === "set-api-key-env") {
    return commandProfileSetApiKeyEnv(args)
  }

  throw new Error(
    "Usage: onyx profile list | onyx profile use <name> | onyx profile delete <name> | onyx profile set-api-key-env <name> <ENV_VAR>"
  )
}

export async function commandProfileList() {
  const config = await readConfig()
  const entries = Object.entries(config.profiles).sort(([left], [right]) =>
    left.localeCompare(right)
  )

  if (entries.length === 0) {
    console.log("No profiles. Run `onyx login`.")
    return
  }

  for (const [name, profile] of entries) {
    const marker = name === config.currentProfile ? "*" : " "
    const credentialSource = profile.apiKeyEnv
      ? `env:${profile.apiKeyEnv} (${
          process.env[profile.apiKeyEnv]?.trim() ? "set" : "missing"
        })`
      : profile.apiKey
        ? "stored key"
        : "missing key"
    console.log(
      `${marker} ${name}\t${profile.teamName}\t${profile.teamId}\t${profile.apiUrl}\t${credentialSource}`
    )
  }
}

export async function commandProfileUse(args: Args) {
  const requested = args.positional[2]
  if (!requested) {
    throw new Error("Usage: onyx profile use <name>")
  }

  const name = normalizeProfileName(requested)
  if (!name) {
    throw new Error("Profile name must contain at least one letter or number")
  }

  const config = await readConfig()
  if (!config.profiles[name]) {
    throw new Error(`Unknown Onyx CLI profile "${name}".`)
  }

  await writeConfig({
    ...config,
    currentProfile: name,
  })
  console.log(`Using profile ${name}`)
}

export async function commandProfileDelete(args: Args) {
  const requested = args.positional[2]
  if (!requested) {
    throw new Error("Usage: onyx profile delete <name>")
  }

  const name = normalizeProfileName(requested)
  if (!name) {
    throw new Error("Profile name must contain at least one letter or number")
  }

  const config = await readConfig()
  if (!config.profiles[name]) {
    throw new Error(`Unknown Onyx CLI profile "${name}".`)
  }

  const profiles = { ...config.profiles }
  delete profiles[name]
  const currentProfile =
    config.currentProfile === name ? "" : config.currentProfile

  await writeConfig({
    ...config,
    profiles,
    currentProfile,
  })

  if (currentProfile) {
    console.log(`Deleted profile ${name}`)
  } else {
    console.log(`Deleted profile ${name}. No profile selected.`)
  }
}

export async function commandProfileSetApiKeyEnv(args: Args) {
  const requested = args.positional[2]
  const envVarName = args.positional[3]
  if (!requested || !envVarName) {
    throw new Error("Usage: onyx profile set-api-key-env <name> <ENV_VAR>")
  }

  const name = normalizeProfileName(requested)
  if (!name) {
    throw new Error("Profile name must contain at least one letter or number")
  }

  if (!API_KEY_ENV_NAME.test(envVarName)) {
    throw new Error("Environment variable name must match /^[A-Z_][A-Z0-9_]*$/")
  }

  const config = await readConfig()
  const profile = config.profiles[name]
  if (!profile) {
    throw new Error(`Unknown Onyx CLI profile "${name}".`)
  }

  const nextProfile = {
    ...profile,
    apiKeyEnv: envVarName,
    updatedAt: new Date().toISOString(),
  }
  delete nextProfile.apiKey

  await writeConfig({
    ...config,
    profiles: {
      ...config.profiles,
      [name]: nextProfile,
    },
  })
  console.log(`Profile ${name} now reads its API key from ${envVarName}`)
}
