import type { CliProfile } from "./config"
import {
  deleteCredential,
  readCredential,
  withCredentialLock,
  writeCredential,
} from "./credential-store"
import {
  fetchCliAuthConfig,
  OAuthRequestError,
  refreshOAuthCredential,
} from "./oauth-client"

const REFRESH_BUFFER_MS = 60_000

export async function accessTokenForProfile({
  name,
  profile,
  forceRefresh = false,
}: {
  name: string
  profile: CliProfile
  forceRefresh?: boolean
}) {
  const current = await readCredential(
    profile.credentialId,
    profile.credentialStore
  )
  if (!current) {
    throw new Error(
      `Profile "${name}" has no usable login credential. Run \`onyx login\`.`
    )
  }
  if (!forceRefresh && current.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return current.accessToken
  }

  return withCredentialLock(profile.credentialId, async () => {
    const credential = await readCredential(
      profile.credentialId,
      profile.credentialStore
    )
    if (!credential) {
      throw new Error(
        `Profile "${name}" has no usable login credential. Run \`onyx login\`.`
      )
    }
    if (
      !forceRefresh &&
      credential.expiresAt - Date.now() > REFRESH_BUFFER_MS
    ) {
      return credential.accessToken
    }

    try {
      const config = await fetchCliAuthConfig(profile.apiUrl)
      const refreshed = await refreshOAuthCredential({ config, credential })
      await writeCredential(
        profile.credentialId,
        refreshed,
        profile.credentialStore
      )
      return refreshed.accessToken
    } catch (error) {
      if (
        error instanceof OAuthRequestError &&
        ["invalid_grant", "access_denied", "expired_token"].includes(error.code)
      ) {
        await deleteCredential(profile.credentialId)
        throw new Error(
          `Login for profile "${name}" has expired or been revoked. Run \`onyx login\`.`
        )
      }
      if (credential.expiresAt > Date.now()) return credential.accessToken
      throw error
    }
  })
}
