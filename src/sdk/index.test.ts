import { expect, test } from "bun:test"

import { OnyxApiError, OnyxClient, uuidv7 } from "./index"

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error("no more responses")
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { impl, calls }
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
const fail = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers })
const result = {
  ids: {},
  items: { created: 1, updated: 0, unchanged: 0 },
  edges: { created: 0, unchanged: 0, closed: 0 },
  metrics: 0,
  refs: 0,
  txid: "1",
}

test("uuidv7 ids are version 7 and time-ordered", () => {
  const ids = Array.from({ length: 1000 }, () => uuidv7())
  expect(ids.every((id) => id[14] === "7")).toBe(true)
  expect([...ids].sort()).toEqual(ids)
})

test("ingest mints ids for items without one, and sends the bearer key", async () => {
  const f = fakeFetch([ok(result)])
  const c = new OnyxClient({ baseUrl: "http://x/", apiKey: "onyx_sk_k", fetch: f.impl })
  await c.ingest({
    items: [
      { type: "experiment", name: "a" },
      { type: "experiment", name: "b", source: { system: "s", key: "k" } },
    ],
  })
  const sent = JSON.parse(f.calls[0]!.init.body as string)
  expect(sent.items[0].id).toMatch(/^[0-9a-f-]{36}$/)
  expect(sent.items[1].id).toBeUndefined()
  expect(f.calls[0]!.url).toBe("http://x/api/v1/ingest")
  expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe(
    "Bearer onyx_sk_k"
  )
})

test("retries network errors, 429, 503 and retryable conflicts: the same request, one key", async () => {
  const f = fakeFetch([
    new TypeError("fetch failed"),
    fail(503, { error: { message: "unavailable" } }),
    fail(429, { error: { message: "slow down" } }, { "retry-after": "3" }),
    fail(409, {
      error: { message: "concurrent update, retry", code: "conflict", retryable: true },
    }),
    ok(result),
  ])
  const slept: number[] = []
  const sleep = async (ms: number) => void slept.push(ms)
  const c = new OnyxClient({
    baseUrl: "http://x",
    apiKey: "k",
    fetch: f.impl,
    maxRetries: 5,
    sleep,
  })
  const r = await c.ingest({ items: [{ type: "experiment", name: "a" }] })
  expect(r.items.created).toBe(1)
  // the same minted id every time, under the same Idempotency-Key: the server applies it once
  expect(new Set(f.calls.map((x) => x.init.body)).size).toBe(1)
  const keys = f.calls.map((x) => (x.init.headers as Record<string, string>)["idempotency-key"])
  expect(keys).toHaveLength(5)
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(new Set(keys).size).toBe(1)
  // a backoff before each retry, and a 429's Retry-After waited out
  expect(slept).toHaveLength(4)
  expect(slept[2]).toBe(3000)
})

test("does not retry validation errors or semantic conflicts", async () => {
  const f = fakeFetch([
    fail(400, {
      error: {
        message: "invalid ingest batch",
        code: "validation_failed",
        issues: [{ path: "items.0.type", message: "unknown type" }],
      },
    }),
  ])
  const c = new OnyxClient({ baseUrl: "http://x", apiKey: "k", fetch: f.impl })
  const err = await c.ingest({ items: [{ type: "nope", name: "a" }] }).catch((e) => e)
  expect(err).toBeInstanceOf(OnyxApiError)
  expect(err.issues[0].path).toBe("items.0.type")
  expect(f.calls.length).toBe(1)
  const g = fakeFetch([fail(409, { error: { message: "cycle", code: "conflict" } })])
  const c2 = new OnyxClient({ baseUrl: "http://x", apiKey: "k", fetch: g.impl })
  await expect(c2.link({ rel: "part_of", src: uuidv7(), dst: uuidv7() })).rejects.toThrow("cycle")
  expect(g.calls.length).toBe(1)
})

test("a batch that fits is one request (one transaction)", async () => {
  const f = fakeFetch([ok(result)])
  const c = new OnyxClient({ baseUrl: "http://x", apiKey: "k", fetch: f.impl })
  const b = c.batch()
  b.item({ ref: "a", type: "t", name: "a" })
  b.item({ ref: "b", type: "t", name: "b" })
  b.edge({ rel: "r", src: "a", dst: "b" })
  await b.flush()
  expect(f.calls.length).toBe(1)
  const body = JSON.parse(f.calls[0]!.init.body as string)
  expect(body.items).toHaveLength(2)
  // refs are rewritten to the items' ids, so they'd also work in a later flush
  expect(body.edges[0]).toEqual({
    rel: "r",
    src: { id: body.items[0].id },
    dst: { id: body.items[1].id },
  })
})

test("a split batch names source-keyed items by their key, which the server resolves", async () => {
  const f = fakeFetch([ok(result), ok(result), ok(result), ok(result)])
  const c = new OnyxClient({ baseUrl: "http://x", apiKey: "k", fetch: f.impl, batchSize: 1 })
  const b = c.batch()
  const run = b.item({ ref: "run", type: "t", name: "run" })
  const ds = b.item({ ref: "ds", type: "t", name: "ds", source: { system: "mlflow", key: "d-1" } })
  expect(ds).toEqual({ source: { system: "mlflow", key: "d-1" } })
  b.edge({ rel: "generated_by", src: "ds", dst: "run" })
  b.metric({ ref: "ds" }, { m: 1 })
  await b.flush()
  const bodies = f.calls.map((x) => JSON.parse(x.init.body as string))
  // no id is minted for the source-keyed item: an existing entity with that key keeps its own
  expect(bodies[1].items[0].id).toBeUndefined()
  expect(bodies[2].edges[0]).toEqual({
    rel: "generated_by",
    src: { source: { system: "mlflow", key: "d-1" } },
    dst: { id: run },
  })
  expect(bodies[3].metrics[0].entity).toEqual({ source: { system: "mlflow", key: "d-1" } })
})

test("uploadFile sends the file's bytes as they are, and what it is in the query", async () => {
  const f = fakeFetch([ok({ id: "r" })])
  const c = new OnyxClient({ baseUrl: "http://x", apiKey: "onyx_sk_k", fetch: f.impl })
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  await c.uploadFile("e1", bytes, { caption: "step 3", step: 3 })
  expect(f.calls[0]!.url).toBe("http://x/api/v1/files?entity=e1&caption=step+3&step=3")
  expect(f.calls[0]!.init.body).toBe(bytes)
  expect((f.calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe(
    "application/octet-stream"
  )
})
