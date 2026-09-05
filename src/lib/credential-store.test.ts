import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CredentialStoreUnavailableError,
  deleteCredential,
  keyringSupported,
  readCredential,
  setCredentialLockTimingForTests,
  setKeyringEntryFactoryForTests,
  withCredentialLock,
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
  setCredentialLockTimingForTests()
  setKeyringEntryFactoryForTests(null)
  if (originalHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = originalHome
  if (originalStore === undefined) delete process.env.ONYX_TEST_CREDENTIAL_STORE
  else process.env.ONYX_TEST_CREDENTIAL_STORE = originalStore
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe("credential refresh lock", () => {
  test("serializes refresh owners", async () => {
    const id = "77777777-7777-4777-8777-777777777777"
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const order: string[] = []
    const first = withCredentialLock(id, async () => {
      order.push("first-enter")
      await firstCanFinish
      order.push("first-exit")
    })
    while (!order.includes("first-enter")) await Bun.sleep(1)
    const second = withCredentialLock(id, async () => {
      order.push("second-enter")
    })
    await Bun.sleep(10)
    expect(order).toEqual(["first-enter"])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"])
  })

  test("takes over a stale lock without allowing the late owner to release its replacement", async () => {
    setCredentialLockTimingForTests({ staleMs: 20, waitMs: 500, pollMs: 2 })
    const id = "88888888-8888-4888-8888-888888888888"
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    let firstEntered = false
    let secondEntered = false
    let thirdEntered = false

    const first = withCredentialLock(id, async () => {
      firstEntered = true
      await firstCanFinish
    })
    while (!firstEntered) await Bun.sleep(1)
    await Bun.sleep(25)
    const second = withCredentialLock(id, async () => {
      secondEntered = true
      await secondCanFinish
    })
    while (!secondEntered) await Bun.sleep(1)

    releaseFirst()
    await first
    const third = withCredentialLock(id, async () => {
      thirdEntered = true
    })
    await Bun.sleep(5)
    expect(thirdEntered).toBe(false)

    releaseSecond()
    await Promise.all([second, third])
    expect(thirdEntered).toBe(true)
  })

  test("bounds acquisition when a live owner does not finish", async () => {
    setCredentialLockTimingForTests({ staleMs: 1_000, waitMs: 20, pollMs: 2 })
    const id = "99999999-9999-4999-8999-999999999999"
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstEntered = false
    const first = withCredentialLock(id, async () => {
      firstEntered = true
      await firstCanFinish
    })
    while (!firstEntered) await Bun.sleep(1)

    await expect(withCredentialLock(id, async () => undefined)).rejects.toThrow(
      "Timed out waiting"
    )
    releaseFirst()
    await first
  })
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
    // A profile that still says "keyring" recovers the file copy that the
    // fallback wrote instead of reporting the keyring outage.
    expect(await readCredential(id, "keyring")).toEqual(credential)
    await expect(
      readCredential("55555555-5555-4555-8555-555555555555", "keyring")
    ).rejects.toEqual(expect.any(CredentialStoreUnavailableError))
    // Deleting must not hang either.
    await deleteCredential(id)
    expect(await readCredential(id, "file")).toBeNull()
  }, 15_000)

  test("any keyring error reads as unavailable, never as a missing credential", async () => {
    setKeyringEntryFactoryForTests(() => ({
      getPassword: async () => {
        throw new Error("The keyring is locked")
      },
      setPassword: async () => undefined,
      deleteCredential: async () => true,
    }))
    await expect(
      readCredential("66666666-6666-4666-8666-666666666666", "keyring")
    ).rejects.toThrow("locked")

    // No keyring in this environment at all (for example Linux without a
    // session bus) is also "unavailable", not "log in again".
    setKeyringEntryFactoryForTests(() => null)
    await expect(
      readCredential("66666666-6666-4666-8666-666666666666", "keyring")
    ).rejects.toEqual(expect.any(CredentialStoreUnavailableError))
  })
})
