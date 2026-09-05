import { describe, expect, spyOn, test } from "bun:test"

import { parseArgs } from "./args"
import { classifyApiUrl, confirmApiUrlTrust } from "./api-url-trust"

const config = { issuer: "https://auth.example.test", clientId: "client_cli" }

describe("custom API URL trust", () => {
  test("classifies production, localhost, and custom servers", () => {
    expect(classifyApiUrl("https://app.onyxresearch.ai")).toBe("production")
    expect(classifyApiUrl("http://localhost:3000")).toBe("localhost")
    expect(classifyApiUrl("http://127.0.0.1:3000")).toBe("localhost")
    expect(classifyApiUrl("https://onyx.example.com")).toBe("custom")
    expect(classifyApiUrl("not a url")).toBe("custom")
  })

  test("trusts production and localhost without asking", async () => {
    await confirmApiUrlTrust({
      apiUrl: "https://app.onyxresearch.ai",
      config,
      args: parseArgs(["login"]),
      ask: async () => {
        throw new Error("should not prompt")
      },
    })
    await confirmApiUrlTrust({
      apiUrl: "http://localhost:3000",
      config,
      args: parseArgs(["login"]),
      ask: async () => {
        throw new Error("should not prompt")
      },
    })
  })

  test("requires confirmation or --trust-api-url for custom servers", async () => {
    const apiUrl = "https://onyx.example.com"
    const answers: string[] = []
    const printed: string[] = []
    const log = spyOn(console, "log").mockImplementation((...parts) => {
      printed.push(parts.map(String).join(" "))
    })
    try {
      await confirmApiUrlTrust({
        apiUrl,
        config,
        args: parseArgs(["login"]),
        ask: async (prompt) => {
          answers.push(prompt)
          return "y"
        },
      })
    } finally {
      log.mockRestore()
    }
    expect(answers).toHaveLength(1)
    // The disclosure names the strongest exposure: brokered device login hands
    // the custom server the refresh token.
    expect(printed.join("\n")).toContain("refresh token")
    expect(printed.join("\n")).toContain(config.issuer)
    await expect(
      confirmApiUrlTrust({
        apiUrl,
        config,
        args: parseArgs(["login"]),
        ask: async () => "n",
      })
    ).rejects.toThrow("Login cancelled")
    await confirmApiUrlTrust({
      apiUrl,
      config,
      args: parseArgs(["login", "--trust-api-url"]),
      ask: async () => {
        throw new Error("should not prompt")
      },
    })
    // Non-interactive shells cannot answer; the test runner has no TTY.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      await expect(
        confirmApiUrlTrust({ apiUrl, config, args: parseArgs(["login"]) })
      ).rejects.toThrow("--trust-api-url")
    }
  })
})
