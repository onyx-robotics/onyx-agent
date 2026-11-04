/**
 * An ingest file: NDJSON, one record per line, each exactly one of
 *
 *   {"item": IngestItem}   {"edge": IngestEdge}   {"metric": IngestMetrics}   {"ref": IngestRef}
 *
 * in the API's own shapes (@onyx/core/contracts). Sending the same file again gives the same
 * state, so every record must be recognisable when it comes back:
 *
 * - an item carries a key: an `id`, a `source` key, or an `identity` and `revision` (else a
 *   re-run would make it again; `mintIds` allows it, minting an id each run);
 * - a metric report without an `id` gets one derived from what it reports (sdk `reportId`), its
 *   entity and context named by their items' keys rather than the file's ref labels, counted so
 *   identical lines stay replicates, and namespaced (a CI run, say) when given;
 * - edges and refs are recognised by the server as they are.
 *
 * A ref (an item's `ref`, used as a plain string or `{ref}`) must be declared once, on an earlier
 * line. Blank lines are skipped. Problems are reported by line.
 */
import {
  ingestEdge,
  ingestItem,
  ingestMetrics,
  ingestRef,
  type IngestItem,
  type ItemRefInput,
} from "../generated/contracts/contracts"
import { canonicalJson, reportId, type IngestRecord } from "../sdk"
import type { z } from "zod"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SCHEMAS: Record<string, z.ZodType> = {
  item: ingestItem,
  edge: ingestEdge,
  metric: ingestMetrics,
  ref: ingestRef,
}

export interface LineIssue {
  line: number
  path: string
  message: string
}

export interface ReadOptions {
  /** items without a key get a new id each run (a re-run makes them again) */
  mintIds?: boolean
  /** keeps this run's metric reports apart from the same values sent by another run */
  namespace?: string
}

/** The batch-local ref an item reference names, if it names one. */
function refName(r: ItemRefInput | undefined): string | null {
  if (typeof r === "string") return UUID.test(r) ? null : r
  if (r && typeof r === "object" && "ref" in r) return r.ref
  return null
}

/** What an item is known by from run to run (never its ref label). */
type StableKey =
  | { id: string }
  | { source: { system: string; key: string } }
  | { identity: StableKey; revision: number }
  | { minted: string }

/**
 * Reads a file's records in order, checking each. Stateful (declared refs, report counts):
 * one reader per pass over a file.
 */
export class RecordReader {
  /** declared refs -> what their items are known by */
  private readonly refs = new Map<string, StableKey>()
  private readonly reports = new Map<string, number>()
  private line = 0

  constructor(private readonly opts: ReadOptions = {}) {}

  /** The next line's record, null for a blank line, or what's wrong with it. */
  async read(
    text: string
  ): Promise<{ line: number; record: IngestRecord | null; issues: LineIssue[] }> {
    const line = ++this.line
    const issues: LineIssue[] = []
    const fail = (path: string, message: string) => {
      issues.push({ line, path, message })
      return { line, record: null, issues }
    }
    if (!text.trim()) return { line, record: null, issues }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return fail("", "not JSON")
    }
    const kinds = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : []
    if (kinds.length !== 1 || !SCHEMAS[kinds[0]!])
      return fail("", 'a record is one of {"item": …}, {"edge": …}, {"metric": …} or {"ref": …}')
    const kind = kinds[0]!
    const value = (raw as Record<string, unknown>)[kind]
    const parsed = SCHEMAS[kind]!.safeParse(value)
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        issues.push({ line, path: i.path.join("."), message: i.message })
      return { line, record: null, issues }
    }
    // refs it uses must have been declared before
    const uses = (path: string, r: ItemRefInput | undefined) => {
      const name = refName(r)
      if (name !== null && !this.refs.has(name))
        issues.push({
          line,
          path,
          message: `ref ${name} isn't declared by an item on an earlier line`,
        })
    }
    if (kind === "item") {
      const it = value as IngestItem
      uses("identity", it.identity)
      uses("createdBy", it.createdBy)
      const key = this.keyOf(it)
      if (!key) {
        issues.push({
          line,
          path: "",
          message:
            "an item needs a key to be sent again safely: an id, a source key, or identity and revision (or --mint-ids)",
        })
      }
      if (it.ref !== undefined) {
        if (this.refs.has(it.ref))
          issues.push({ line, path: "ref", message: `ref ${it.ref} is declared twice` })
        else if (key) this.refs.set(it.ref, key)
      }
      if (issues.length) return { line, record: null, issues }
      return { line, record: { item: it }, issues }
    }
    if (kind === "edge") {
      const e = value as IngestRecord & { src: ItemRefInput; dst: ItemRefInput }
      uses("src", e.src)
      uses("dst", e.dst)
    }
    if (kind === "ref") uses("entity", (value as { entity: ItemRefInput }).entity)
    if (kind === "metric") {
      const m = value as { id?: string; entity: ItemRefInput; context?: ItemRefInput }
      uses("entity", m.entity)
      uses("context", m.context)
      if (issues.length) return { line, record: null, issues }
      if (!m.id) {
        // what it reports, its items named by their keys: the same report, the same id
        const report = {
          ...m,
          entity: this.stable(m.entity),
          ...(m.context !== undefined ? { context: this.stable(m.context) } : {}),
        }
        const text = canonicalJson(report)
        const occurrence = this.reports.get(text) ?? 0
        this.reports.set(text, occurrence + 1)
        const id = await reportId(report, occurrence, this.opts.namespace ?? "")
        return { line, record: { metric: { ...(value as object), id } as never }, issues }
      }
    }
    if (issues.length) return { line, record: null, issues }
    return { line, record: { [kind]: value } as IngestRecord, issues }
  }

  /** An item's key, or a minted one (`mintIds`), or null. */
  private keyOf(it: IngestItem): StableKey | null {
    if (it.id) return { id: it.id }
    if (it.source) return { source: it.source }
    if (it.identity !== undefined && it.revision !== undefined)
      return { identity: this.stable(it.identity), revision: it.revision }
    // minted ids differ every run, so a metric about this item is a new report every run too
    return this.opts.mintIds ? { minted: crypto.randomUUID() } : null
  }

  /** A reference by what its item is known by. */
  private stable(r: ItemRefInput): StableKey {
    const name = refName(r)
    if (name !== null) return this.refs.get(name)!
    if (typeof r === "string") return { id: r }
    return r as StableKey
  }
}
