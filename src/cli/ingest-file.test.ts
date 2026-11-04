import { expect, test } from "bun:test"

import { RecordReader } from "./ingest-file"

/** Each line's record or issues, read in order by one reader. */
async function read(lines: unknown[], opts = {}) {
  const r = new RecordReader(opts)
  const out = []
  for (const l of lines) out.push(await r.read(typeof l === "string" ? l : JSON.stringify(l)))
  return out
}

const run = {
  item: { ref: "run", type: "experiment", name: "r", source: { system: "ci", key: "1" } },
}

test("each line is one record in the API's shapes; blank lines are skipped", async () => {
  const [blank, notJson, two, unknown, bad, ok] = await read([
    "   ",
    "{nope",
    { item: {}, edge: {} },
    { thing: {} },
    { item: { type: "experiment" } },
    run,
  ])
  expect(blank).toEqual({ line: 1, record: null, issues: [] })
  expect(notJson!.issues).toEqual([{ line: 2, path: "", message: "not JSON" }])
  expect(two!.issues[0]!.message).toMatch(/one of/)
  expect(unknown!.issues[0]!.message).toMatch(/one of/)
  expect(bad!.issues.map((i) => i.path)).toEqual(["name"])
  expect(ok!.record).toEqual(run)
})

test("an item needs a key to be sent again safely, unless ids may be minted", async () => {
  const unkeyed = { item: { type: "experiment", name: "x" } }
  const [refused] = await read([unkeyed])
  expect(refused!.issues[0]!.message).toMatch(/needs a key/)
  const [minted] = await read([unkeyed], { mintIds: true })
  expect(minted!.issues).toEqual([])
  // an identity's revision is keyed by its number
  const [rev] = await read([
    run,
    { item: { type: "dataset", name: "v1", identity: "run", revision: 1 } },
  ]).then((x) => x.slice(1))
  expect(rev!.issues).toEqual([])
})

test("a ref is declared once, before it's used", async () => {
  const out = await read([
    { edge: { rel: "used", src: "run", dst: "data" } },
    run,
    run,
    { edge: { rel: "used", src: { ref: "run" }, dst: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" } },
  ])
  expect(out[0]!.issues.map((i) => i.path)).toEqual(["src", "dst"])
  expect(out[1]!.issues).toEqual([])
  expect(out[2]!.issues[0]).toMatchObject({ path: "ref", message: "ref run is declared twice" })
  expect(out[3]!.issues).toEqual([])
})

test("a metric report's id is its content's: stable, apart for replicates and runs", async () => {
  const metric = { metric: { entity: "run", values: { loss: 0.5 }, step: 1 } }
  const id = async (lines: unknown[], opts = {}) =>
    (await read(lines, opts)).flatMap((r) => {
      const m = r.record && "metric" in r.record ? r.record.metric.id : undefined
      return m ? [m] : []
    })
  const [a, b] = await id([run, metric, metric])
  // a file sent again: the same ids
  expect(await id([run, metric, metric])).toEqual([a!, b!])
  // two identical lines are two replicates
  expect(a).not.toBe(b)
  // another run of the same values
  expect((await id([run, metric], { namespace: "ci-812" }))[0]).not.toBe(a)
  // the file's ref label isn't what's hashed: the item's key is
  const renamed = { item: { ...run.item, ref: "the-run" } }
  expect(
    (await id([renamed, { metric: { ...metric.metric, entity: { ref: "the-run" } } }]))[0]
  ).toBe(a)
  // a report with its own id keeps it
  const own = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
  expect(await id([run, { metric: { ...metric.metric, id: own } }])).toEqual([own])
})
