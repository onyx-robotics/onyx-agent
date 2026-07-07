import { describe, expect, test } from "bun:test"
import { access, readFile } from "node:fs/promises"

const privateProtocolGenerator = new URL(
  "../../contracts/scripts/generate-agent-protocol.ts",
  import.meta.url
)

type ExpectedAgentProtocolFile = {
  target: string
  content: string
}

async function loadPrivateProtocolGenerator() {
  try {
    await access(privateProtocolGenerator)
  } catch {
    return null
  }

  return (await import(privateProtocolGenerator.href)) as {
    expectedAgentProtocolFiles: () => Promise<ExpectedAgentProtocolFile[]>
  }
}

describe("generated protocol files", () => {
  test("match the private contracts source", async () => {
    const generator = await loadPrivateProtocolGenerator()
    if (!generator) return

    for (const file of await generator.expectedAgentProtocolFiles()) {
      await expect(readFile(file.target, "utf8")).resolves.toBe(file.content)
    }
  })
})
