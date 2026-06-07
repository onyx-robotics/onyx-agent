import { describe, expect, test } from "bun:test"

async function dryRun(os: string, arch: string) {
  const process = Bun.spawn(["sh", "scripts/install.sh"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...Bun.env,
      ONYX_INSTALL_DRY_RUN: "1",
      ONYX_INSTALL_OS: os,
      ONYX_INSTALL_ARCH: arch,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()
  const code = await process.exited
  if (code !== 0) {
    throw new Error(stderr || stdout)
  }
  return stdout
}

describe("install script", () => {
  test("maps macOS arm64 to the darwin arm64 asset", async () => {
    const output = await dryRun("Darwin", "arm64")

    expect(output).toContain("target=darwin-arm64")
    expect(output).toContain("asset=onyx-darwin-arm64")
  })

  test("maps Linux x64 to the baseline asset", async () => {
    const output = await dryRun("Linux", "x86_64")

    expect(output).toContain("target=linux-x64-baseline")
    expect(output).toContain("asset=onyx-linux-x64-baseline")
  })
})
