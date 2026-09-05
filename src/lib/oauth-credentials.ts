import type { CliProfile } from "./config"
import {
  CredentialStoreUnavailableError,
  deleteCredential,
  readCredential,
  withCredentialLock,
  writeCredential,
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
  const current = await readProfileCredential(name, profile)
  if (!current) throw missingCredentialError(name)
  if (!forceRefresh && current.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return current.accessToken
  }

  return withCredentialLock(profile.credentialId, async () => {
    const credential = await readProfileCredential(name, profile)
    if (!credential) throw missingCredentialError(name)
    if (
      !forceRefresh &&
      credential.expiresAt - Date.now() > REFRESH_BUFFER_MS
    ) {
      return credential.accessToken
    }

    try {
      const refreshed = await refreshOAuthCredential({
        config: {
          clientId: profile.oauth.clientId,
          tokenEndpoint: profile.oauth.tokenEndpoint,
          scopes: profile.oauth.scopes,
        },
        credential,
      })
      await writeCredential(
        profile.credentialId,
        persistableCredential(refreshed),
        profile.credentialStore
      )
      return refreshed.accessToken
    } catch (error) {
      if (error instanceof OAuthRequestError && error.code === "invalid_grant") {
        await deleteCredential(profile.credentialId)
        throw new Error(
          `Login for profile "${name}" has expired or been revoked. Run \`onyx login\`.`
        )
      }
      if (credential.expiresAt > Date.now()) return credential.accessToken
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
  })
}
