import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { commandLogout } from "./commands/logout"
import { parseArgs } from "./lib/args"
import {
  emptyConfig,
  readConfig,
  writeConfig,
  type CliProfile,
} from "./lib/config"
import { writeCredential } from "./lib/credential-store"

let runtimeRoot = ""
const originalHome = process.env.ONYX_HOME
const originalStore = process.env.ONYX_TEST_CREDENTIAL_STORE
const originalFetch = globalThis.fetch

const profile: CliProfile = {
  apiUrl: "https://app.example.test",
  cliSessionId: "33333333-3333-4333-8333-333333333333",
  credentialId: "11111111-1111-4111-8111-111111111111",
  credentialStore: "file",
  oauth: {
    issuer: "https://auth.example.test",
    clientId: "client",
    tokenEndpoint: "https://auth.example.test/token",
    scopes: ["openid", "offline_access"],
  },
  teamId: "22222222-2222-4222-8222-222222222222",
  teamName: "Team",
  updatedAt: "2026-09-05T12:00:00.000Z",
}

beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "onyx-logout-test-"))
  process.env.ONYX_HOME = runtimeRoot
  process.env.ONYX_TEST_CREDENTIAL_STORE = "file"
  await writeCredential(
    profile.credentialId,
    {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 900_000,
    },
    "file"
  )
  await writeConfig({
    ...emptyConfig(),
    profiles: { team: profile },
    currentProfile: "team",
  })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalHome === undefined) delete process.env.ONYX_HOME
  else process.env.ONYX_HOME = originalHome
  if (originalStore === undefined) delete process.env.ONYX_TEST_CREDENTIAL_STORE
  else process.env.ONYX_TEST_CREDENTIAL_STORE = originalStore
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe("onyx logout", () => {
  test("finishes local logout promptly when remote revocation cannot connect", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    const log = spyOn(console, "log").mockImplementation(() => undefined)
    const started = Date.now()
    try {
      await commandLogout(parseArgs(["logout", "--profile", "team"]))
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }

    expect(Date.now() - started).toBeLessThan(1_000)
    expect((await readConfig()).profiles).toEqual({})
  })
})
