// Generated from packages/core/src/view/title.ts in Onyx's monorepo (bun run agent:contracts): don't edit.
/**
 * A series' title (docs/query-builder.md §6): its query in words, as its text bar says it while
 * nothing's been typed in it ("Riley's failed Atlas experiments in Controls by status"), each
 * phrase marked with the part of the query it says, so the bar's phrases work as a typed text's do
 * (hovered, their other readings; edited, the rest read again). And a typed title kept saying what
 * its series is as its chips change the query: a value swapped says the new one in its words'
 * place, a part taken away takes its words with it, a part added is said after the rest.
 * Browser-safe.
 */
import { QUERY_TEXT_MAX, type TextSpan } from "../contracts/query"
import {
  conditionRefs,
  conditionsOf,
  CARD_LIMIT,
  TEXT_MARKS_MAX,
  type Condition,
  type TextQueryOf,
  type CardText,
  type TextMark,
} from "./card-query"
import { canonicalWhere, type NodeRef } from "./spec"

/** What a title says things with. */
export interface TitleWords {
  dimLabel: (dim: string) => string
  /** a value's label, when the page knows it */
  refLabel: (ref: NodeRef) => string | null
  /** what a dim's values are (the registry's `source`: "type", "status", "space", "creator", …) */
  dimSource: (dim: string) => string | null
  /** a value's name another dim's value has too: said with its dim's ("Atlas campaign") */
  shared?: (name: string) => boolean
}

/**
 * Words that name these values too: labels the page doesn't know yet (a resolver's, a value
 * picker's), so a title says them, not "…".
 */
export function namedBy(
  words: TitleWords,
  named: readonly { ref: NodeRef; label: string }[]
): TitleWords {
  if (!named.length) return words
  const keyOf = (r: NodeRef) => (keyed(r) ? `${r.dim}|${r.key}` : "")
  const labels = new Map(named.filter((n) => keyed(n.ref)).map((n) => [keyOf(n.ref), n.label]))
  return { ...words, refLabel: (r) => words.refLabel(r) ?? labels.get(keyOf(r)) ?? null }
}

/**
 * What a condition's words do in a title: its items' kind (the noun), whose they are, how they
 * stand, where they are, what they have none of, how they relate to a value by a dim named as a
 * relation ("performed by agent-01", after the noun), or any other value (before the noun).
 */
type Role = "type" | "creator" | "status" | "space" | "none" | "relation" | "value"

/** A part of a query, as a phrase of its title says it (a mark without its place). */
type Part =
  | { kind: "condition"; ref: NodeRef }
  | { kind: "split"; dim: string }
  | { kind: "then"; dim: string }
  | { kind: "limit"; limit: number }

/** Words, or words that say a part. */
type Piece = string | { words: string; part: Part }

/** An any-of group says this many values, then how many more. */
const GROUP_SHOWN = 4

const keyed = (r: NodeRef): r is Extract<NodeRef, { key: string }> => "key" in r
const idOf = (r: NodeRef) =>
  keyed(r) ? `${r.dim}|${r.key}|${r.mode ?? "rollup"}` : `${r.dim}|none`

/** A label as a common noun mid-sentence ("Experiment": "experiment"; "QA", "MuJoCo" stay). */
const common = (label: string) =>
  label.replace(/\p{L}[\p{L}\p{N}'’-]*/gu, (w) =>
    /^\p{Lu}[\p{Ll}\p{N}'’-]*$/u.test(w) ? w.toLowerCase() : w
  )

/** A noun's plural, by its last word ("experiment": "experiments", "battery": "batteries"). */
export function plural(noun: string): string {
  const m = /(\p{L}+)$/u.exec(noun)
  if (!m) return noun
  const w = m[1]!
  const p = /[^aeiou]y$/i.test(w)
    ? `${w.slice(0, -1)}ies`
    : /(s|x|z|ch|sh)$/i.test(w)
      ? `${w}es`
      : `${w}s`
  return noun.slice(0, m.index) + p
}

/**
 * A dim's name mid-sentence: a word, as a common noun ("by status"); a name of more, as it's
 * written, a field's name ("by Performed by", "with no Goal / Problem").
 */
const dimWords = (dim: string, words: TitleWords) => {
  const label = words.dimLabel(dim)
  return /^\p{L}[\p{L}\p{N}'’-]*$/u.test(label) ? common(label) : label
}

const capital = (s: string) => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase())

/** A dim named as a relation ("Performed by", "Evaluated on"): its name says how a value relates. */
const RELATION = /\s(?:by|in|on|at|of|for|from|with|to)$/iu

function roleOfDim(dim: string, words: TitleWords): Role {
  const source = words.dimSource(dim)
  if (source === "type" || source === "creator" || source === "status" || source === "space")
    return source
  return RELATION.test(words.dimLabel(dim)) ? "relation" : "value"
}

/** The words a relation's values follow ("performed by"); none for any other role. */
const leadOf = (dim: string, words: TitleWords): string | null =>
  roleOfDim(dim, words) === "relation" ? common(words.dimLabel(dim)) : null

function roleOf(c: Condition, words: TitleWords): Role {
  const refs = conditionRefs(c)
  if (refs.length === 1 && !keyed(refs[0]!)) return "none"
  if (refs.some((r) => !keyed(r)) || new Set(refs.map((r) => r.dim)).size > 1) return "value"
  return roleOfDim(refs[0]!.dim, words)
}

/**
 * A value as its role says it: a kind as a plural noun, a status as a word, anything else by its
 * label; "exactly" for the node itself, not what's under it; "no …" for no value of a dim.
 */
function valueWords(r: NodeRef, role: Role, words: TitleWords): string {
  if (!keyed(r)) return `no ${dimWords(r.dim, words)}`
  const label = words.refLabel(r)
  const said =
    label === null
      ? "…"
      : role === "type"
        ? plural(common(label))
        : role === "status"
          ? common(label)
          : role === "value" && words.shared?.(label)
            ? withDim(label, r.dim, words)
            : label
  return r.mode === "direct" ? `exactly ${said}` : said
}

/**
 * A value's name with its dim's, the name another dim's value has too ("Atlas campaign", "Atlas
 * (Goal / problem)"); one that says its dim already stays as it is ("Q3 campaign").
 */
function withDim(label: string, dim: string, words: TitleWords): string {
  const name = dimWords(dim, words)
  if (label.toLowerCase().includes(name.toLowerCase())) return label
  return /\s/u.test(name) ? `${label} (${name})` : `${label} ${name}`
}

/** A condition's values, each a phrase, "or" between them ("Atlas or Hermes", "Riley's"). */
function valuePieces(c: Condition, role: Role, words: TitleWords): Piece[] {
  const refs = conditionRefs(c)
  const shown = refs.length > GROUP_SHOWN + 1 ? refs.slice(0, GROUP_SHOWN) : refs
  const out: Piece[] = []
  shown.forEach((ref, i) => {
    if (i) out.push(" or ")
    out.push({ words: valueWords(ref, role, words), part: { kind: "condition", ref } })
    if (role === "creator") out.push("'s")
  })
  // (the rest are still the query's: an edit reads the text over them)
  if (shown.length < refs.length) out.push(` or ${refs.length - shown.length} more`)
  return out
}

const splitWords = (kind: "split" | "then", dim: string, words: TitleWords) =>
  `${kind === "split" ? "by" : "then by"} ${dimWords(dim, words)}`

const joined = (groups: Piece[][], sep: string): Piece[] =>
  groups.flatMap((g, i) => (i ? [sep, ...g] : g))

/** Pieces as a text: their words, and the places of the phrases that say parts. */
function textOf(pieces: Piece[]): CardText {
  let value = ""
  const marks: TextMark[] = []
  for (const p of pieces) {
    if (typeof p === "string") {
      value += p
      continue
    }
    const span: TextSpan = [value.length, value.length + p.words.length]
    value += p.words
    // (a part past what a text keeps is only words; the query still has it)
    if (marks.length < TEXT_MARKS_MAX && span[1] <= QUERY_TEXT_MAX) marks.push({ ...p.part, span })
  }
  return { value: capital(value).slice(0, QUERY_TEXT_MAX), marks }
}

/**
 * A series' query in words, each phrase marked with the part it says: whose items, how they stand,
 * a value of something, their kind (a plural noun), how they relate to values by dims named as
 * relations, where they are and what they have none of, then what they're split by and then by
 * ("Riley's failed Atlas experiments performed by agent-01 in Controls with no hypothesis by
 * status, then by operator"). Two or more values of other things follow the noun ("Experiments ·
 * Atlas · Friction modeling"). Every part is said by its dim's role, so two queries never read
 * alike. How many values it shows isn't said: it's how much of it is shown, said beside it.
 */
export function queryTitle(q: TextQueryOf, words: TitleWords): CardText {
  const by: Record<Role, Condition[]> = {
    type: [],
    creator: [],
    status: [],
    space: [],
    none: [],
    relation: [],
    value: [],
  }
  for (const c of conditionsOf(q.where)) by[roleOf(c, words)].push(c)
  const [type, ...types] = by.type
  const [creator, ...creators] = by.creator
  const values = [...by.value, ...types, ...creators].map((c) => valuePieces(c, "value", words))

  // the head: whose, how they stand, a value when it's the one, and their kind
  const head: Piece[][] = []
  if (creator) head.push(valuePieces(creator, "creator", words))
  for (const c of by.status) head.push(valuePieces(c, "status", words))
  if (values.length === 1) head.push(values[0]!)
  const said = head.length
  if (type) head.push(valuePieces(type, "type", words))
  // (a noun for words that need one: "Riley's items", "Items in Controls")
  else if (
    said > (values.length === 1 ? 1 : 0) ||
    (!values.length && by.space.length + by.none.length + by.relation.length)
  )
    head.push(["items"])

  const out: Piece[] = joined(head, " ")
  if (values.length > 1) out.push(...(out.length ? [" · "] : []), ...joined(values, " · "))
  // a relation's words once before its values ("performed by agent-01 and Ada Admin")
  const relations = new Map<string, Condition[]>()
  for (const c of by.relation) {
    const dim = conditionRefs(c)[0]!.dim
    relations.set(dim, [...(relations.get(dim) ?? []), c])
  }
  for (const [dim, cs] of relations)
    out.push(
      ` ${leadOf(dim, words)} `,
      ...joined(
        cs.map((c) => valuePieces(c, "relation", words)),
        " and "
      )
    )
  for (const c of by.space) out.push(" in ", ...valuePieces(c, "space", words))
  by.none.forEach((c, i) => out.push(i ? " and " : " with ", ...valuePieces(c, "none", words)))
  if (!out.length) out.push("All items")
  if (q.by) {
    out.push(" ", { words: splitWords("split", q.by, words), part: { kind: "split", dim: q.by } })
    if (q.then && q.then !== q.by)
      out.push(", ", {
        words: splitWords("then", q.then, words),
        part: { kind: "then", dim: q.then },
      })
  }
  return textOf(out)
}

interface Canonical {
  refs: Map<string, NodeRef>
  by: string | null
  then: string | null
  limit: number
}

function canonical(q: TextQueryOf): Canonical {
  const w = canonicalWhere(q.where)
  const refs = new Map([...w.all, ...w.any.flat()].map((r) => [idOf(r), r] as const))
  const by = q.by ?? null
  return { refs, by, then: (by && q.then !== by && q.then) || null, limit: q.limit ?? CARD_LIMIT }
}

/** Whether a query still has a phrase's part (changed another way since, it's only words). */
export function markHolds(m: TextMark, q: TextQueryOf): boolean {
  return holds(m, canonical(q))
}

function holds(m: TextMark | Part, c: Canonical): boolean {
  switch (m.kind) {
    case "condition":
      return c.refs.has(idOf(m.ref))
    case "split":
      return c.by === m.dim
    case "then":
      return c.then === m.dim
    case "limit":
      return c.limit === m.limit
  }
}

/** A text being edited: its words and phrases, in order and apart. */
interface Draft {
  value: string
  marks: TextMark[]
}

/** `[a, b)` of the text replaced by `words`: the phrases after it move, the ones in it go. */
function splice(t: Draft, a: number, b: number, words: string): Draft {
  const delta = words.length - (b - a)
  return {
    value: t.value.slice(0, a) + words + t.value.slice(b),
    marks: t.marks.flatMap((m): TextMark[] =>
      m.span[1] <= a
        ? [m]
        : m.span[0] >= b
          ? [{ ...m, span: [m.span[0] + delta, m.span[1] + delta] }]
          : []
    ),
  }
}

/** A phrase said: placed among the others (by where it starts). */
function withPart(t: Draft, part: Part, span: TextSpan): Draft {
  const marks = [...t.marks, { ...part, span }].sort((x, y) => x.span[0] - y.span[0])
  return { ...t, marks }
}

/** Words put at `at`, saying `part`. */
function insert(t: Draft, at: number, before: string, words: string, part: Part | null): Draft {
  const next = splice(t, at, at, before + words)
  const from = at + before.length
  return part ? withPart(next, part, [from, from + words.length]) : next
}

/** A phrase's words as another part says them, its case kept ("Atlas" for "Hermes"). */
function reword(t: Draft, i: number, words: string, part: Part): Draft {
  let [a, b] = t.marks[i]!.span
  // (a resolver's phrase may take the space around its words: it stays)
  while (a < b && /\s/u.test(t.value[a]!)) a++
  while (b > a && /\s/u.test(t.value[b - 1]!)) b--
  const was = t.value.slice(a, b)
  const said = /^\p{Lu}/u.test(was) ? capital(words) : words
  return withPart(splice(t, a, b, said), part, [a, a + said.length])
}

/** Joiners left between phrases when one goes. */
const JOINER_BEFORE = /(?:\s*(?:,|·|\/|&|\+)|\s+(?:or|and|nor))\s*$/iu
const JOINER_AFTER = /^\s*(?:,|·|\/|&|\+|(?:or|and|nor)(?=\s))\s*/iu
/** A word left dangling before a phrase that's gone ("in", "with"). */
const DANGLING = /\s*\b(?:in|on|at|for|of|from|with|without|by)\s*$/iu
const EDGE_START = /^[\s,·/&+]+/u
const EDGE_END = /(?:[\s,·/&+]|\s(?:or|and|nor))+$/iu

/**
 * A phrase cut, with the joiner or the words left dangling by it (`lead`: a relation's,
 * "performed by"), the space around it tidied.
 */
function cut(t: Draft, i: number, lead: string | null = null): Draft {
  let [a, b] = t.marks[i]!.span
  const v = t.value
  // "Riley's"
  const own = /^['’]s\b/u.exec(v.slice(b))
  if (own) b += own[0].length
  const left = v.slice(0, a)
  const before = JOINER_BEFORE.exec(left)
  const after = !before && JOINER_AFTER.exec(v.slice(b))
  const relation = !before && !after && lead ? leadAt(left, lead) : -1
  const dangling = !before && !after && relation < 0 && DANGLING.exec(left)
  if (before) a = before.index
  else if (after) b += after[0].length
  else if (relation >= 0) a = relation
  else if (dangling) a = dangling.index
  let next = splice(t, a, b, after && a > 0 && !/\s$/u.test(left) ? " " : "")
  // one space where it was, none at the ends
  if (next.value[a - 1] === " " && next.value[a] === " ") next = splice(next, a, a + 1, "")
  return trimmed(next)
}

/** Where `lead` ends `left` as words of their own, the space before them with them (-1: it doesn't). */
function leadAt(left: string, lead: string): number {
  const end = left.trimEnd()
  let at = end.length - lead.length
  if (at < 0 || end.slice(at).toLowerCase() !== lead.toLowerCase()) return -1
  if (at > 0 && !/\s/u.test(end[at - 1]!)) return -1
  while (at > 0 && /\s/u.test(end[at - 1]!)) at--
  return at
}

function trimmed(t: Draft): Draft {
  let next = t
  const start = EDGE_START.exec(next.value)
  if (start) next = splice(next, 0, start[0].length, "")
  for (let end = EDGE_END.exec(next.value); end && end[0].length; end = EDGE_END.exec(next.value)) {
    // (a phrase's own words stay: "by" in a split's)
    const at = end.index
    if (next.marks.some((m) => m.span[1] > at)) break
    next = splice(next, at, next.value.length, "")
  }
  return next
}

/** Where words said after the rest go: before what it's split by (and how many it shows). */
function tailAt(t: Draft, kinds: readonly TextMark["kind"][]): number {
  const m = t.marks.find((x) => kinds.includes(x.kind))
  if (!m) return t.value.trimEnd().length
  let at = m.span[0]
  while (at > 0 && /[\s,]/u.test(t.value[at - 1]!)) at--
  return at
}

/**
 * A typed title kept saying what its series is as its query changes from `before` to `after` (its
 * chips): a value swapped for another of its dim says the new one in its words' place, a split
 * changed says its new dim, a part taken away takes its words with it (and the joiner or word it
 * leaves dangling), a value added to an any-of group the title says goes beside it ("Atlas or
 * Hermes"), and other parts added are said after the rest, before what it's split by. The words
 * that aren't the query's parts stay as typed, and so does a phrase that was only words already.
 * A value it can't name (`refLabel`: none) isn't said (a phrase swapped for one is cut).
 * How many values it shows is said anew only where the title says it. Null: nothing's left of it.
 */
export function retitle(
  text: CardText,
  before: TextQueryOf,
  after: TextQueryOf,
  words: TitleWords
): CardText | null {
  const b = canonical(before)
  const a = canonical(after)
  // (a value it can't name yet isn't said: a title never says "…")
  const fresh = [...a.refs.values()].filter(
    (r) => !b.refs.has(idOf(r)) && (!keyed(r) || words.refLabel(r) !== null)
  )
  const same =
    !fresh.length &&
    [...b.refs.keys()].every((k) => a.refs.has(k)) &&
    b.by === a.by &&
    b.then === a.then &&
    b.limit === a.limit
  if (same) return text
  let t: Draft = { value: text.value, marks: [...text.marks] }

  // the phrases whose parts changed: said anew, or cut
  const taken = new Set<string>()
  for (let i = 0; i < t.marks.length; ) {
    const m = t.marks[i]!
    if (!holds(m, b) || holds(m, a)) {
      i++
      continue
    }
    let part: Part | null = null
    let said = ""
    if (m.kind === "condition" && keyed(m.ref)) {
      const dim = m.ref.dim
      const to = fresh.find((r) => keyed(r) && r.dim === dim && !taken.has(idOf(r)))
      if (to) {
        taken.add(idOf(to))
        part = { kind: "condition", ref: to }
        said = valueWords(to, roleOfDim(to.dim, words), words)
      }
    } else if (m.kind === "split" || m.kind === "then") {
      const dim = m.kind === "split" ? a.by : a.then
      const was = m.kind === "split" ? b.by : b.then
      if (dim && was) {
        part = { kind: m.kind, dim }
        const old = t.value.slice(m.span[0], m.span[1])
        const label = dimWords(was, words)
        const at = old.toLowerCase().lastIndexOf(label.toLowerCase())
        said =
          at >= 0
            ? old.slice(0, at) + dimWords(dim, words) + old.slice(at + label.length)
            : splitWords(m.kind, dim, words)
      }
    } else if (m.kind === "limit" && a.limit !== CARD_LIMIT) {
      part = { kind: "limit", limit: a.limit }
      said = t.value.slice(m.span[0], m.span[1]).replace(/\d+/u, String(a.limit))
    }
    if (part) {
      t = reword(t, i, said, part)
      i++
    } else t = cut(t, i, m.kind === "condition" ? leadOf(m.ref.dim, words) : null)
  }

  // the values added: beside a value of their any-of group the title says, else after the rest
  const groups = canonicalWhere(after.where).any
  const rest: NodeRef[] = []
  for (const r of fresh) {
    if (taken.has(idOf(r))) continue
    const mates = new Set((groups.find((g) => g.some((x) => idOf(x) === idOf(r))) ?? []).map(idOf))
    const near = t.marks
      .filter((m) => m.kind === "condition" && mates.has(idOf(m.ref)) && idOf(m.ref) !== idOf(r))
      .at(-1)
    if (!near) {
      rest.push(r)
      continue
    }
    let at = near.span[1]
    const own = /^['’]s\b/u.exec(t.value.slice(at))
    if (own) at += own[0].length
    const said = valueWords(r, roleOfDim(r.dim, words), words)
    t = insert(t, at, " or ", said, { kind: "condition", ref: r })
    if (own) t = insert(t, at + " or ".length + said.length, "", "'s", null)
  }
  const restIds = new Set(rest.map(idOf))
  for (const c of conditionsOf(after.where)) {
    const refs = conditionRefs(c).filter((r) => restIds.has(idOf(r)))
    if (!refs.length) continue
    const added: Condition =
      refs.length === 1 ? { kind: "all", ref: refs[0]! } : { kind: "any", refs }
    const role = roleOf(added, words)
    const lead =
      role === "space"
        ? " in "
        : role === "none"
          ? " with "
          : role === "relation"
            ? ` ${leadOf(refs[0]!.dim, words)} `
            : " · "
    t = say(t, tailAt(t, ["split", "then", "limit"]), lead, valuePieces(added, role, words))
  }
  // what it's split by, when the title didn't say what it was
  const says = (kind: "split" | "then") => t.marks.some((m) => m.kind === kind)
  if (a.by && a.by !== b.by && !says("split"))
    t = say(t, tailAt(t, ["then", "limit"]), " ", [
      { words: splitWords("split", a.by, words), part: { kind: "split", dim: a.by } },
    ])
  if (a.then && a.then !== b.then && !says("then"))
    t = say(t, tailAt(t, ["limit"]), ", ", [
      { words: splitWords("then", a.then, words), part: { kind: "then", dim: a.then } },
    ])

  t = trimmed(t)
  if (!/[\p{L}\p{N}]/u.test(t.value)) return null
  if (/^\p{Lu}/u.test(text.value)) t = { ...t, value: capital(t.value) }
  if (t.value === text.value && JSON.stringify(t.marks) === JSON.stringify(text.marks)) return text
  return { value: t.value.slice(0, QUERY_TEXT_MAX), marks: t.marks.slice(0, TEXT_MARKS_MAX) }
}

/** Pieces said at `at`, after `lead` (none at the text's start). */
function say(t: Draft, at: number, lead: string, pieces: Piece[]): Draft {
  let next = t
  let pos = at
  const first = at === 0 ? lead.trimStart() : lead
  for (const p of [first, ...pieces]) {
    const words = typeof p === "string" ? p : p.words
    next = insert(next, pos, "", words, typeof p === "string" ? null : p.part)
    pos += words.length
  }
  return next
}
