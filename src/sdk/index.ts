/**
 * Onyx SDK for agents and scripts.
 *
 *   const onyx = new OnyxClient({ baseUrl: "https://onyx.example.com", apiKey: process.env.ONYX_API_KEY! })
 *   const run = onyx.newId()
 *   await onyx.ingest({
 *     items: [{ id: run, type: "sysid_run", name: "fit arm model", status: "running", props: { fidelity: "hil" } }],
 *     edges: [{ rel: "tested", src: run, dst: { source: { system: "plm", key: "arm-2" } } }],
 *   })
 *
 * Every write carries an Idempotency-Key that its retries reuse (network errors, 429/5xx,
 * retryable conflicts), so the server applies it once; the client also mints UUIDv7 ids for
 * new items and for metric reports (a report sent twice is recorded once).
 *
 * Revisions: an item with `identity` is a new revision of it and becomes its head (what
 * `pin: true` edges resolve to) unless `head: false` or an explicit `revision` number is given
 * (importing history).
 *
 * The token is an API key (`onyx_sk_…`: an AI agent) or a member's personal token (`onyx_pat_…`:
 * that member). Records in order, from a file say, go through `stream()` (stream.ts).
 */
import type {
  ExtendRegistryInput,
  JobSubmit,
  KgRelated,
  KgRelatedInput,
  RunKeysRun,
  RunnerSyncInput,
  RunnerSyncResult,
  SubmitJobsResult,
} from "../generated/contracts/contracts"
import type {
  IngestBatch,
  IngestEdge,
  IngestItem,
  IngestMetrics,
  IngestRef,
  IngestResult,
  ItemRefInput,
  LineageQueryInput,
  ReassignInput,
  UpdateEntityInput,
} from "../generated/contracts/contracts"

import { OnyxApiError, OnyxNetworkError } from "./errors"
import { uuidv7, withItemDefaults } from "./ids"
import { IngestStream, type IngestStreamOptions } from "./stream"

export { OnyxApiError, OnyxNetworkError, type ApiErrorBody } from "./errors"
export {
  DeviceAuthorizationError,
  pollDeviceToken,
  revokeToken,
  startDeviceAuthorization,
  type DeviceCode,
  type DeviceToken,
} from "./device"
export { canonicalJson, reportId, uuidv7 } from "./ids"
export {
  BATCH_LIMITS,
  IngestStream,
  IngestStreamError,
  type IngestIssue,
  type IngestRecord,
  type IngestStreamOptions,
  type IngestTarget,
  type IngestTotals,
} from "./stream"

export type {
  JobSubmit,
  KgRelated,
  KgRelatedInput,
  RunKeysRun,
  RunnerSyncInput,
  RunnerSyncResult,
  SubmitJobsResult,
}
export type {
  IngestBatch,
  IngestEdge,
  IngestItem,
  IngestMetrics,
  IngestRef,
  IngestResult,
  ItemRefInput,
  ReassignInput,
  UpdateEntityInput,
}

/** When a metric was measured, and over what. */
export interface MetricOptions {
  context?: ItemRefInput
  step?: number
  observedAt?: string
  n?: number
  stddev?: number
  /** the dense series the values summarize: a ref of the same entity (its id, or system and locator) */
  series?: string | { system: string; locator: string; version?: string }
  /** how it was measured (at most 8 KB) */
  props?: Record<string, unknown>
}

export interface OnyxClientOptions {
  baseUrl: string
  /** an API key (`onyx_sk_…`) or a personal token (`onyx_pat_…`) */
  token?: string
  /** the same as `token` (older name) */
  apiKey?: string
  fetch?: typeof fetch
  /** retries for network errors, 429, 5xx and retryable conflicts (default 4) */
  maxRetries?: number
  timeoutMs?: number
  /** max items per request when flushing a BatchBuilder (default 1000) */
  batchSize?: number
  /** waits out a retry's backoff (default: a timer) */
  sleep?: (ms: number) => Promise<void>
}

const isMetricOptions = (x: object): x is MetricOptions =>
  !("id" in x) && !("ref" in x) && !("source" in x)

export class OnyxClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly timeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  readonly batchSize: number

  constructor(opts: OnyxClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    const token = opts.token ?? opts.apiKey
    if (!token) throw new Error("OnyxClient needs a token (an API key or a personal token)")
    this.token = token
    this.fetchImpl = opts.fetch ?? fetch
    this.maxRetries = opts.maxRetries ?? 4
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.batchSize = opts.batchSize ?? 1000
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  newId(): string {
    return uuidv7()
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let attempt = 0
    // one key per write, reused by every retry: the server runs it once and replays the answer
    const idempotencyKey = method === "GET" ? undefined : uuidv7()
    for (;;) {
      let res: Response | undefined
      let networkError: unknown
      try {
        res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (e) {
        networkError = e
      }
      if (res?.ok) return (res.status === 204 ? undefined : await res.json()) as T
      const err = res ? new OnyxApiError(res.status, await res.json().catch(() => ({}))) : undefined
      const retryable = networkError !== undefined || err!.retryable
      if (!retryable || attempt >= this.maxRetries)
        throw err ?? new OnyxNetworkError(`${this.baseUrl}/api/v1${path}`, networkError)
      const retryAfter = Number(res?.headers.get("retry-after") ?? 0) * 1000
      await this.sleep(
        Math.max(retryAfter, Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2))
      )
      attempt++
    }
  }

  /**
   * Items without an id or source key, and metric reports without an id, get client-minted
   * ids, so a batch sent again is recognised.
   */
  ingest(batch: IngestBatch, opts: { dryRun?: boolean } = {}): Promise<IngestResult> {
    const items = batch.items?.map(withItemDefaults)
    const metrics = batch.metrics?.map((m) => (m.id ? m : { ...m, id: uuidv7() }))
    return this.request("POST", opts.dryRun ? "/ingest?dryRun=1" : "/ingest", {
      ...batch,
      ...(items ? { items } : {}),
      ...(metrics ? { metrics } : {}),
    })
  }

  /**
   * What a batch would do, checked as a write and rolled back: nothing is kept (its `txid` is
   * null). It takes a write's locks while it runs.
   */
  dryRun(batch: IngestBatch): Promise<Omit<IngestResult, "txid"> & { txid: null; dryRun: true }> {
    return this.ingest(batch, { dryRun: true }) as never
  }

  /** Send records in order, in chunks of one request each (stream.ts). */
  stream<O = number>(opts: IngestStreamOptions<O> = {}): IngestStream<O> {
    return new IngestStream<O>(this, opts)
  }

  async createEntity(item: IngestItem): Promise<{ id: string }> {
    const withId = withItemDefaults(item)
    const r = await this.ingest({ items: [withId] })
    return { id: Object.values(r.ids)[0]! }
  }

  link(edge: IngestEdge): Promise<IngestResult> {
    return this.ingest({ edges: [edge] })
  }

  /** Report metric values (one observation each; a context is what they're relative to). */
  logMetrics(
    entity: ItemRefInput,
    values: Record<string, number>,
    opts: MetricOptions | ItemRefInput = {}
  ): Promise<IngestResult> {
    const o: MetricOptions =
      typeof opts === "string" || !isMetricOptions(opts) ? { context: opts as ItemRefInput } : opts
    return this.ingest({ metrics: [{ entity, values, ...o }] })
  }

  /** Attach a ref: `content` (pinned by version or hash), `mirror` (a copy) or `annotation`. */
  attachRef(entity: ItemRefInput, ref: Omit<IngestRef, "entity">): Promise<IngestResult> {
    return this.ingest({ refs: [{ entity, ...ref }] })
  }

  /** Seal an artifact: its props and content refs are frozen (it's used as evidence). */
  seal(id: string) {
    return this.request<{ id: string; sealedAt: string }>("POST", `/entities/${id}/seal`)
  }

  /** Make a revision its identity's head: what `pin: true` edges resolve to. */
  setHead(identity: string, revision: string) {
    return this.request<{ identity: string; head: string; revision: number }>(
      "PUT",
      `/entities/${identity}/head`,
      { revision }
    )
  }

  /** Reject a reported value (it's kept, marked; the current value falls back) or restore it. */
  setObservationQuality(id: string, quality: "ok" | "rejected", reason?: string) {
    return this.request<{ id: string; quality: "ok" | "rejected" }>(
      "PATCH",
      `/observations/${id}`,
      { quality, ...(reason ? { reason } : {}) }
    )
  }

  updateEntity(id: string, patch: UpdateEntityInput) {
    return this.request<Record<string, unknown>>("PATCH", `/entities/${id}`, patch)
  }

  setStatus(id: string, status: string) {
    return this.updateEntity(id, { status })
  }

  archive(id: string) {
    return this.request<void>("POST", `/entities/${id}/archive`)
  }

  getEntity(id: string) {
    return this.request<Record<string, unknown>>("GET", `/entities/${id}`)
  }

  // ---------------------------------------------------------------- jobs (docs/jobs.md)

  /** Queue jobs, in one request (at most 1000). Each gets an id here: the same id is the same job. */
  submitJobs(jobs: JobSubmit[]) {
    return this.request<SubmitJobsResult>("POST", "/jobs", {
      jobs: jobs.map((j) => ({ id: uuidv7(), ...j })),
    })
  }

  /** What's in flight. */
  listJobs(q: { state?: string; on?: string; limit?: number; after?: string } = {}) {
    const p = new URLSearchParams(
      Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))
    )
    return this.request<{ jobs: Record<string, unknown>[]; after: string | null }>(
      "GET",
      `/jobs${p.size ? `?${p}` : ""}`
    )
  }

  /** A job while it's in flight (afterwards, its record: `getEntity`). */
  getJob(id: string) {
    return this.request<Record<string, unknown>>("GET", `/jobs/${id}`)
  }

  /** A job's files, on the site that ran it: each with a link to download it (good for minutes). */
  jobFiles(id: string) {
    return this.request<{
      files: {
        locator: string
        path: string
        contentHash: string | null
        sizeBytes: number | null
        mediaType: string | null
        url: string
        expiresAt: string
      }[]
    }>("GET", `/jobs/${id}/files`)
  }

  cancelJobs(ids: string[], reason?: string) {
    return this.request<{ jobs: { id: string; state: string }[] }>("POST", "/jobs/cancel", {
      ids,
      reason,
    })
  }

  /** While they wait: a priority (higher first), or ahead of everything waiting for their unit type. */
  setJobPriority(ids: string[], to: { priority: number } | { bump: true }) {
    return this.request<{ jobs: { id: string; priority: number }[] }>("POST", "/jobs/priority", {
      ids,
      ...to,
    })
  }

  /** One tick of a runner: a site's key (docs/jobs.md, "Sites"). */
  runnerSync(body: RunnerSyncInput) {
    return this.request<RunnerSyncResult>("POST", "/runners/sync", body)
  }

  listUnits() {
    return this.request<{ units: Record<string, unknown>[] }>("GET", "/units")
  }

  holdUnits(ids: string[], reason?: string) {
    return this.request<{ units: string[] }>("POST", "/units/hold", { ids, reason })
  }

  resumeUnits(ids: string[]) {
    return this.request<{ units: string[] }>("POST", "/units/resume", { ids })
  }

  /** The id of the item a source key names (not found: none, or one you can't see). */
  resolve(source: { system: string; key: string }) {
    const p = new URLSearchParams(source)
    return this.request<{ id: string }>("GET", `/entities/resolve?${p}`)
  }

  /**
   * Close the current edge between two items (by id or source key); it stays in history.
   * `ended`: it was true until now (temporal relations); `retracted`: recorded in error.
   */
  unlink(edge: {
    src: ItemRefInput
    rel: string
    dst: ItemRefInput
    kind?: "ended" | "retracted"
  }) {
    return this.request<{ edge: string }>("POST", "/edges/close", edge)
  }

  /** What an item came from and what came from it, `depth` steps each way. */
  lineage(id: string, q: LineageQueryInput = {}) {
    const p = new URLSearchParams()
    if (q.direction) p.set("direction", q.direction)
    if (q.depth) p.set("depth", String(q.depth))
    if (q.limit) p.set("limit", String(q.limit))
    if (q.relations?.length) p.set("relations", q.relations.join(","))
    return this.request<Record<string, unknown>>("GET", `/entities/${id}/lineage?${p}`)
  }

  /**
   * Items, newest first: of some types (subtypes included), status classes, spaces and recent
   * time. A page at a time; pass the previous page's cursor.
   */
  listItems(f: ListItemsFilter = {}) {
    return this.request<{ items: ListedItem[]; cursor: string | null }>("POST", "/views/items", {
      spec: {
        itemTypes: f.types ?? [],
        statusClasses: f.statusClasses ?? [],
        spaces: f.spaces ?? [],
        time: f.since ? { last: f.since } : {},
        // the item set needs a view; its column doesn't narrow it
        columns: [{ dims: [{ dim: "@type" }] }],
      },
      limit: f.limit ?? 50,
      ...(f.cursor ? { cursor: f.cursor } : {}),
    })
  }

  /**
   * The org's vocabulary: types, relations, properties and dimensions, and whether its serving
   * rows are being rebuilt after a change.
   */
  registry() {
    return this.request<Record<string, unknown> & { version: number; rebuilding: boolean }>(
      "GET",
      "/registry"
    )
  }

  /**
   * What loading packs (YAML text, or built-in pack keys) would do, without doing it: every
   * definition, every refusal, the rebuild it causes, and the registry version it read (admins).
   */
  planPacks(packs: string[]) {
    return this.request<PackPlan>("POST", "/registry/plan", { packs })
  }

  /**
   * Load packs (admins). With the version a plan read, refused (409) if the registry has moved
   * since: what's applied is what was planned.
   */
  applyPacks(packs: string[], opts: { expectedRegistryVersion?: number } = {}) {
    return this.request<{
      registryVersion: number
      rebuilt: boolean
      rebuildPending: boolean
      plan: PackPlan
    }>("POST", "/registry/packs", { packs, ...opts })
  }

  /**
   * Add types and properties to the org's own packs, each `<pack>.<key>`: what's new is added,
   * what exists is left as it is (`added` names what was new).
   */
  extendRegistry(input: ExtendRegistryInput) {
    return this.request<{ added: string[]; registryVersion: number }>(
      "POST",
      "/registry/extend",
      input
    )
  }

  /** A loaded pack: its text as loaded (when it came as text) and its body. */
  getPack(key: string) {
    return this.request<{
      key: string
      version: string
      checksum: string
      source: string | null
      body: unknown
    }>("GET", `/registry/packs/${encodeURIComponent(key)}`)
  }

  /**
   * Your runs and their keys (docs/auth.md, "Run keys"); `all`: every member's (admins). Signed in
   * with a personal token, not a run key.
   */
  listRunKeys(opts: { all?: boolean } = {}) {
    return this.request<RunKeysRun[]>("GET", `/run-keys${opts.all ? "?all=1" : ""}`)
  }

  /** Stop a run's keys now, by its agent: yours, an admin's, or the run's own as it ends. */
  revokeRunKeys(agent: string) {
    return this.request<{ revoked: number }>("POST", "/run-keys/revoke", { agent })
  }

  /**
   * What's related to a text (`q`) or an item (`item`): nearest by embedding and by name, each
   * with its links one hop along the graph (docs/knowledge-graph.md).
   */
  related(input: KgRelatedInput) {
    return this.request<KgRelated>("POST", "/kg/related", input)
  }

  /** Items by name, best match first; `types` narrows it (subtypes included). */
  search(q: string, limit = 20, types: string[] = []) {
    const p = new URLSearchParams({ q, limit: String(limit) })
    if (types.length) p.set("types", types.join(","))
    return this.request<
      {
        id: string
        name: string
        type: string
        typeLabel: string
        status: string | null
        score: number
      }[]
    >("GET", `/search?${p}`)
  }

  reassign(input: ReassignInput) {
    return this.request<{ moved: { agent: string; from: string[]; to: string }[] }>(
      "POST",
      "/actions/reassign",
      input
    )
  }

  /**
   * The event log in commit-safe order: pass the previous page's cursor (stored with what you
   * did with its events); an empty page with `caughtUp` means nothing new yet.
   */
  changes(after?: string | null, limit = 200) {
    const q = new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) })
    return this.request<{
      events: {
        id: string
        type: string
        occurredAt: number
        txid: string
        entity: { id: string; name: string; type: string } | null
        data: unknown
      }[]
      cursor: string | null
      caughtUp: boolean
    }>("GET", `/events/changes?${q}`)
  }

  /**
   * Who the token acts as (a member, or an AI agent for an API key), in which org, and an
   * agent's current assignment (what it should be working on).
   */
  me() {
    return this.request<{
      orgId: string
      org: { id: string; name: string; slug: string }
      via: "session" | "api_key" | "personal_token"
      agentId: string | null
      actor: { id: string; name: string; type: string } | null
      role: string
      scopes: string[]
      assignment: { id: string; name: string; type: string } | null
      /** the personal token the caller came with: a CLI sign-in ("cli") or one made by hand */
      token: { id: string; name: string; kind: "token" | "cli"; expiresAt: string } | null
    }>("GET", "/agents/me")
  }

  /** Accumulate writes and send them in batches. */
  batch(): BatchBuilder {
    return new BatchBuilder(this)
  }
}

/** What loading packs would do (core `PackPlan`). */
export interface PackPlan {
  registryVersion: number
  packs: { pack: string; from: string | null; to: string; changed: boolean }[]
  entries: {
    pack: string
    what: "type" | "relation" | "property" | "dim"
    key: string
    change: "added" | "changed" | "restated" | "unchanged" | "refused" | "blocked" | "dropped"
    detail?: string
  }[]
  issues: { path: string; message: string; code?: string }[]
  rebuild: {
    needed: boolean
    reasons: string[]
    items: number
    mode: "none" | "in_transaction" | "background"
  }
}

export interface ListItemsFilter {
  types?: string[]
  statusClasses?: (
    | "pending"
    | "running"
    | "blocked"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown"
    | "none"
  )[]
  /** space ids */
  spaces?: string[]
  since?: "1d" | "7d" | "30d" | "90d" | "365d"
  limit?: number
  cursor?: string
}

export interface ListedItem {
  id: string
  name: string
  type: string
  [k: string]: unknown
}

export class BatchBuilder {
  private items: NonNullable<IngestBatch["items"]> = []
  private edges: NonNullable<IngestBatch["edges"]> = []
  private metrics: NonNullable<IngestBatch["metrics"]> = []
  private refs: NonNullable<IngestBatch["refs"]> = []
  /**
   * batch-local ref -> how any request can name the item, so refs keep working when a flush is
   * split into chunks: its id, or for a source-keyed item its source key (the server resolves the
   * key to the entity it names, which may be an existing one with another id)
   */
  private ids = new Map<string, ItemRefInput>()

  constructor(private readonly client: OnyxClient) {}

  /**
   * Adds an item. Returns its id (given, or minted here), or for a source-keyed item the
   * `{ source }` reference: the server decides its id (an existing entity with that key keeps its
   * own), so the key is how later writes should name it.
   */
  item(item: IngestItem & { source: NonNullable<IngestItem["source"]> }): ItemRefInput
  item(item: IngestItem): string
  item(item: IngestItem): string | ItemRefInput {
    const ref: ItemRefInput = item.source ? { source: item.source } : { id: item.id ?? uuidv7() }
    this.items.push(withItemDefaults("id" in ref ? { ...item, id: ref.id } : item))
    if (item.ref) this.ids.set(item.ref, ref)
    return "id" in ref ? ref.id : ref
  }
  edge(edge: IngestEdge): this {
    this.edges.push(edge)
    return this
  }
  metric(entity: ItemRefInput, values: Record<string, number>, opts: MetricOptions = {}): this {
    this.metrics.push({ id: uuidv7(), entity, values, ...opts })
    return this
  }
  ref(ref: NonNullable<IngestBatch["refs"]>[number]): this {
    this.refs.push(ref)
    return this
  }
  get size(): number {
    return this.items.length + this.edges.length + this.metrics.length + this.refs.length
  }

  private resolve(r: ItemRefInput): ItemRefInput
  private resolve(r: ItemRefInput | undefined): ItemRefInput | undefined
  private resolve(r: ItemRefInput | undefined): ItemRefInput | undefined {
    if (typeof r === "string" && this.ids.has(r)) return this.ids.get(r)!
    if (r && typeof r === "object" && "ref" in r && this.ids.has(r.ref)) return this.ids.get(r.ref)!
    return r
  }

  /**
   * Send everything: one request (one transaction) when it fits, otherwise in chunks, in the
   * order later chunks depend on: items, then refs (a metric can name one as its series, and an
   * edge that uses an artifact as evidence seals it, freezing its content refs), then edges, then
   * metrics. Batch-local refs are rewritten to ids or source keys, so they also name items added
   * before an earlier flush. A split flush isn't atomic, and an item's `identity` or `createdBy`
   * must name an item in the same or an earlier chunk (or one that already exists).
   */
  async flush(): Promise<IngestResult[]> {
    const n = this.client.batchSize
    const take = <T>(xs: T[]) => xs.splice(0, xs.length)
    const items = take(this.items).map((x) => ({
      ...x,
      identity: this.resolve(x.identity),
      createdBy: this.resolve(x.createdBy),
    }))
    const refs = take(this.refs).map((x) => ({ ...x, entity: this.resolve(x.entity) }))
    const edges = take(this.edges).map((x) => ({
      ...x,
      src: this.resolve(x.src),
      dst: this.resolve(x.dst),
    }))
    const metrics = take(this.metrics).map((x) => ({
      ...x,
      entity: this.resolve(x.entity),
      context: this.resolve(x.context),
    }))
    if (items.length + edges.length + metrics.length + refs.length === 0) return []
    if (items.length <= n && edges.length <= n * 4 && metrics.length <= n && refs.length <= n)
      return [await this.client.ingest({ items, edges, metrics, refs })]
    const results: IngestResult[] = []
    for (let i = 0; i < items.length; i += n)
      results.push(await this.client.ingest({ items: items.slice(i, i + n) }))
    for (let i = 0; i < refs.length; i += n)
      results.push(await this.client.ingest({ refs: refs.slice(i, i + n) }))
    for (let i = 0; i < edges.length; i += n * 4)
      results.push(await this.client.ingest({ edges: edges.slice(i, i + n * 4) }))
    for (let i = 0; i < metrics.length; i += n)
      results.push(await this.client.ingest({ metrics: metrics.slice(i, i + n) }))
    return results
  }
}
