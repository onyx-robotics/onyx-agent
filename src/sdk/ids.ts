import type { IngestItem } from "../generated/contracts/contracts"

/** RFC 9562 UUIDv7, monotonic within this process. */
let lastMs = 0
let seq = 0
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  if (now <= lastMs) {
    seq = (seq + 1) & 0xfff
    if (seq === 0) lastMs += 1
    now = lastMs
  } else {
    lastMs = now
    seq = b[6]! & 0x07
  }
  const ms = BigInt(now)
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = 0x70 | ((seq >> 8) & 0x0f)
  b[7] = seq & 0xff
  b[8] = 0x80 | (b[8]! & 0x3f)
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * An item as sent: a minted id unless it has one or a source key, and a new revision of an
 * identity becomes its head unless it says otherwise (or numbers itself: importing history).
 */
export const withItemDefaults = (it: IngestItem): IngestItem => ({
  ...it,
  ...(it.id || it.source ? {} : { id: uuidv7() }),
  ...(it.identity && it.revision === undefined && it.head === undefined ? { head: true } : {}),
})

/** JSON with its object keys sorted and undefined left out: the same value, the same text. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])])
      )
    return v
  }
  return JSON.stringify(norm(value))
}

/**
 * A metric report's id derived from what it reports, so a file sent again is recognised (the
 * server keeps one observation per report and value) instead of logged twice. `report` must name
 * its entity and context by stable keys (an id, a source key, or an identity's revision), never
 * by a file's own ref labels, which another file can reuse. `occurrence` tells identical reports
 * in one file apart (replicates); `namespace` keeps the same values from another run apart.
 * UUIDv8: the first 122 bits of a SHA-256.
 */
export async function reportId(
  report: Record<string, unknown>,
  occurrence = 0,
  namespace = ""
): Promise<string> {
  const text = canonicalJson({ report: { ...report, id: undefined }, occurrence, namespace })
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  )
  const h = Array.from(digest.subarray(0, 16), (x) => x.toString(16).padStart(2, "0")).join("")
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
