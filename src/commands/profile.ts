import type { Args } from "../lib/args"
import {
  BUILT_IN_WORKER_AGENTS,
  normalizeProfileName,
  normalizeWorkerModel,
  readConfig,
  validateBuiltInWorkerAgent,
  writeConfig,
  type BuiltInWorkerAgent,
  type CliProfile,
  type WorkerProfileConfig,
} from "../lib/config"

const API_KEY_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const PROFILE_USAGE =
  "Usage: onyx profile list | onyx profile use <name> | onyx profile delete <name> | onyx profile set-api-key-env <name> <ENV_VAR> | onyx profile worker get [profile] | onyx profile worker set [profile] --agent codex|claude|opencode [--model <model>] | onyx profile worker clear [profile] (--all | --agent | --model codex|claude|opencode)"

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

  if (sub === "worker") {
    return commandProfileWorker(args)
  }

  throw new Error(PROFILE_USAGE)
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
      `${marker} ${name}\t${profile.teamName}\t${profile.teamId}\t${profile.apiUrl}\t${credentialSource}\t${workerListSummary(profile)}`
    )
  }
}

function workerListSummary(profile: CliProfile) {
  const worker = profile.worker
  const agent = worker?.agent ?? "codex"
  const parts = [`worker:${worker?.agent ? agent : `${agent} (default)`}`]
  const selectedModel = worker?.models?.[agent]
  if (selectedModel) parts.push(`model=${selectedModel}`)
  const otherModels = BUILT_IN_WORKER_AGENTS.flatMap((workerAgent) => {
    if (workerAgent === agent) return []
    const model = worker?.models?.[workerAgent]
    return model ? [`${workerAgent}=${model}`] : []
  })
  if (otherModels.length > 0) parts.push(`models:${otherModels.join(",")}`)
  return parts.join(" ")
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

function workerProfileName(args: Args) {
  return args.positional[3]
}

function workerProfileOrCurrent({
  requested,
  currentProfile,
}: {
  requested?: string
  currentProfile: string
}) {
  if (requested) {
    const name = normalizeProfileName(requested)
    if (!name) throw new Error("Profile name must contain at least one letter or number")
    return name
  }
  if (!currentProfile) {
    throw new Error("Pass a profile name or select one with `onyx profile use <name>`.")
  }
  return currentProfile
}

function requireProfile(
  profiles: Record<string, CliProfile>,
  name: string
): CliProfile {
  const profile = profiles[name]
  if (!profile) throw new Error(`Unknown Onyx CLI profile "${name}".`)
  return profile
}

function describeWorkerModel(
  profile: CliProfile,
  agent: BuiltInWorkerAgent
) {
  return profile.worker?.models?.[agent] ?? "(default)"
}

async function commandProfileWorker(args: Args) {
  const sub = args.positional[2]
  if (sub === "get") return commandProfileWorkerGet(args)
  if (sub === "set") return commandProfileWorkerSet(args)
  if (sub === "clear") return commandProfileWorkerClear(args)
  throw new Error(
    "Usage: onyx profile worker get [profile] | onyx profile worker set [profile] --agent codex|claude|opencode [--model <model>] | onyx profile worker clear [profile] (--all | --agent | --model codex|claude|opencode)"
  )
}

async function commandProfileWorkerGet(args: Args) {
  const config = await readConfig()
  const name = workerProfileOrCurrent({
    requested: workerProfileName(args),
    currentProfile: config.currentProfile,
  })
  const profile = requireProfile(config.profiles, name)
  const agent = profile.worker?.agent ?? "codex"
  console.log(`Profile: ${name}`)
  console.log(`Worker agent: ${agent}`)
  for (const workerAgent of BUILT_IN_WORKER_AGENTS) {
    console.log(`Model ${workerAgent}: ${describeWorkerModel(profile, workerAgent)}`)
  }
}

async function commandProfileWorkerSet(args: Args) {
  const rawAgent = args.options.agent
  if (!rawAgent || rawAgent === "true") {
    throw new Error(
      "Pass --agent codex|claude|opencode when setting worker defaults."
    )
  }
  const agent = validateBuiltInWorkerAgent(rawAgent)
  const model =
    args.options.model === undefined
      ? undefined
      : normalizeWorkerModel(args.options.model)
  if (args.options.model !== undefined && !model) {
    throw new Error("--model must not be empty")
  }
  if (agent === "opencode" && model) {
    const slash = model.indexOf("/")
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error("--model for --agent opencode must use provider/model")
    }
  }

  const config = await readConfig()
  const name = workerProfileOrCurrent({
    requested: workerProfileName(args),
    currentProfile: config.currentProfile,
  })
  const profile = requireProfile(config.profiles, name)
  const worker: WorkerProfileConfig = {
    ...(profile.worker ?? {}),
    agent,
    models: { ...(profile.worker?.models ?? {}) },
  }
  if (model) worker.models![agent] = model
  if (Object.keys(worker.models ?? {}).length === 0) delete worker.models
  await writeConfig({
    ...config,
    profiles: {
      ...config.profiles,
      [name]: {
        ...profile,
        worker,
        updatedAt: new Date().toISOString(),
      },
    },
  })
  console.log(
    `Profile ${name} worker defaults: agent=${agent}${
      model ? ` model=${model}` : ""
    }`
  )
}

async function commandProfileWorkerClear(args: Args) {
  const clearAll = args.options.all === "true"
  const clearAgent = args.options.agent !== undefined
  const rawModelAgent = args.options.model
  if (!clearAll && !clearAgent && rawModelAgent === undefined) {
    throw new Error("Pass --all, --agent, or --model codex|claude|opencode.")
  }
  if (clearAll && (clearAgent || rawModelAgent !== undefined)) {
    throw new Error("Pass --all by itself, or clear --agent/--model separately.")
  }
  if (clearAgent && args.options.agent !== "true") {
    throw new Error("Use --agent without a value when clearing the worker agent.")
  }
  const modelAgent =
    rawModelAgent === undefined ? null : validateBuiltInWorkerAgent(rawModelAgent)

  const config = await readConfig()
  const name = workerProfileOrCurrent({
    requested: workerProfileName(args),
    currentProfile: config.currentProfile,
  })
  const profile = requireProfile(config.profiles, name)
  if (!profile.worker) {
    console.log(`Profile ${name} has no worker defaults.`)
    return
  }
  let worker: WorkerProfileConfig = {
    ...profile.worker,
    models: { ...(profile.worker.models ?? {}) },
  }
  if (clearAll) {
    worker = {}
  } else {
    if (clearAgent) delete worker.agent
    if (modelAgent) delete worker.models?.[modelAgent]
    if (worker.models && Object.keys(worker.models).length === 0) delete worker.models
  }
  const nextProfile = { ...profile, updatedAt: new Date().toISOString() }
  if (worker.agent || worker.models) nextProfile.worker = worker
  else delete nextProfile.worker
  await writeConfig({
    ...config,
    profiles: {
      ...config.profiles,
      [name]: nextProfile,
    },
  })
  console.log(`Cleared worker defaults for profile ${name}.`)
}
