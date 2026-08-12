import { describe, expect, test } from "bun:test"

import { browserOpenCommand } from "./lib/login"

const LOGIN_URL =
  "https://app.onyxresearch.ai/cli/login?redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback&state=state-1&profiles=eyJ2IjoxfQ"

describe("browserOpenCommand", () => {
  test("caret-escapes `&` on Windows so cmd does not split the URL", () => {
    const { command, args } = browserOpenCommand("win32", LOGIN_URL)

    expect(command).toBe("cmd")
    expect(args).toEqual(["/c", "start", "", LOGIN_URL.replace(/&/g, "^&")])
  })

  test("keeps every login query parameter in the Windows argument", () => {
    const { args } = browserOpenCommand("win32", LOGIN_URL)
    const urlArg = args.at(-1) ?? ""

    // Quoting the URL instead does not survive: Node escapes embedded quotes
    // as `\"`, cmd does not honor that escape, so the quoted region closes
    // early and the `&` splits the URL anyway.
    expect(urlArg).not.toContain('"')
    expect(urlArg).toContain("^&state=state-1")
    expect(urlArg).toContain("^&profiles=eyJ2IjoxfQ")
  })

  test("passes the URL as a single argument on macOS and Linux", () => {
    expect(browserOpenCommand("darwin", LOGIN_URL)).toEqual({
      command: "open",
      args: [LOGIN_URL],
    })
    expect(browserOpenCommand("linux", LOGIN_URL)).toEqual({
      command: "xdg-open",
      args: [LOGIN_URL],
    })
  })
})
