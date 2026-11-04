import { expect, test } from "bun:test"

import { DeviceAuthorizationError, IngestStreamError, OnyxApiError, OnyxNetworkError } from "../sdk"

import type { Io } from "./io"
import { CliError, EXIT, exitCode, reportError, UsageError } from "./output"

const api = (status: number, retryable?: boolean) =>
  new OnyxApiError(status, { error: { code: "x", message: "m", retryable } })

test("exit codes tell kinds of failure apart", () => {
  expect(exitCode(new UsageError("u"))).toBe(EXIT.usage)
  expect(exitCode(api(400))).toBe(EXIT.invalid)
  expect(exitCode(api(401))).toBe(EXIT.auth)
  expect(exitCode(api(403))).toBe(EXIT.auth)
  expect(exitCode(api(404))).toBe(EXIT.notFound)
  expect(exitCode(api(409))).toBe(EXIT.conflict)
  expect(exitCode(api(409, true))).toBe(EXIT.unavailable)
  expect(exitCode(api(503))).toBe(EXIT.unavailable)
  expect(exitCode(new OnyxNetworkError("http://x/api/v1/me", new TypeError("fetch failed")))).toBe(
    EXIT.unavailable
  )
  // a bug isn't "the server is unavailable"
  expect(exitCode(new TypeError("undefined is not an object"))).toBe(EXIT.unexpected)
  expect(exitCode(new DeviceAuthorizationError("access_denied", "denied"))).toBe(EXIT.auth)
  expect(exitCode(new CliError("c", EXIT.conflict))).toBe(EXIT.conflict)
  expect(exitCode(new IngestStreamError("e", [], { first: 1, last: 2 }, null, api(400)))).toBe(
    EXIT.invalid
  )
  expect(exitCode(new Error("?"))).toBe(EXIT.unexpected)
})

function capture(isTTY = false) {
  const out: string[] = []
  const err: string[] = []
  const io = {
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    isTTY,
  } as unknown as Io
  return { io, out, err }
}

test("errors are the API's envelope in JSON, sentences for a person", () => {
  const e = new OnyxApiError(400, {
    error: {
      code: "validation_failed",
      message: "invalid ingest batch",
      issues: [{ path: "items.0.type", message: "unknown type" }],
      requestId: "r1",
    },
  })
  const j = capture()
  expect(reportError(j.io, "json", e)).toBe(EXIT.invalid)
  expect(JSON.parse(j.err.join(""))).toEqual({
    error: {
      code: "validation_failed",
      message: "invalid ingest batch",
      issues: [{ path: "items.0.type", message: "unknown type" }],
      requestId: "r1",
    },
  })
  const h = capture(true)
  reportError(h.io, "human", e)
  expect(h.err.join("")).toBe("error: invalid ingest batch\n  items.0.type: unknown type\n")
})
