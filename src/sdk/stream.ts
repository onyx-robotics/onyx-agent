/**
 * Streaming ingest: records in the order they come (an NDJSON file, a generator), sent in chunks
 * that each fit one request and one transaction.
 *
 *   const stream = onyx.stream({ onChunk: (r, range) => console.log(range, r.txid) })
 *   for await (const [line, record] of lines) await stream.add(record, line)
 *   const totals = await stream.close()
 *
 * Within a chunk the server resolves batch-local refs itself. A ref declared by an item in an
 * earlier chunk is rewritten to the id the server gave that item (`IngestResult.itemIds`), so
 * refs work across chunks whatever their items are keyed by. A ref must be declared before it's
 * used, and a file isn't one transaction: each chunk commits on its own, so a file that stops
 * partway is sent again whole (its keyed records come back unchanged). Errors name the record
 * they're about by the origin it was added with (a line number, say).
 */
import type {
  IngestBatch,
  IngestEdge,
  IngestItem,
  IngestMetrics,
  IngestRef,
  IngestResult,
  ItemRefInput,
} from "../generated/contracts/contracts"

import { OnyxApiError } from "./errors"
import { uuidv7, withItemDefaults } from "./ids"

/** One record of a stream (one line of an NDJSON ingest file): the API's own shapes. */
export type IngestRecord =
  | { item: IngestItem }
  | { edge: IngestEdge }
  | { metric: IngestMetrics }
  | { ref: IngestRef }

/** The server's batch limits (contracts/write.ts `ingestBatch`). */
export const BATCH_LIMITS = { items: 2000, edges: 5000, metrics: 2000, refs: 2000 } as const

export interface IngestStreamOptions<O> {
  /** items per chunk (default 1000, at most 2000) */
  chunkItems?: number
  /** a chunk's request body stays under this many bytes (default 3.5 MB: hosts cap requests) */
  maxBytes?: number
  /**
   * check, write nothing: the first chunk is checked as a write and rolled back, and the rest
   * isn't sent (it names items the first chunk would have made)
   */
  dryRun?: boolean
  /** after each chunk the server took: its result and the origins of its first and last records */
  onChunk?: (result: IngestResult, range: { first: O; last: O; records: number }) => unknown
}

/** What a stream sent, added up. */
export interface IngestTotals {
  chunks: number
  records: number
  items: { created: number; updated: number; unchanged: number }
  edges: { created: number; unchanged: number; closed: number }
  /** metric values sent */
  metrics: number
  /** of those, values recorded now, and values already recorded (sent before) */
  observations: { new: number; recognised: number }
  refs: number
  txids: string[]
  /** a dry run: what the first chunk would do (nothing was written) */
  dryRun?: true
  /** a dry run: records added after the chunk it checked, not sent */
  unchecked?: number
}

export interface IngestIssue<O> {
  /** the record the issue is about, when the server named one */
  origin?: O
  /** where in the record (`props.fidelity`), or in the batch when no record was named */
  path: string
  message: string
}

/** A chunk the server refused: what it said, by record. Chunks before it were written. */
export class IngestStreamError<O> extends Error {
  readonly issues: IngestIssue<O>[]
  /** the chunk's first and last records */
  readonly range: { first: O; last: O }
  /** the last record of the last chunk written, if any */
  readonly committedThrough: O | null
  readonly cause: unknown

  constructor(
    message: string,
    issues: IngestIssue<O>[],
    range: { first: O; last: O },
    committedThrough: O | null,
    cause: unknown
  ) {
    super(message)
    this.name = "IngestStreamError"
    this.issues = issues
    this.range = range
    this.committedThrough = committedThrough
    this.cause = cause
  }
}

/** What a stream needs of the client. */
export interface IngestTarget {
  ingest(batch: IngestBatch, opts?: { dryRun?: boolean }): Promise<IngestResult>
}

type Kind = "items" | "edges" | "metrics" | "refs"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The batch-local ref an item reference names, if it names one. */
function refName(r: ItemRefInput | undefined): string | null {
  if (typeof r === "string") return UUID.test(r) ? null : r
  if (r && typeof r === "object" && "ref" in r) return r.ref
  return null
}

const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length

export class IngestStream<O = number> {
  private readonly chunkItems: number
  private readonly maxBytes: number
  /** refs declared by items in chunks already sent -> the item's id */
  private readonly declared = new Map<string, string>()
  private chunk = this.empty()
  private last: O | null = null
  private readonly totals: IngestTotals = {
    chunks: 0,
    records: 0,
    items: { created: 0, updated: 0, unchanged: 0 },
    edges: { created: 0, unchanged: 0, closed: 0 },
    metrics: 0,
    observations: { new: 0, recognised: 0 },
    refs: 0,
    txids: [],
  }

  constructor(
    private readonly target: IngestTarget,
    private readonly opts: IngestStreamOptions<O> = {}
  ) {
    this.chunkItems = Math.min(opts.chunkItems ?? 1000, BATCH_LIMITS.items)
    this.maxBytes = opts.maxBytes ?? 3_500_000
  }

  private empty() {
    return {
      batch: { items: [], edges: [], metrics: [], refs: [] } as Required<{
        [K in Kind]: NonNullable<IngestBatch[K]>
      }>,
      origins: { items: [], edges: [], metrics: [], refs: [] } as Record<Kind, O[]>,
      order: [] as O[],
      /** refs declared by this chunk's items */
      refs: new Set<string>(),
      bytes: 64,
    }
  }

  /** A reference from this chunk: one declared in an earlier chunk becomes that item's id. */
  private resolve<R extends ItemRefInput | undefined>(r: R): R | { id: string } {
    const name = refName(r)
    if (name === null || this.chunk.refs.has(name)) return r
    const id = this.declared.get(name)
    return id ? { id } : r
  }

  /** Add a record, sending the chunk before it when it's full. */
  async add(record: IngestRecord, origin: O): Promise<void> {
    if (this.totals.dryRun) {
      this.totals.unchecked = (this.totals.unchecked ?? 0) + 1
      return
    }
    const [kind, value] = this.prepare(record)
    const size = bytes(value) + 1
    const c = this.chunk
    const full =
      c.order.length > 0 &&
      ((kind === "items" && c.batch.items.length >= this.chunkItems) ||
        (kind !== "items" && c.batch[kind].length >= BATCH_LIMITS[kind]) ||
        c.bytes + size > this.maxBytes)
    if (full) {
      await this.flush()
      // its refs may now be ones the chunk just sent declared
      return this.add(record, origin)
    }
    ;(c.batch[kind] as unknown[]).push(value)
    c.origins[kind].push(origin)
    c.order.push(origin)
    c.bytes += size
    if (kind === "items") {
      const ref = (value as IngestItem).ref
      if (ref) c.refs.add(ref)
    }
  }

  private prepare(record: IngestRecord): [Kind, unknown] {
    if ("item" in record) {
      const it = withItemDefaults(record.item)
      return [
        "items",
        {
          ...it,
          ...(it.identity !== undefined ? { identity: this.resolve(it.identity) } : {}),
          ...(it.createdBy !== undefined ? { createdBy: this.resolve(it.createdBy) } : {}),
        },
      ]
    }
    if ("edge" in record) {
      const e = record.edge
      return ["edges", { ...e, src: this.resolve(e.src), dst: this.resolve(e.dst) }]
    }
    if ("metric" in record) {
      const m = record.metric
      return [
        "metrics",
        {
          ...m,
          id: m.id ?? uuidv7(),
          entity: this.resolve(m.entity),
          ...(m.context !== undefined ? { context: this.resolve(m.context) } : {}),
        },
      ]
    }
    if ("ref" in record) {
      return ["refs", { ...record.ref, entity: this.resolve(record.ref.entity) }]
    }
    throw new Error("a record is one of item, edge, metric or ref")
  }

  /** Send what's buffered as one request. */
  async flush(): Promise<void> {
    const c = this.chunk
    if (!c.order.length) return
    let result: IngestResult
    try {
      result = this.opts.dryRun
        ? await this.target.ingest(c.batch, { dryRun: true })
        : await this.target.ingest(c.batch)
    } catch (e) {
      throw this.explain(e, c)
    }
    c.batch.items.forEach((it, i) => {
      const id = result.itemIds?.[i]
      if (it.ref && id) this.declared.set(it.ref, id)
    })
    this.chunk = this.empty()
    this.last = c.order.at(-1)!
    const t = this.totals
    t.chunks++
    t.records += c.order.length
    for (const k of ["created", "updated", "unchanged"] as const) t.items[k] += result.items[k]
    for (const k of ["created", "unchanged", "closed"] as const) t.edges[k] += result.edges[k]
    t.metrics += result.metrics
    t.observations.new += result.observations?.new ?? 0
    t.observations.recognised += result.observations?.recognised ?? 0
    t.refs += result.refs
    if (result.txid) t.txids.push(result.txid)
    if (this.opts.dryRun) t.dryRun = true
    await this.opts.onChunk?.(result, {
      first: c.order[0]!,
      last: c.order.at(-1)!,
      records: c.order.length,
    })
  }

  /** Send the rest; what was sent, added up. */
  async close(): Promise<IngestTotals> {
    await this.flush()
    return this.totals
  }

  private explain(e: unknown, c: ReturnType<IngestStream<O>["empty"]>): unknown {
    if (!(e instanceof OnyxApiError)) return e
    const range = { first: c.order[0]!, last: c.order.at(-1)! }
    const issues: IngestIssue<O>[] = (e.issues ?? []).map((i) => {
      const m = /^(items|edges|metrics|refs)\.(\d+)(?:\.(.*))?$/.exec(i.path)
      const origin = m ? c.origins[m[1] as Kind][Number(m[2])] : undefined
      return origin === undefined
        ? { path: i.path, message: i.message }
        : { origin, path: m![3] ?? "", message: i.message }
    })
    const message = e.message.split(": ")[0] ?? e.message
    return new IngestStreamError(message, issues, range, this.last, e)
  }
}
