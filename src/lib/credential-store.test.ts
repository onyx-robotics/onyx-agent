import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CredentialStoreUnavailableError,
  deleteCredential,
  keyringSupported,
  readCredential,
  setKeyringEntryFactoryForTests,
  writeCredential,
} from "./credential-store"

let runtimeRoot = ""
const originalHome = process.env.ONYX_HOME
const originalStore = process.env.ONYX_TEST_CREDENTIAL_STORE

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "onyx-credential-test-"))
  process.env.ONYX_HOME = runtimeRoot
  process.env.ONYX_TEST_CREDENTIAL_STORE = "file"
})

afterEach(async () => {
  setKeyringEntryFactoryForTests(null)
  if (originalHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = originalHome
  if (originalStore === undefined) delete process.env.ONYX_TEST_CREDENTIAL_STORE
  else process.env.ONYX_TEST_CREDENTIAL_STORE = originalStore
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe("fallback credential store", () => {
  test("atomically stores each credential in a private file", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const credential = {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: Date.now() + 60_000,
    }

    expect(await writeCredential(id, credential)).toBe("file")
    expect(await readCredential(id, "file")).toEqual(credential)

    const configDirectory = join(runtimeRoot, "config")
    const credentialsDirectory = join(configDirectory, "credentials")
    const path = join(credentialsDirectory, `${id}.json`)
    expect((await stat(configDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(credentialsDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, "utf8")).toContain("refresh-secret")

    await deleteCredential(id)
    expect(await readCredential(id, "file")).toBeNull()
  })

  test("keeps simultaneous profiles isolated", async () => {
    const first = "11111111-1111-4111-8111-111111111111"
    const second = "22222222-2222-4222-8222-222222222222"
    await Promise.all([
      writeCredential(first, {
        accessToken: "first",
        refreshToken: "first-refresh",
        expiresAt: 1,
      }),
      writeCredential(second, {
        accessToken: "second",
        refreshToken: "second-refresh",
        expiresAt: 2,
      }),
    ])
    expect((await readCredential(first, "file"))?.accessToken).toBe("first")
    expect((await readCredential(second, "file"))?.accessToken).toBe("second")
  })
})

describe("native keyring guard rails", () => {
  test("skips the keyring when tests force files or Linux has no session bus", () => {
    expect(keyringSupported({ ONYX_TEST_CREDENTIAL_STORE: "file" })).toBe(false)
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    try {
      Object.defineProperty(process, "platform", { value: "linux" })
      expect(keyringSupported({})).toBe(false)
      expect(
        keyringSupported({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" })
      ).toBe(true)
      Object.defineProperty(process, "platform", { value: "darwin" })
      expect(keyringSupported({})).toBe(true)
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  test("stores in a working keyring and never leaves a file copy behind", async () => {
    const store = new Map<string, string>()
    setKeyringEntryFactoryForTests((credentialId) => ({
      getPassword: async () => store.get(credentialId) ?? null,
      setPassword: async (value) => {
        store.set(credentialId, value)
      },
      deleteCredential: async () => store.delete(credentialId),
    }))
    const id = "33333333-3333-4333-8333-333333333333"
    const credential = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
    }
    expect(await writeCredential(id, credential)).toBe("keyring")
    expect(await readCredential(id, "keyring")).toEqual(credential)
    expect(await readCredential(id, "file")).toBeNull()
    await deleteCredential(id)
    expect(await readCredential(id, "keyring")).toBeNull()
  })

  test("times out a hung keyring: writes fall back to a file, reads report unavailability", async () => {
    const hang = () => new Promise<never>(() => undefined)
    setKeyringEntryFactoryForTests(() => ({
      getPassword: hang,
      setPassword: hang,
      deleteCredential: hang,
    }))
    const id = "44444444-4444-4444-8444-444444444444"
    const credential = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 60_000,
    }
    expect(await writeCredential(id, credential)).toBe("file")
    expect(await readCredential(id, "file")).toEqual(credential)
    await expect(readCredential(id, "keyring")).rejects.toEqual(
      expect.any(CredentialStoreUnavailableError)
    )
    // Deleting must not hang either.
    await deleteCredential(id)
    expect(await readCredential(id, "file")).toBeNull()
  }, 15_000)
})
