import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { expectedAgentProtocolFiles } from "../../contracts/scripts/generate-agent-protocol"

describe("generated protocol files", () => {
  test("match the private contracts source", async () => {
    for (const file of await expectedAgentProtocolFiles()) {
      await expect(readFile(file.target, "utf8")).resolves.toBe(file.content)
    }
  })
})
