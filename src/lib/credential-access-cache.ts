import type { CliProfile } from "./config"

const ACCESS_TOKEN_CACHE_TTL_MS = 60_000

type CachedAccessToken = {
  accessToken: string
  expiresAt: number
  cachedUntil: number
}

const accessTokens = new Map<string, CachedAccessToken>()

function cacheKey(profile: CliProfile) {
  return [
    profile.credentialId,
    profile.credentialStore,
    profile.updatedAt,
  ].join("\u0000")
}

export function cachedAccessToken(
  profile: CliProfile,
  refreshBufferMs: number,
  now = Date.now()
) {
  const cached = accessTokens.get(cacheKey(profile))
  if (
    !cached ||
    cached.cachedUntil <= now ||
    cached.expiresAt - now <= refreshBufferMs
  ) {
    return null
  }
  return cached.accessToken
}

export function cacheAccessToken(
  profile: CliProfile,
  credential: Pick<CachedAccessToken, "accessToken" | "expiresAt">,
  now = Date.now()
) {
  accessTokens.set(cacheKey(profile), {
    ...credential,
    cachedUntil: Math.min(
      now + ACCESS_TOKEN_CACHE_TTL_MS,
      credential.expiresAt
    ),
  })
}

export function invalidateCachedCredential(credentialId: string) {
  for (const key of accessTokens.keys()) {
    if (key.startsWith(`${credentialId}\u0000`)) accessTokens.delete(key)
  }
}

/** Test hook: isolate process-local credential cache state between tests. */
export function clearCachedAccessTokensForTests() {
  accessTokens.clear()
}
