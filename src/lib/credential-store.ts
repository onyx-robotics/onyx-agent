import { randomUUID } from "node:crypto"
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

import { configDir } from "./config"

const KEYRING_SERVICE = "ai.onyxresearch.onyx-cli"
const CREDENTIALS_DIRECTORY = "credentials"

export type OAuthCredential = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export type CredentialStoreKind = "keyring" | "file"

function validCredential(value: unknown): value is OAuthCredential {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<OAuthCredential>
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.refreshToken === "string" &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt)
  )
}

function credentialFilePath(credentialId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(credentialId)) {
    throw new Error("Invalid Onyx credential identifier")
  }
  return join(configDir(), CREDENTIALS_DIRECTORY, `${credentialId}.json`)
}

async function ensureCredentialDirectory() {
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  await chmod(configDir(), 0o700)
  const directory = join(configDir(), CREDENTIALS_DIRECTORY)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

async function writeCredentialFile(
  credentialId: string,
  credential: OAuthCredential
) {
  await ensureCredentialDirectory()
  const path = credentialFilePath(credentialId)
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(credential)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  await chmod(path, 0o600)
}

async function readCredentialFile(credentialId: string) {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(credentialFilePath(credentialId), "utf8")
    )
    return validCredential(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function keyringEntry(credentialId: string) {
  if (process.env.ONYX_TEST_CREDENTIAL_STORE === "file") return null
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring")
    return new AsyncEntry(KEYRING_SERVICE, credentialId)
  } catch {
    return null
  }
}

async function writeKeyringCredential(
  credentialId: string,
  credential: OAuthCredential
) {
  const entry = await keyringEntry(credentialId)
  if (!entry) return false
  try {
    await entry.setPassword(JSON.stringify(credential))
    return true
  } catch {
    return false
  }
}

async function readKeyringCredential(credentialId: string) {
  const entry = await keyringEntry(credentialId)
  if (!entry) return null
  try {
    const value = await entry.getPassword()
    if (!value) return null
    const parsed: unknown = JSON.parse(value)
    return validCredential(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function deleteKeyringCredential(credentialId: string) {
  const entry = await keyringEntry(credentialId)
  if (!entry) return
  try {
    await entry.deleteCredential()
  } catch {
    // Missing, locked, or unavailable keyrings are handled by file cleanup.
  }
}

export async function writeCredential(
  credentialId: string,
  credential: OAuthCredential,
  preferredStore?: CredentialStoreKind
): Promise<CredentialStoreKind> {
  if (preferredStore !== "file") {
    if (await writeKeyringCredential(credentialId, credential)) {
      await unlink(credentialFilePath(credentialId)).catch(() => undefined)
      return "keyring"
    }
    if (preferredStore === "keyring") {
      throw new Error("The system keyring is unavailable or locked")
    }
  }

  await writeCredentialFile(credentialId, credential)
  return "file"
}

export async function readCredential(
  credentialId: string,
  store: CredentialStoreKind
): Promise<OAuthCredential | null> {
  if (store === "keyring") return readKeyringCredential(credentialId)
  return readCredentialFile(credentialId)
}

export async function deleteCredential(credentialId: string) {
  await deleteKeyringCredential(credentialId)
  await unlink(credentialFilePath(credentialId)).catch(() => undefined)
}

function lockPath(credentialId: string) {
  return join(configDir(), `.credential-${credentialId}.lock`)
}

async function acquireCredentialLock(credentialId: string) {
  await ensureCredentialDirectory()
  const path = lockPath(credentialId)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const handle = await open(path, "wx", 0o600)
      return async () => {
        await handle.close()
        await unlink(path).catch(() => undefined)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        if (Date.now() - (await stat(path)).mtimeMs > 30_000) {
          await unlink(path)
          continue
        }
      } catch {
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error("Timed out waiting for another Onyx process to refresh login")
}

export async function withCredentialLock<T>(
  credentialId: string,
  work: () => Promise<T>
): Promise<T> {
  const release = await acquireCredentialLock(credentialId)
  try {
    return await work()
  } finally {
    await release()
  }
}
