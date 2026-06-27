import { runProcess } from "./process"

function opencodeModelIds(output: string) {
  return [
    ...new Set(
      output
        .match(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/@+-]+\b/g)
        ?.filter((value) => !value.startsWith("http")) ?? []
    ),
  ].sort()
}

function modelTokens(value: string) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function modelSimilarity(left: string, right: string) {
  const leftParts = new Set(modelTokens(left))
  const rightParts = new Set(modelTokens(right))
  let overlap = 0
  for (const part of leftParts) {
    if (rightParts.has(part)) overlap += 1
  }
  return overlap
}

function closestModelIds(requested: string, candidates: string[]) {
  return candidates
    .map((candidate) => ({
      candidate,
      score: modelSimilarity(requested, candidate),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map((item) => item.candidate)
}

function isProviderModelId(value: string) {
  const slash = value.indexOf("/")
  return slash > 0 && slash < value.length - 1
}

function modelResolutionError({
  requested,
  models,
  reason,
}: {
  requested: string
  models: string[]
  reason: string
}) {
  const suggestions = closestModelIds(requested, models)
  const suggestionText =
    suggestions.length > 0
      ? ` Nearby model id(s): ${suggestions.join(", ")}.`
      : ""
  return new Error(
    `OpenCode model "${requested}" ${reason}.${suggestionText} Pass an exact provider/model id from \`opencode models\`.`
  )
}

export async function listOpenCodeModels({
  command = "opencode",
  cwd,
  env,
  timeoutMs = 10_000,
}: {
  command?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
} = {}) {
  const result = await runProcess(command, ["models"], {
    cwd,
    env,
    timeoutMs,
  })
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n")
  if (
    result.timedOut ||
    result.code !== 0 ||
    /Unknown command|not found/i.test(output)
  ) {
    throw new Error(
      `Unable to resolve OpenCode model because \`opencode models\` failed: ${
        result.timedOut ? "timed out" : output || `exit ${result.code}`
      }`
    )
  }
  return opencodeModelIds(output)
}

export async function resolveOpenCodeModelId(
  requested: string,
  options: {
    command?: string
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
  } = {}
): Promise<string> {
  const normalized = requested.trim()
  if (!normalized) return normalized
  if (isProviderModelId(normalized)) return normalized

  const models = await listOpenCodeModels(options)
  const requestedTokens = modelTokens(normalized)
  const matches = models.filter((model) => {
    const candidateTokens = new Set(modelTokens(model))
    return requestedTokens.every((token) => candidateTokens.has(token))
  })
  if (matches.length === 1) return matches[0]!

  throw modelResolutionError({
    requested: normalized,
    models,
    reason:
      matches.length === 0
        ? "did not match any available model id"
        : `matched multiple available model ids (${matches.join(", ")})`,
  })
}

export function openCodeModelSuggestions(requested: string, output: string) {
  return closestModelIds(requested, opencodeModelIds(output))
}
