import {
  readConfig,
  updateProfileCredentialStore,
  type CliProfile,
} from "./config"
import { cacheAccessToken, cachedAccessToken } from "./credential-access-cache"
import {
  CredentialStoreUnavailableError,
  deleteCredential,
  readCredential,
  withCredentialLock,
  writeCredential,
  type OAuthCredential,
} from "./credential-store"
import {
  OAuthRequestError,
  persistableCredential,
  refreshOAuthCredential,
} from "./oauth-client"

const REFRESH_BUFFER_MS = 60_000

function missingCredentialError(name: string) {
  return new Error(
    `Profile "${name}" has no usable login credential. Run \`onyx login\`.`
  )
}

async function readProfileCredential(name: string, profile: CliProfile) {
  try {
    return await readCredential(profile.credentialId, profile.credentialStore)
  } catch (error) {
    if (error instanceof CredentialStoreUnavailableError) {
      throw new Error(
        `Profile "${name}" is stored in the system keyring, which did not respond (${error.message}). Unlock or restart the keyring and retry; your login is intact.`
      )
    }
    throw error
  }
}

async function readLatestProfileCredential(name: string, profile: CliProfile) {
  const configured = (await readConfig()).profiles[name]
  const latestProfile =
    configured?.credentialId === profile.credentialId ? configured : profile
  return {
    profile: latestProfile,
    credential: await readProfileCredential(name, latestProfile),
  }
}

/**
 * Returns a valid access token for the profile, refreshing with WorkOS when
 * the stored token is near expiry. Refresh always uses the issuer metadata
 * pinned in the profile at login, never the API server's live configuration.
 * The stored credential is removed only when WorkOS definitively rejects the
 * refresh token (`invalid_grant`); outages keep it in place.
 */
export async function accessTokenForProfile({
  name,
  profile,
  forceRefresh = false,
}: {
  name: string
  profile: CliProfile
  forceRefresh?: boolean
}) {
  if (!forceRefresh) {
    const cached = cachedAccessToken(profile, REFRESH_BUFFER_MS)
    if (cached) return cached
  }
  const current = await readProfileCredential(name, profile)
  if (!current) throw missingCredentialError(name)
  if (!forceRefresh && current.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    cacheAccessToken(profile, current)
    return current.accessToken
  }

  return withCredentialLock(profile.credentialId, async () => {
    const credential = await readProfileCredential(name, profile)
    if (!credential) throw missingCredentialError(name)
    if (
      !forceRefresh &&
      credential.expiresAt - Date.now() > REFRESH_BUFFER_MS
    ) {
      cacheAccessToken(profile, credential)
      return credential.accessToken
    }

    let refreshCandidate = credential
    let refreshProfile = profile
    for (let generation = 0; generation < 2; generation += 1) {
      let refreshed: OAuthCredential
      try {
        refreshed = persistableCredential(
          await refreshOAuthCredential({
            config: {
              clientId: refreshProfile.oauth.clientId,
              tokenEndpoint: refreshProfile.oauth.tokenEndpoint,
              scopes: refreshProfile.oauth.scopes,
            },
            credential: refreshCandidate,
          })
        )
      } catch (error) {
        if (
          error instanceof OAuthRequestError &&
          error.code === "invalid_grant"
        ) {
          // A stale process may have attempted a refresh after another process
          // rotated the token. Re-read while holding the lock and never delete
          // a newer credential generation.
          const latest = await readLatestProfileCredential(name, refreshProfile)
          if (
            latest.credential &&
            latest.credential.refreshToken !== refreshCandidate.refreshToken
          ) {
            if (latest.credential.expiresAt > Date.now()) {
              cacheAccessToken(latest.profile, latest.credential)
              return latest.credential.accessToken
            }
            refreshCandidate = latest.credential
            refreshProfile = latest.profile
            continue
          }
          await deleteCredential(profile.credentialId)
          throw new Error(
            `Login for profile "${name}" has expired or been revoked. Run \`onyx login\`.`
          )
        }
        if (refreshCandidate.expiresAt > Date.now()) {
          cacheAccessToken(refreshProfile, refreshCandidate)
          return refreshCandidate.accessToken
        }
        const detail =
          error instanceof OAuthRequestError
            ? `WorkOS ${error.code}`
            : error instanceof Error
              ? error.message
              : String(error)
        throw new Error(
          `Onyx could not refresh the login for profile "${name}" (${detail}). Try again; run \`onyx login\` only if this persists.`
        )
      }

      // WorkOS may have rotated the refresh token, so the new credential must
      // land somewhere durable even if the preferred store is unavailable.
      const storedProfile = await persistRefreshedCredential({
        name,
        profile: refreshProfile,
        refreshed,
      })
      cacheAccessToken(storedProfile, refreshed)
      return refreshed.accessToken
    }

    throw new Error(
      `Login for profile "${name}" changed repeatedly while refreshing. Retry the command.`
    )
  })
}

async function persistRefreshedCredential({
  name,
  profile,
  refreshed,
}: {
  name: string
  profile: CliProfile
  refreshed: OAuthCredential
}) {
  try {
    await writeCredential(
      profile.credentialId,
      refreshed,
      profile.credentialStore
    )
    return profile
  } catch (preferredError) {
    let store: "keyring" | "file"
    try {
      // Do not probe the unavailable keyring twice. Persist the rotated token
      // directly to the permission-restricted file fallback.
      store = await writeCredential(profile.credentialId, refreshed, "file")
    } catch (fallbackError) {
      throw new Error(
        `Onyx refreshed the login for profile "${name}" but could not store it (${
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
        }; ${
          preferredError instanceof Error
            ? preferredError.message
            : String(preferredError)
        }). Run \`onyx login\` again.`
      )
    }
    if (store !== profile.credentialStore) {
      await updateProfileCredentialStore(name, store).catch(() => undefined)
      console.warn(
        `The system keyring was unavailable; the refreshed login for profile "${name}" is stored in a permission-restricted local file.`
      )
      const configured = (await readConfig()).profiles[name]
      if (
        configured?.credentialId === profile.credentialId &&
        configured.credentialStore === store
      ) {
        return configured
      }
    }
    return profile
  }
}
