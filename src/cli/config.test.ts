import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { configPath, readConfig, target, writeConfig } from "./config"
import type { Io } from "./io"
import { CliError, UsageError } from "./output"

const io = (env: Record<string, string | undefined>) => ({ env }) as unknown as Io
const profile = {
  url: "https://onyx.example",
  token: "onyx_pat_a",
  org: { id: "o", name: "Acme", slug: "acme" },
}

test("the config file: $ONYX_CONFIG, else under XDG_CONFIG_HOME or ~/.config", () => {
  expect(configPath(io({ ONYX_CONFIG: "/x/c.json" }))).toBe("/x/c.json")
  expect(configPath(io({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" }))).toBe("/xdg/onyx/config.json")
  // an empty variable is unset (an env file may hold X="")
  expect(configPath(io({ ONYX_CONFIG: "", HOME: "/h" }))).toBe("/h/.config/onyx/config.json")
})

test("it holds secrets: readable by its owner only, whatever it was before", () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-cli-"))
  const path = join(dir, "nested", "config.json")
  expect(readConfig(path)).toEqual({ current: null, profiles: {} })
  writeConfig(path, { current: "acme", profiles: { acme: profile } })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readConfig(path).profiles.acme).toEqual(profile)
})

test("a profile it didn't write (another tool's, in the same file) is kept but never used", () => {
  const path = join(mkdtempSync(join(tmpdir(), "onyx-cli-")), "config.json")
  const theirs = { apiUrl: "https://elsewhere", teamId: "t" }
  writeFileSync(path, JSON.stringify({ current: "old", profiles: { old: theirs } }))
  const config = readConfig(path)
  expect(config.profiles).toEqual({})
  expect(() => target(io({}), config)).toThrow(CliError)
  config.profiles.acme = profile
  config.current = "acme"
  writeConfig(path, config)
  const written = JSON.parse(readFileSync(path, "utf8"))
  expect(written.profiles).toEqual({ old: theirs, acme: profile })
  expect(Object.keys(readConfig(path).profiles)).toEqual(["acme"])
})

test("the environment overrides the profile; a profile can be chosen", () => {
  const config = { current: "acme", profiles: { acme: profile, beta: { ...profile, token: "b" } } }
  expect(target(io({}), config)).toEqual({
    url: profile.url,
    token: profile.token,
    profile: "acme",
  })
  expect(target(io({ ONYX_TOKEN: "env" }), config).token).toBe("env")
  expect(target(io({}), config, "beta").token).toBe("b")
  expect(target(io({ ONYX_PROFILE: "beta" }), config).token).toBe("b")
  expect(() => target(io({}), config, "nope")).toThrow(UsageError)
  const none = { current: null, profiles: {} }
  expect(() => target(io({}), none)).toThrow(CliError)
  expect(() => target(io({ ONYX_TOKEN: "t" }), none)).toThrow(/ONYX_URL/)
  expect(target(io({ ONYX_TOKEN: "t", ONYX_URL: "http://x" }), none)).toEqual({
    url: "http://x",
    token: "t",
    profile: null,
  })
})

test("a profile's token goes only to its own server, whatever ONYX_URL says", () => {
  const config = { current: "acme", profiles: { acme: profile } }
  // an env file in some repository naming another server: refused, the token not sent
  expect(() => target(io({ ONYX_URL: "https://evil.example" }), config)).toThrow(UsageError)
  // the same server (a trailing slash aside) is fine
  expect(target(io({ ONYX_URL: "https://onyx.example/" }), config).token).toBe(profile.token)
  // with its own token, ONYX_URL is a different sign-in altogether
  expect(target(io({ ONYX_URL: "https://other.example", ONYX_TOKEN: "t" }), config)).toEqual({
    url: "https://other.example",
    token: "t",
    profile: "acme",
  })
})
