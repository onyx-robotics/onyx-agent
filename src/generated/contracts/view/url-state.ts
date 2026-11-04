// Generated from packages/core/src/view/url-state.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * What a page shows over what it starts from, in one parameter of its address (apps/web
 * lib/url-state.ts). One codec for any page's state, a zod object of fields:
 *
 * - The address holds the fields that differ from the base (what's saved, and each field's
 *   default), each whole, as JSON, deflated and base64url, after the version that wrote it
 *   (`1.`), and the revision of what's saved it was written over (its stamp), when there's one.
 * - Each field is read on its own: one that isn't valid reads as the base's, and the others still
 *   apply; a field the schema doesn't know is ignored. Then the whole is checked once more. What
 *   didn't apply is reported, so the page can say so.
 * - An older version's address is read through `migrations`, one version to the next; a newer
 *   version's reads as nothing, and says so (never as something else).
 * - Reading what was written and writing it again changes nothing, whatever the base:
 *   normalising an address never changes what it shows.
 *
 * So a field added to the schema (with a default) is in the address, in links and in what's
 * compared with what's saved, and older links read it as its default. A change to what a field
 * means is a new field, or a new version with a migration. A view stored elsewhere (a share link's
 * row) is read the same way (`readStored`). Pure and browser-safe: the page and the server read
 * the same address.
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate"
import type { z } from "zod"

/** The longest state an address holds, in characters. */
export const URL_STATE_MAX = 4096
/** The most a state may inflate to, in bytes: more isn't one of ours. */
const INFLATED_MAX = 64 * 1024
/** Where an address keeps its stamp: no field's name starts with "@". */
const STAMP = "@"

export type Fields = Record<string, unknown>

export interface UrlStateOptions {
  /** the version this code writes (from 1) */
  version?: number
  /** an older version's fields as the next one reads them: `migrations[n]` takes n to n + 1 */
  migrations?: Record<number, (fields: Fields) => Fields>
}

/**
 * What of an address didn't apply: it isn't one (`unreadable`), a newer version wrote it
 * (`newer`), or some of its fields aren't valid or aren't known here (`fields`, by name).
 */
export type UrlStateIssue =
  | { kind: "unreadable" }
  | { kind: "newer" }
  | { kind: "fields"; fields: string[] }

export interface UrlStateRead<T> {
  /** what it shows: what applied, over the base */
  value: T
  issue: UrlStateIssue | null
  /** the revision of what's saved it was written over (encode's `stamp`), if it says */
  stamp: number | null
}

export interface UrlStateCodec<T extends Fields> {
  /** the version this codec writes */
  readonly version: number
  /** The fields of `next` that differ from `base`, for the address (null: none, the parameter goes). */
  encode(next: T, base: T, stamp?: number | null): string | null
  /**
   * What an address shows over `base`, and what of it didn't apply. With `prev`, a field equal to
   * it is `prev`'s (one object while it's the same).
   */
  read(text: string | null | undefined, base: T, prev?: T): UrlStateRead<T>
  /** `read`'s value. */
  decode(text: string | null | undefined, base: T, prev?: T): T
  /** Whether an address holds anything that differs from `base`. */
  differs(text: string | null | undefined, base: T): boolean
  /** A view stored with the version that wrote it (all its fields), read as an address is. */
  readStored(version: number, fields: unknown, base: T, prev?: T): UrlStateRead<T>
}

export function urlStateCodec<S extends z.ZodObject>(
  schema: S,
  options: UrlStateOptions = {}
): UrlStateCodec<z.output<S>> {
  type T = z.output<S>
  const version = options.version ?? 1
  const migrations = options.migrations ?? {}
  const keys = Object.keys(schema.shape) as (keyof T & string)[]
  if (keys.some((k) => k.startsWith(STAMP))) throw new Error("a field's name can't start with @")

  const encode = (next: T, base: T, stamp?: number | null): string | null => {
    const diff: Fields = {}
    for (const k of keys) if (!sameValue(next[k], base[k])) diff[k] = next[k]
    if (!Object.keys(diff).length) return null
    if (stamp != null) diff[STAMP] = stamp
    const bytes = deflateSync(strToU8(canonicalJson(diff)), { level: 9 })
    return `${version}.${bytesToB64url(bytes)}`
  }

  /** What an address holds: its version and its fields (before they're read). */
  const unpack = (text: string): { v: number; fields: Fields } | null => {
    if (text.length > URL_STATE_MAX) return null
    const dot = text.indexOf(".")
    const v = dot > 0 ? Number(text.slice(0, dot)) : NaN
    if (!Number.isInteger(v) || v < 1) return null
    const bytes = b64urlToBytes(text.slice(dot + 1))
    if (!bytes) return null
    try {
      // one byte past the cap tells a state that's too large from one that just fits
      const out = inflateSync(bytes, { out: new Uint8Array(INFLATED_MAX + 1) })
      if (out.length > INFLATED_MAX) return null
      const raw: unknown = JSON.parse(strFromU8(out))
      return isFields(raw) ? { v, fields: raw } : null
    } catch {
      return null
    }
  }

  /** Fields an older version wrote, as this one reads them (null: no way there). */
  const migrate = (from: number, fields: Fields): Fields | null => {
    let out = fields
    try {
      for (let v = from; v < version; v++) {
        const step = migrations[v]
        if (!step) return null
        out = step(out)
        if (!isFields(out)) return null
      }
      return out
    } catch {
      return null
    }
  }

  const nothing = (base: T, prev: T | undefined, issue: UrlStateIssue | null): UrlStateRead<T> => ({
    value: share(base, prev),
    issue,
    stamp: null,
  })

  /** Fields of a given version over `base`: each that's valid, the base's otherwise. */
  const apply = (v: number, raw: Fields, base: T, prev: T | undefined): UrlStateRead<T> => {
    if (v > version) return nothing(base, prev, { kind: "newer" })
    const fields = migrate(v, raw)
    if (!fields) return nothing(base, prev, { kind: "unreadable" })
    const stamp = typeof fields[STAMP] === "number" ? (fields[STAMP] as number) : null
    const read = readFields(schema, fields, base, prev)
    return { ...read, stamp }
  }

  const read = (text: string | null | undefined, base: T, prev?: T): UrlStateRead<T> => {
    if (!text) return nothing(base, prev, null)
    const packed = unpack(text)
    if (!packed) return nothing(base, prev, { kind: "unreadable" })
    return apply(packed.v, packed.fields, base, prev)
  }

  const readStored = (v: number, fields: unknown, base: T, prev?: T): UrlStateRead<T> =>
    Number.isInteger(v) && v >= 1 && isFields(fields)
      ? apply(v, fields, base, prev)
      : nothing(base, prev, { kind: "unreadable" })

  return {
    version,
    encode,
    read,
    decode: (text, base, prev) => read(text, base, prev).value,
    differs: (text, base) => encode(read(text, base).value, base) !== null,
    readStored,
  }

  function share(next: T, prev?: T): T {
    return shareFields(keys, next, prev)
  }
}

/**
 * Fields read over `base` by a schema's fields, each on its own: one that's valid applies, one
 * that isn't (or that the schema doesn't know) is reported and the base's stays. Then the whole is
 * checked: breaking what holds across fields, nothing applies. The same policy for an address, a
 * stored view and a stored document. With `prev`, a field equal to it is `prev`'s.
 */
export function readFields<S extends z.ZodObject>(
  schema: S,
  raw: Fields,
  base: z.output<S>,
  prev?: z.output<S>
): { value: z.output<S>; issue: UrlStateIssue | null } {
  type T = z.output<S>
  const keys = Object.keys(schema.shape) as (keyof T & string)[]
  const out = { ...base }
  const dropped: string[] = []
  let applied = false
  for (const k of keys) {
    if (!(k in raw)) continue
    const parsed = (schema.shape[k] as z.ZodType).safeParse(raw[k])
    if (!parsed.success) {
      dropped.push(k)
      continue
    }
    out[k] = parsed.data as T[typeof k]
    applied = true
  }
  for (const k of Object.keys(raw))
    if (!k.startsWith(STAMP) && !(k in schema.shape)) dropped.push(k)
  // what holds across fields: what breaks it reads as nothing
  if (applied && !schema.safeParse(out).success) {
    const all = Object.keys(raw).filter((k) => !k.startsWith(STAMP))
    return { value: shareFields(keys, base, prev), issue: { kind: "fields", fields: all } }
  }
  const issue: UrlStateIssue | null = dropped.length ? { kind: "fields", fields: dropped } : null
  return { value: shareFields(keys, applied ? out : base, prev), issue }
}

/** `next`, with each field equal to `prev`'s taken from `prev` (`prev` itself if all are). */
function shareFields<T extends Fields>(keys: (keyof T & string)[], next: T, prev?: T): T {
  if (!prev || next === prev) return next
  let same = true
  const out = { ...next }
  for (const k of keys) {
    if (next[k] !== prev[k] && sameValue(next[k], prev[k])) out[k] = prev[k]
    if (out[k] !== prev[k]) same = false
  }
  return same ? prev : out
}

const isFields = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v)

// ---------------------------------------------------------------- values

/** Whether two JSON values are the same (objects whatever their keys' order; arrays in order). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bs = b as unknown[]
    return a.length === bs.length && a.every((x, i) => sameValue(x, bs[i]))
  }
  const ao = a as Fields
  const bo = b as Fields
  // a key whose value is undefined isn't in the JSON
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined)
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined)
  return ak.length === bk.length && ak.every((k) => sameValue(ao[k], bo[k]))
}

/** JSON with every object's keys in order: one value, one text (what a stored view is hashed by). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Fields).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v
  )
}

// ---------------------------------------------------------------- base64url

function bytesToB64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}
