import { createInterface } from "node:readline/promises"

import { optionalFlag, type Args } from "./args"
import { DEFAULT_API_URL } from "./config"
import type { CliAuthConfig } from "./oauth-client"

export type ApiUrlTrust = "production" | "localhost" | "custom"

export function classifyApiUrl(apiUrl: string): ApiUrlTrust {
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    return "custom"
  }
  if (url.origin === new URL(DEFAULT_API_URL).origin) return "production"
  if (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  ) {
    return "localhost"
  }
  return "custom"
}

/**
 * A custom API server chooses which OAuth issuer and client the browser is
 * sent to, and receives the resulting access token. Production and local
 * development are trusted implicitly; anything else must be confirmed by a
 * person (or explicitly with `--trust-api-url` for automation).
 */
export async function confirmApiUrlTrust({
  apiUrl,
  config,
  args,
  ask,
}: {
  apiUrl: string
  config: Pick<CliAuthConfig, "issuer" | "clientId">
  args: Args
  ask?: (prompt: string) => Promise<string>
}): Promise<void> {
  if (classifyApiUrl(apiUrl) !== "custom") return
  if (optionalFlag(args, "trust-api-url")) return

  const summary = [
    `You are logging in to a custom Onyx API server.`,
    `  API URL:   ${apiUrl}`,
    `  Issuer:    ${config.issuer}`,
    `  Client ID: ${config.clientId}`,
    `This server chooses the WorkOS issuer and client you sign in to and receives your access and ID tokens.`,
    `For device login it also completes the WorkOS exchange on your behalf and receives your refresh token, which stays valid until you log out.`,
    `Only continue if you operate this server or trust its operator.`,
  ].join("\n")

  if (!ask && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      `${summary}\nRefusing to log in to a custom API URL without --trust-api-url in a non-interactive shell.`
    )
  }
  console.log(summary)
  const answer = ask
    ? await ask("Continue? [y/N] ")
    : await promptOnce("Continue? [y/N] ")
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new Error("Login cancelled.")
  }
}

async function promptOnce(question: string) {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    return await prompt.question(question)
  } finally {
    prompt.close()
  }
}
