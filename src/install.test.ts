import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

const packageRoot = import.meta.dir + "/.."
const originalPath = Bun.env.PATH ?? ""

async function dryRun(os: string, arch: string) {
  const process = Bun.spawn(["bash", "scripts/install.sh"], {
    cwd: packageRoot,
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

async function writeExecutable(path: string, content: string) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

async function installFixture() {
  const root = await mkdtemp(join(tmpdir(), "onyx-install-test-"))
  const home = join(root, "home")
  const fakeBin = join(root, "fake-bin")
  const logPath = join(root, "onyx-commands.log")
  const curlLogPath = join(root, "curl-commands.log")
  const assetPath = join(root, "onyx-asset")

  await mkdir(home, { recursive: true })
  await mkdir(fakeBin, { recursive: true })

  await writeExecutable(
    assetPath,
    `#!/bin/sh
echo "$*" >> "$ONYX_FAKE_LOG"
if [ "$1" = "developer" ] && [ "$2" = "sync-skill" ]; then
  exit 1
fi
if [ "$1" = "agent" ] && [ "$2" = "install-skill" ]; then
  exit 0
fi
if [ "$1" = "login" ]; then
  if [ "\${ONYX_FAKE_REQUIRE_TTY:-}" = "1" ]; then
    bun -e 'if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(23); console.log("fake tty login complete")'
    exit $?
  fi
  echo "fake login complete"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "0.0.0-test"
  exit 0
fi
exit 0
`
  )

  await writeExecutable(
    join(fakeBin, "curl"),
    `#!/bin/sh
echo "$*" >> "$ONYX_FAKE_CURL_LOG"
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [ -z "$out" ]; then
  exit 2
fi
case "$out" in
  */checksums.txt)
    printf 'hash  onyx-linux-x64-baseline\\nhash  onyx-worker-linux-x64-baseline\\nhash  onyx-darwin-arm64\\nhash  onyx-worker-darwin-arm64\\n' > "$out"
    ;;
  *)
    cp "$ONYX_FAKE_ASSET" "$out"
    ;;
esac
`
  )

  await writeExecutable(
    join(fakeBin, "sha256sum"),
    `#!/bin/sh
case "$1" in
  *onyx-worker-*)
    if [ "\${ONYX_FAKE_BAD_WORKER_CHECKSUM:-}" = "1" ]; then
      printf 'bad  %s\\n' "$1"
      exit 0
    fi
    ;;
esac
printf 'hash  %s\\n' "$1"
`
  )

  return {
    root,
    home,
    fakeBin,
    logPath,
    curlLogPath,
    assetPath,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function runInstall(
  fixture: Awaited<ReturnType<typeof installFixture>>,
  env: Record<string, string> = {}
) {
  const process = Bun.spawn(["bash", "scripts/install.sh"], {
    cwd: packageRoot,
    env: {
      ...Bun.env,
      HOME: fixture.home,
      PATH: `${fixture.fakeBin}:${originalPath}`,
      SHELL: "/bin/bash",
      ONYX_FAKE_ASSET: fixture.assetPath,
      ONYX_FAKE_LOG: fixture.logPath,
      ONYX_FAKE_CURL_LOG: fixture.curlLogPath,
      ONYX_INSTALL_OS: "Linux",
      ONYX_INSTALL_ARCH: "x86_64",
      // Force the non-interactive code paths so assertions do not depend on
      // whether the test runner has a controlling terminal.
      ONYX_INSTALL_NO_TTY: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()
  const code = await process.exited
  return { code, stdout, stderr }
}

async function runInteractivePipedInstall(
  fixture: Awaited<ReturnType<typeof installFixture>>,
  env: Record<string, string> = {}
) {
  const runner = join(fixture.root, "piped-install.sh")
  await writeExecutable(
    runner,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' '# installer input arrives through a pipe' | bash "$ONYX_PACKAGE_ROOT/scripts/install.sh"
`
  )
  const command =
    process.platform === "darwin"
      ? ["script", "-q", "/dev/null", runner]
      : ["script", "-q", "-e", "-c", runner, "/dev/null"]
  const child = Bun.spawn(command, {
    cwd: packageRoot,
    env: {
      ...Bun.env,
      HOME: fixture.home,
      PATH: `${fixture.fakeBin}:${originalPath}`,
      SHELL: "/bin/bash",
      TERM: "dumb",
      ONYX_PACKAGE_ROOT: packageRoot,
      ONYX_FAKE_ASSET: fixture.assetPath,
      ONYX_FAKE_LOG: fixture.logPath,
      ONYX_FAKE_CURL_LOG: fixture.curlLogPath,
      ONYX_FAKE_REQUIRE_TTY: "1",
      ONYX_INSTALL_OS: process.platform === "darwin" ? "Darwin" : "Linux",
      ONYX_INSTALL_ARCH: process.arch === "arm64" ? "arm64" : "x86_64",
      ONYX_INSTALL_PATH_ANSWER: "no",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  const code = await child.exited
  return { code, stdout, stderr }
}

async function withFixture<T>(
  fn: (fixture: Awaited<ReturnType<typeof installFixture>>) => Promise<T>
) {
  const fixture = await installFixture()
  try {
    return await fn(fixture)
  } finally {
    await fixture.cleanup()
  }
}

describe("install script", () => {
  test("maps macOS arm64 to the darwin arm64 asset", async () => {
    const output = await dryRun("Darwin", "arm64")

    expect(output).toContain("target=darwin-arm64")
    expect(output).toContain("asset=onyx-darwin-arm64")
    expect(output).toContain("worker_asset=onyx-worker-darwin-arm64")
  })

  test("maps Linux x64 to the baseline asset", async () => {
    const output = await dryRun("Linux", "x86_64")

    expect(output).toContain("target=linux-x64-baseline")
    expect(output).toContain("asset=onyx-linux-x64-baseline")
    expect(output).toContain("worker_asset=onyx-worker-linux-x64-baseline")
  })

  test("installs to user-local bin by default", async () => {
    await withFixture(async (fixture) => {
      const result = await runInstall(fixture, {
        ONYX_INSTALL_NO_PROMPT: "1",
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Onyx CLI Installer")
      expect(result.stdout).not.toContain("Step 1/6")
      expect(result.stdout).not.toContain(">  Authenticate")
      expect(result.stdout).toContain(
        `Installed onyx to ${fixture.home}/.local/bin/onyx`
      )
      expect(result.stdout).toContain(
        `Installed onyx-worker to ${fixture.home}/.local/bin/onyx-worker`
      )
      expect(
        await readFile(`${fixture.home}/.local/bin/onyx`, "utf8")
      ).toContain("fake login complete")
      expect(
        await readFile(`${fixture.home}/.local/bin/onyx-worker`, "utf8")
      ).toContain("fake login complete")
      expect(
        await readFile(`${fixture.home}/.local/bin/.onyx-install`, "utf8")
      ).toContain(`path=${fixture.home}/.local/bin/onyx`)
      expect(
        await readFile(`${fixture.home}/.local/bin/.onyx-install`, "utf8")
      ).toContain(`worker_path=${fixture.home}/.local/bin/onyx-worker`)
      const curlLog = await readFile(fixture.curlLogPath, "utf8")
      expect(curlLog).toContain("--retry 3")
      expect(curlLog).toContain("--connect-timeout 10")
      expect(curlLog).toContain("--max-time 120")
    })
  })

  test("adds user-local bin to shell rc when accepted", async () => {
    await withFixture(async (fixture) => {
      const result = await runInstall(fixture, {
        ONYX_INSTALL_AUTH: "skip",
        ONYX_INSTALL_PATH_ANSWER: "yes",
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(">  Make onyx available")
      expect(result.stdout).toContain(
        `|     Add ${fixture.home}/.local/bin to your shell PATH?`
      )
      expect(result.stdout).toContain(
        `Added ${fixture.home}/.local/bin to PATH`
      )
      expect(await readFile(`${fixture.home}/.bashrc`, "utf8")).toContain(
        'export PATH="$HOME/.local/bin:$PATH"'
      )
    })
  })

  test("prints PATH instructions when shell rc update is declined", async () => {
    await withFixture(async (fixture) => {
      const result = await runInstall(fixture, {
        ONYX_INSTALL_AUTH: "skip",
        ONYX_INSTALL_PATH_ANSWER: "no",
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Add Onyx to your PATH:")
      expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"')
      await expect(
        readFile(`${fixture.home}/.bashrc`, "utf8")
      ).rejects.toThrow()
    })
  })

  test("no-prompt mode does not update shell rc or run login", async () => {
    await withFixture(async (fixture) => {
      const result = await runInstall(fixture, {
        ONYX_INSTALL_NO_PROMPT: "1",
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Authenticate later:")
      expect(result.stdout).toContain('export ONYX_API_KEY="onyx_..."')
      expect(result.stdout).not.toContain(">  Make onyx available")
      expect(result.stdout).not.toContain(">  Authenticate")
      await expect(
        readFile(`${fixture.home}/.bashrc`, "utf8")
      ).rejects.toThrow()
      const log = await readFile(fixture.logPath, "utf8")
      expect(log).not.toContain("login")
    })
  })

  test("refuses to overwrite an existing non-Onyx command", async () => {
    await withFixture(async (fixture) => {
      await mkdir(`${fixture.home}/.local/bin`, { recursive: true })
      await writeFile(`${fixture.home}/.local/bin/onyx`, "#!/bin/sh\n")

      const result = await runInstall(fixture)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Refusing to overwrite existing file")
    })
  })

  test("does not replace a managed install until every checksum passes", async () => {
    await withFixture(async (fixture) => {
      const installDir = `${fixture.home}/.local/bin`
      const onyxPath = `${installDir}/onyx`
      const workerPath = `${installDir}/onyx-worker`
      await mkdir(installDir, { recursive: true })
      await writeFile(onyxPath, "old onyx\n")
      await writeFile(workerPath, "old worker\n")
      await writeFile(
        `${installDir}/.onyx-install`,
        `managed-by=onyx-installer\npath=${onyxPath}\nworker_path=${workerPath}\n`
      )

      const result = await runInstall(fixture, {
        ONYX_FAKE_BAD_WORKER_CHECKSUM: "1",
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Checksum mismatch")
      expect(await readFile(onyxPath, "utf8")).toBe("old onyx\n")
      expect(await readFile(workerPath, "utf8")).toBe("old worker\n")
    })
  })

  test("a headless install skips login instead of starting a long ceremony", async () => {
    await withFixture(async (fixture) => {
      const result = await runInstall(fixture)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(
        "No interactive terminal detected; skipping login."
      )
      expect(result.stdout).toContain("Authenticate later:")
      expect(await readFile(fixture.logPath, "utf8")).not.toContain("login")
    })
  })

  test("piped interactive install gives Bun a real TTY without reopening stdout", async () => {
    await withFixture(async (fixture) => {
      const result = await runInteractivePipedInstall(fixture)

      expect(result.code).toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "fake tty login complete"
      )
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("EINVAL")
      const commands = (await readFile(fixture.logPath, "utf8")).split("\n")
      expect(commands).toContain("login")
      expect(commands).not.toContain("login --browser")
    })
  })

  test("API key auth override prints the global environment variable", async () => {
    await withFixture(async (fixture) => {
      const result = await runInstall(fixture, {
        ONYX_INSTALL_AUTH: "env",
        ONYX_INSTALL_PATH_ANSWER: "no",
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(
        "Use a global Onyx API key by adding this to your shell:"
      )
      expect(result.stdout).toContain('export ONYX_API_KEY="onyx_..."')
    })
  })

  test("post-install skill setup uses developer-aware sync first", async () => {
    await withFixture(async (fixture) => {
      const result = await runInstall(fixture, {
        ONYX_INSTALL_NO_PROMPT: "1",
      })

      expect(result.code).toBe(0)
      const log = await readFile(fixture.logPath, "utf8")
      expect(log).toContain("developer sync-skill --quiet")
      expect(log).toContain("agent install-skill --quiet")
    })
  })
})
