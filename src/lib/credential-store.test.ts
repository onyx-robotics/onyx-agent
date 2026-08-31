import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  deleteCredential,
  readCredential,
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
