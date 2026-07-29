import { describe, expect, test } from "bun:test"
import { access, readFile } from "node:fs/promises"

const generatorUrl = new URL(
  "../../analytics/scripts/generate-agent-analytics-protocol.ts",
  import.meta.url
)

describe("generated analytics protocol", () => {
  test("matches the private workspace source", async () => {
    try {
      await access(generatorUrl)
    } catch {
      return
    }
    const generator = (await import(generatorUrl.href)) as {
      expectedAgentAnalyticsProtocolFile: () => Promise<{
        target: string
        content: string
      }>
    }
    const expected = await generator.expectedAgentAnalyticsProtocolFile()
    await expect(readFile(expected.target, "utf8")).resolves.toBe(
      expected.content
    )
  })
})
