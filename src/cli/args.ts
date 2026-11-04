/**
 * How commands name things. An item is its id (a UUID) or a source key, `system:key`, split at
 * the first colon (`git:9f2c1e`, `plm:arms/arm-2`). A property is `key=value`, the value read as
 * JSON when it is JSON (numbers, booleans, null, quoted strings) and as text otherwise.
 */
import { UsageError } from "./output"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (s: string) => UUID.test(s)

export type ItemArg = { id: string } | { source: { system: string; key: string } }

/** An item argument: `{id}` or `{source}`. */
export function itemArg(arg: string | undefined, what = "item"): ItemArg {
  if (!arg) throw new UsageError(`which ${what}? (an id, or a source key system:key)`)
  if (isUuid(arg)) return { id: arg }
  const at = arg.indexOf(":")
  if (at <= 0 || at === arg.length - 1)
    throw new UsageError(`${what} ${arg}: give an id, or a source key system:key`)
  return { source: { system: arg.slice(0, at), key: arg.slice(at + 1) } }
}

/** `key=value` pairs as props. */
export function propArgs(pairs: string[] = []): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const p of pairs) {
    const at = p.indexOf("=")
    if (at <= 0) throw new UsageError(`--prop ${p}: write key=value`)
    const raw = p.slice(at + 1)
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {
      // text
    }
    props[p.slice(0, at)] = value
  }
  return props
}

/** Keys to remove (a null value removes a property). */
export const unsetArgs = (keys: string[] = []): Record<string, null> =>
  Object.fromEntries(keys.map((k) => [k, null]))

/** A positional argument a command needs. */
export function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`missing ${what}`)
  return value
}
