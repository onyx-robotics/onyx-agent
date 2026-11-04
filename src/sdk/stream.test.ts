import { expect, test } from "bun:test"

import type { IngestBatch } from "../generated/contracts/contracts"

import { IngestStreamError, OnyxClient, reportId } from "./index"

/** A server that answers ingest with an id for each item (a minted id is kept), or an error. */
function server(fail?: (batch: IngestBatch, n: number) => Response | undefined) {
  const batches: IngestBatch[] = []
  const urls: string[] = []
  let made = 0
  const impl = (async (url: string, init: RequestInit) => {
    const batch = JSON.parse(init.body as string) as IngestBatch
    batches.push(batch)
    urls.push(url)
    const refused = fail?.(batch, batches.length)
    if (refused) return refused
    const itemIds = (batch.items ?? []).map(
      (it) => it.id ?? `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}`
    )
    return Response.json({
      ids: {},
      itemIds,
      items: { created: itemIds.length, updated: 0, unchanged: 0 },
      edges: { created: batch.edges?.length ?? 0, unchanged: 0, closed: 0 },
      metrics: batch.metrics?.length ?? 0,
      refs: batch.refs?.length ?? 0,
      txid: String(batches.length),
    })
  }) as unknown as typeof fetch
  const client = new OnyxClient({ baseUrl: "http://x", token: "onyx_pat_t", fetch: impl })
  return { client, batches, urls }
}

const item = (ref: string, extra: object = {}) => ({
  item: { ref, type: "experiment", name: ref, source: { system: "t", key: ref }, ...extra },
})

test("records go in chunks of whole requests, and the totals add up", async () => {
  const { client, batches } = server()
  const chunks: [number, number][] = []
  const s = client.stream({
    chunkItems: 2,
    onChunk: (_r, range) => void chunks.push([range.first, range.last]),
  })
  for (let i = 1; i <= 5; i++) await s.add(item(`r${i}`), i)
  const totals = await s.close()
  expect(batches.map((b) => b.items?.length)).toEqual([2, 2, 1])
  expect(chunks).toEqual([
    [1, 2],
    [3, 4],
    [5, 5],
  ])
  expect(totals).toMatchObject({
    chunks: 3,
    records: 5,
    items: { created: 5 },
    txids: ["1", "2", "3"],
  })
})

test("a chunk stays under its byte budget", async () => {
  const { client, batches } = server()
  const s = client.stream({ maxBytes: 600 })
  for (let i = 0; i < 6; i++) await s.add(item(`r${i}`, { summary: "x".repeat(150) }), i)
  await s.close()
  expect(batches.length).toBeGreaterThan(1)
  for (const b of batches) expect(JSON.stringify(b).length).toBeLessThan(600)
})

test("a ref declared in an earlier chunk becomes the id the server gave its item", async () => {
  const { client, batches } = server()
  const s = client.stream({ chunkItems: 1 })
  await s.add(item("run"), 1)
  await s.add(item("rig"), 2)
  // same chunk as rig: left to the server; run's chunk was sent: its id
  await s.add({ edge: { rel: "tested", src: "run", dst: "rig" } }, 3)
  await s.add({ metric: { entity: { ref: "run" }, values: { x: 1 } } }, 4)
  await s.close()
  const [first, second] = batches
  expect(first!.items![0]!.id).toBeUndefined() // source-keyed: the server chooses its id
  // the fake server's id for run, the first item it made
  const run = { id: "00000000-0000-4000-8000-000000000001" }
  expect(second!.edges![0]).toEqual({ rel: "tested", src: run, dst: "rig" })
  expect(second!.metrics![0]!.entity).toEqual(run)
})

test("a source label isn't a ref: it isn't resolved across chunks", async () => {
  const { client, batches } = server()
  const s = client.stream({ chunkItems: 1 })
  await s.add({ item: { type: "experiment", name: "x", source: { system: "ci", key: "x" } } }, 1)
  await s.add(item("y"), 2)
  await s.add({ edge: { rel: "used", src: "ci:x", dst: "y" } }, 3)
  await s.close()
  // left as written: the server says it's an unknown ref, whichever chunk it's in
  expect(batches.at(-1)!.edges![0]!.src).toBe("ci:x")
})

test("an error names the record it's about, and what was written before it", async () => {
  const { client } = server((batch, n) =>
    n === 2
      ? Response.json(
          {
            error: {
              code: "validation_failed",
              message: "invalid ingest batch",
              issues: [
                { path: "items.1.props.fidelity", message: "expected one of sim, hil, hardware" },
                { path: "edges", message: "too many" },
              ],
            },
          },
          { status: 400 }
        )
      : undefined
  )
  const s = client.stream({ chunkItems: 2 })
  const add = async () => {
    for (let i = 1; i <= 4; i++) await s.add(item(`r${i}`), i * 10)
    await s.close()
  }
  const e = await add().then(
    () => null,
    (x: unknown) => x
  )
  expect(e).toBeInstanceOf(IngestStreamError)
  const err = e as IngestStreamError<number>
  expect(err.message).toBe("invalid ingest batch")
  expect(err.range).toEqual({ first: 30, last: 40 })
  expect(err.committedThrough).toBe(20)
  expect(err.issues).toEqual([
    { origin: 40, path: "props.fidelity", message: "expected one of sim, hil, hardware" },
    { path: "edges", message: "too many" },
  ])
})

test("report ids come from what's reported: the same report, the same id", async () => {
  const report = {
    entity: { source: { system: "ci", key: "run-1" } },
    values: { loss: 0.5 },
    step: 3,
  }
  const id = await reportId(report)
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  // pinned: report ids are kept by the server, so this must never change
  expect(id).toBe("de06ba62-cb10-838a-94bc-88875e83affe")
  // key order doesn't matter; a given id is ignored
  expect(await reportId({ step: 3, values: { loss: 0.5 }, entity: report.entity, id: "x" })).toBe(
    id
  )
  // replicates and other runs are other reports
  expect(await reportId(report, 1)).not.toBe(id)
  expect(await reportId(report, 0, "ci-812")).not.toBe(id)
  expect(await reportId({ ...report, values: { loss: 0.4 } })).not.toBe(id)
})

test("a builder's refs keep naming items flushed before", async () => {
  const { client, batches } = server()
  const b = client.batch()
  const a = b.item({ ref: "a", type: "experiment", name: "a" })
  await b.flush()
  b.item({ ref: "b", type: "dataset", name: "b" })
  b.edge({ rel: "generated_by", src: "b", dst: "a" })
  await b.flush()
  expect(batches[1]!.edges![0]).toMatchObject({ dst: { id: a } })
})

test("a dry run checks the first chunk and sends nothing after it", async () => {
  const { client, urls } = server()
  const s = client.stream({ chunkItems: 2, dryRun: true })
  for (let i = 1; i <= 5; i++) await s.add(item(`r${i}`), i)
  const totals = await s.close()
  expect(urls).toEqual(["http://x/api/v1/ingest?dryRun=1"])
  expect(totals).toMatchObject({ chunks: 1, records: 2, dryRun: true, unchecked: 3 })
})
