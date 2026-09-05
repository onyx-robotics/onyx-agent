import { optionalFlag, type Args } from "../lib/args"
import { authFetch } from "../lib/auth-fetch"
import { readConfig, writeConfig } from "../lib/config"
import { deleteCredential } from "../lib/credential-store"
import { accessTokenForProfile } from "../lib/oauth-credentials"

export async function commandLogout(args: Args) {
  const config = await readConfig()
  const requested = args.options.profile
  if (optionalFlag(args, "all") && requested) {
    throw new Error("Pass either --all or --profile, not both.")
  }
  const names = optionalFlag(args, "all")
    ? Object.keys(config.profiles)
    : [requested ?? config.currentProfile]
  if (names.length === 0 || !names[0]) {
    console.log("No CLI profiles are logged in.")
    return
  }

  const profiles = { ...config.profiles }
  for (const name of names) {
    const profile = profiles[name]
    if (!profile) throw new Error(`Unknown Onyx CLI profile "${name}".`)
    try {
      const token = await accessTokenForProfile({ name, profile })
      const response = await authFetch(
        `${profile.apiUrl}/api/v1/cli/auth/session`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token}`,
            "x-onyx-cli-session-id": profile.cliSessionId,
          },
        }
      )
      if (!response.ok) {
        const code = await response
          .clone()
          .json()
          .then(
            (payload: { error?: { code?: string } }) => payload?.error?.code
          )
          .catch(() => undefined)
        if (code === "cli_session_revoked" || code === "cli_session_invalid") {
          console.log(`Profile ${name} was already logged out remotely.`)
        } else {
          console.warn(
            `Remote logout for ${name} failed (${response.status}); remove it from Settings if it remains visible.`
          )
        }
      }
    } catch {
      console.warn(
        `Remote logout for ${name} could not be delivered; remove it from Settings if it remains visible.`
      )
    }
    await deleteCredential(profile.credentialId)
    delete profiles[name]
    console.log(`Logged out profile ${name}`)
  }

  const currentProfile = profiles[config.currentProfile]
    ? config.currentProfile
    : (Object.keys(profiles).sort()[0] ?? "")
  await writeConfig({ ...config, profiles, currentProfile })
}
