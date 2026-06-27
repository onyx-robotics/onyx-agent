import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { resolveOpenCodeModelId } from "./lib/opencode-models"

async function writeFakeOpenCode(
  output: string,
  options: { exitCode?: number } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "onyx-opencode-models-"))
  const bin = join(root, "opencode")
  await writeFile(
    bin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "models" ]]; then',
      `  cat <<'MODELS'`,
      output,
      "MODELS",
      `  exit ${options.exitCode ?? 0}`,
      "fi",
      'echo "unexpected opencode command: $*" >&2',
      "exit 2",
      "",
    ].join("\n"),
    "utf8"
  )
  await chmod(bin, 0o755)
  return bin
}

describe("OpenCode model resolution", () => {
  test("accepts exact provider/model ids without probing opencode", async () => {
    await expect(
      resolveOpenCodeModelId("opencode/deepseek-v4-flash-free", {
        command: "/path/that/does/not/exist",
      })
    ).resolves.toBe("opencode/deepseek-v4-flash-free")
  })

  test("resolves human model names when one candidate contains all tokens", async () => {
    const command = await writeFakeOpenCode(
      [
        "opencode/deepseek-v4-flash",
        "opencode/deepseek-v4-flash-free",
        "opencode/qwen3.6-plus",
      ].join("\n")
    )

    await expect(
      resolveOpenCodeModelId("DeepSeek V4 Flash Free", { command })
    ).resolves.toBe("opencode/deepseek-v4-flash-free")
  })

  test("rejects ambiguous human model names with exact ids", async () => {
    const command = await writeFakeOpenCode(
      [
        "opencode/deepseek-v4-flash",
        "opencode/deepseek-v4-flash-free",
      ].join("\n")
    )

    await expect(
      resolveOpenCodeModelId("DeepSeek V4 Flash", { command })
    ).rejects.toThrow("matched multiple available model ids")
  })

  test("rejects unresolved human model names when model lookup fails", async () => {
    const command = await writeFakeOpenCode("auth missing", { exitCode: 7 })

    await expect(
      resolveOpenCodeModelId("DeepSeek V4 Flash Free", { command })
    ).rejects.toThrow("Unable to resolve OpenCode model")
  })
})
