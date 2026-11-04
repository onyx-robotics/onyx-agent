import { expect, test } from "bun:test"

import { canOpenBrowser } from "./io"

test("a browser is tried only where one would open in front of the person", () => {
  expect(canOpenBrowser({}, "darwin")).toBe(true)
  expect(canOpenBrowser({ DISPLAY: ":0" }, "linux")).toBe(true)
  expect(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true)
  // a server, a container: no display
  expect(canOpenBrowser({}, "linux")).toBe(false)
  // over SSH it would open on the other machine
  expect(canOpenBrowser({ SSH_CONNECTION: "1 2 3 4", DISPLAY: ":0" }, "linux")).toBe(false)
  expect(canOpenBrowser({ SSH_TTY: "/dev/pts/1" }, "darwin")).toBe(false)
  expect(canOpenBrowser({ ONYX_NO_BROWSER: "1" }, "darwin")).toBe(false)
})
