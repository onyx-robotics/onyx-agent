import { expect, test } from "bun:test"

import {
  DeviceAuthorizationError,
  OnyxClient,
  OnyxNetworkError,
  pollDeviceToken,
  revokeToken,
  startDeviceAuthorization,
} from "./index"

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; body: string }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body ?? "") })
    const next = responses.shift()
    if (!next) throw new Error("no more responses")
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { impl, calls }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const oauth = (error: string) => json(400, { error, error_description: error })
const code = { deviceCode: "dc", interval: 5, expiresIn: 600 }

test("starting: form-encoded, with what the approval page shows about this machine", async () => {
  const f = fakeFetch([
    json(200, {
      device_code: "dc",
      user_code: "BCDF-GHJK",
      verification_uri: "http://x/device",
      verification_uri_complete: "http://x/device?code=BCDF-GHJK",
      expires_in: 600,
      interval: 5,
    }),
  ])
  const started = await startDeviceAuthorization({
    baseUrl: "http://x/",
    fetch: f.impl,
    client: { name: "onyx", hostname: "box" },
    scopes: ["read", "ingest"],
    org: "acme",
  })
  expect(started).toMatchObject({ userCode: "BCDF-GHJK", interval: 5, deviceCode: "dc" })
  expect(f.calls[0]!.url).toBe("http://x/api/v1/oauth/device")
  const sent = new URLSearchParams(f.calls[0]!.body)
  expect(Object.fromEntries(sent)).toEqual({
    client_id: "onyx-cli",
    scope: "read ingest",
    client_name: "onyx",
    hostname: "box",
    org: "acme",
  })
})

test("polling waits out pending, slows down when told, and rides out a lost connection", async () => {
  const waits: number[] = []
  const f = fakeFetch([
    oauth("authorization_pending"),
    oauth("slow_down"),
    new TypeError("fetch failed"),
    json(503, { error: { message: "busy" } }),
    json(200, {
      access_token: "onyx_pat_x",
      token_type: "Bearer",
      scope: "read ingest",
      expires_in: 2_592_000,
      org: { id: "o", name: "Acme", slug: "acme" },
    }),
  ])
  const token = await pollDeviceToken({
    baseUrl: "http://x",
    fetch: f.impl,
    code,
    sleep: async (ms) => void waits.push(ms),
  })
  expect(token).toEqual({
    token: "onyx_pat_x",
    scopes: ["read", "ingest"],
    expiresIn: 2_592_000,
    org: { id: "o", name: "Acme", slug: "acme" },
  })
  // the interval, then 5 s longer from the slow_down on
  expect(waits).toEqual([5000, 5000, 10000, 10000, 10000])
  expect(new URLSearchParams(f.calls[0]!.body).get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:device_code"
  )
})

test("a denial or an expired code ends it, with the RFC's code", async () => {
  for (const error of ["access_denied", "expired_token", "invalid_grant"]) {
    const f = fakeFetch([oauth(error)])
    const e = await pollDeviceToken({
      baseUrl: "http://x",
      fetch: f.impl,
      code,
      sleep: async () => {},
    })
      .then(() => null)
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DeviceAuthorizationError)
    expect((e as DeviceAuthorizationError).code).toBe(error)
  }
  // and the code's own lifetime
  const late = await pollDeviceToken({
    baseUrl: "http://x",
    fetch: fakeFetch([]).impl,
    code: { ...code, expiresIn: -1 },
    sleep: async () => {},
  }).catch((x: DeviceAuthorizationError) => x.code)
  expect(late).toBe("expired_token")
})

test("revoking posts the token; an unreachable server is a network error, not a bug", async () => {
  const f = fakeFetch([new Response(null, { status: 200 })])
  await revokeToken({ baseUrl: "http://x", fetch: f.impl, token: "onyx_pat_x" })
  expect(f.calls[0]!.url).toBe("http://x/api/v1/oauth/revoke")
  expect(new URLSearchParams(f.calls[0]!.body).get("token")).toBe("onyx_pat_x")

  const down = fakeFetch([new TypeError("fetch failed")])
  const e = await revokeToken({ baseUrl: "http://x", fetch: down.impl, token: "t" }).catch(
    (x: unknown) => x
  )
  expect(e).toBeInstanceOf(OnyxNetworkError)
  // the client too, after its retries
  const client = new OnyxClient({
    baseUrl: "http://x",
    token: "t",
    maxRetries: 0,
    fetch: fakeFetch([new TypeError("fetch failed")]).impl,
  })
  expect(await client.me().catch((x: unknown) => x)).toBeInstanceOf(OnyxNetworkError)
})
