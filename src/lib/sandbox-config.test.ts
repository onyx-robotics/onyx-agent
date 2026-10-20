import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { Args } from "./args"
import { selectSandbox } from "./sandbox-config"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function projectWithConfig(contents?: string) {
  const root = await mkdtemp(join(tmpdir(), "onyx-sandbox-config-"))
  roots.push(root)
  await mkdir(join(root, "apps", "ml", "onyx"), { recursive: true })
  if (contents !== undefined) {
    await writeFile(join(root, "apps", "ml", "onyx", "sandbox.json"), contents)
  }
  return root
}

function args(options: Record<string, string> = {}): Args {
  return { positional: ["research", "run"], options }
}

describe("selectSandbox", () => {
  test("no sandbox.json means workers run unconfined", async () => {
    const root = await projectWithConfig()
    expect(
      await selectSandbox({ root, projectPath: "apps/ml", args: args() })
    ).toEqual({ enabled: false, configPresent: false, disabledByFlag: false })
  })

  test("an empty sandbox.json enables the default policy", async () => {
    const root = await projectWithConfig("{}")
    expect(
      await selectSandbox({ root, projectPath: "apps/ml", args: args() })
    ).toEqual({
      enabled: true,
      config: {
        schemaVersion: 1,
        worktreeWrites: "all",
        read: [],
        write: [],
        exec: null,
        devices: [],
      },
    })
  })

  test("reads the project's paths", async () => {
    const root = await projectWithConfig(
      JSON.stringify({
        read: ["~/.cargo"],
        exec: ["build/bin"],
        devices: ["/dev/ttyUSB0"],
      })
    )
    const selection = await selectSandbox({
      root,
      projectPath: "apps/ml",
      args: args(),
    })
    expect(selection.enabled && selection.config).toMatchObject({
      read: ["~/.cargo"],
      exec: ["build/bin"],
      devices: ["/dev/ttyUSB0"],
    })
  })

  test("a malformed policy is a hard error, never a silent off", async () => {
    for (const contents of [
      "{",
      JSON.stringify({ writable: ["/"] }),
      // The removed mode switch must not read as a way to turn it off.
      JSON.stringify({ mode: "off" }),
    ]) {
      const root = await projectWithConfig(contents)
      await expect(
        selectSandbox({ root, projectPath: "apps/ml", args: args() })
      ).rejects.toThrow("Invalid")
    }
  })

  test("--no-sandbox disables a present policy without parsing it", async () => {
    const root = await projectWithConfig("{ not json")
    expect(
      await selectSandbox({
        root,
        projectPath: "apps/ml",
        args: args({ "no-sandbox": "true" }),
      })
    ).toEqual({ enabled: false, configPresent: true, disabledByFlag: true })
  })

  test("the removed --sandbox flag explains the replacement", async () => {
    const root = await projectWithConfig()
    for (const value of ["enforce", "off"]) {
      await expect(
        selectSandbox({
          root,
          projectPath: "apps/ml",
          args: args({ sandbox: value }),
        })
      ).rejects.toThrow("--sandbox was removed")
    }
  })
})
