/** `onyx ingest`: an NDJSON file of records, checked whole, then sent in chunks (ingest-file.ts). */
import { existsSync } from "node:fs"

import {
  BATCH_LIMITS,
  IngestStreamError,
  OnyxApiError,
  type IngestRecord,
  type IngestTotals,
} from "../../sdk"

import { need } from "../args"
import { flags, type Command } from "../command"
import { RecordReader, type LineIssue, type ReadOptions } from "../ingest-file"
import { lines, type Io } from "../io"
import { CliError, EXIT, exitCode, UsageError } from "../output"

const sum = (t: {
  items: IngestTotals["items"]
  edges: IngestTotals["edges"]
  metrics: number
  observations?: IngestTotals["observations"]
  refs: number
}) =>
  `items ${t.items.created} new, ${t.items.updated} updated, ${t.items.unchanged} unchanged; ` +
  `edges ${t.edges.created} new, ${t.edges.unchanged} unchanged` +
  `${t.edges.closed ? `, ${t.edges.closed} closed` : ""}; ` +
  `metric values ${t.observations?.new ?? t.metrics} new` +
  `${t.observations?.recognised ? `, ${t.observations.recognised} already recorded` : ""}; refs ${t.refs}`

/** The file's records, checked: every problem in it, or its records. */
async function check(io: Io, path: string, opts: ReadOptions) {
  const reader = new RecordReader(opts)
  const issues: LineIssue[] = []
  const records: { line: number; record: IngestRecord }[] = []
  for await (const text of lines(io, path)) {
    const r = await reader.read(text)
    issues.push(...r.issues)
    if (r.record && !issues.length) records.push({ line: r.line, record: r.record })
  }
  return { issues, records }
}

export const ingestCommand: Command = {
  summary: "send an NDJSON file of items, edges, metrics and refs (safe to send again)",
  usage: `onyx ingest <file | -> [--dry-run] [--atomic] [--mint-ids] [--namespace <name>]

One record per line, in the API's shapes: {"item": …}, {"edge": …}, {"metric": …}, {"ref": …}.
Every line is checked before anything is sent. Records go in chunks (one transaction each):
a file that stops partway can be sent again whole, and what was sent comes back unchanged.

  --dry-run    check, write nothing: every line here, and the first chunk (an --atomic file
               whole) by the server, as a write and then rolled back
  --atomic     send the file as one transaction (it must fit one batch: 2000 items,
               5000 edges, 2000 metric reports, 2000 refs)
  --mint-ids   allow items without a key (id, source, or identity and revision); each run
               then makes them again
  --namespace  keep this run's metric reports apart from identical ones sent by another run
               (a CI run id, say)`,
  async run(c) {
    const { values, positionals } = flags(c.argv, {
      "dry-run": { type: "boolean" },
      atomic: { type: "boolean" },
      "mint-ids": { type: "boolean" },
      namespace: { type: "string" },
    })
    const path = need(positionals[0], "the file (- for standard input)")
    if (path !== "-" && !existsSync(path)) throw new UsageError(`no file ${path}`)
    const label = path === "-" ? "stdin" : path
    const dryRun = values["dry-run"] === true
    const opts: ReadOptions = { mintIds: values["mint-ids"], namespace: values.namespace }
    // checked whole first: a bad line stops the file before anything is sent (standard input
    // can't be read twice, so its records are kept from the check)
    const checked = await check(c.io, path, opts)
    if (checked.issues.length) {
      const n = checked.issues.length
      throw new CliError(
        `${n} problem${n === 1 ? "" : "s"} in ${label}: nothing was sent`,
        EXIT.invalid,
        checked.issues.slice(0, 50).map((i) => ({
          path: `${label}:${i.line}${i.path ? ` ${i.path}` : ""}`,
          message: i.message,
        })),
        "validation_failed"
      )
    }
    const records = path === "-" ? checked.records : (await check(c.io, path, opts)).records
    if (values.atomic) {
      const n = { items: 0, edges: 0, metrics: 0, refs: 0 }
      for (const { record } of records)
        n[
          ("item" in record
            ? "items"
            : "edge" in record
              ? "edges"
              : "metric" in record
                ? "metrics"
                : "refs") as keyof typeof n
        ]++
      const over = (Object.keys(n) as (keyof typeof n)[]).filter((k) => n[k] > BATCH_LIMITS[k])
      if (over.length)
        throw new UsageError(
          `too large for one transaction (${over.map((k) => `${n[k]} ${k}, at most ${BATCH_LIMITS[k]}`).join("; ")}): send it without --atomic`
        )
    }
    const stream = c.client().stream<number>({
      ...(values.atomic ? { chunkItems: BATCH_LIMITS.items, maxBytes: Infinity } : {}),
      dryRun,
      onChunk: (r, range) => {
        if (c.out.human)
          c.out.note(
            `lines ${range.first}-${range.last}: ${dryRun ? "would make " : ""}${sum(r)}${r.txid ? ` (txid ${r.txid})` : ""}`
          )
        else
          c.out.ndjson({
            lines: [range.first, range.last],
            txid: r.txid,
            items: r.items,
            edges: r.edges,
            metrics: r.metrics,
            refs: r.refs,
          })
      },
    })
    let totals: IngestTotals
    try {
      for (const { line, record } of records) await stream.add(record, line)
      totals = await stream.close()
    } catch (e) {
      if (!(e instanceof IngestStreamError)) throw e
      const err = e as IngestStreamError<number>
      const sent = dryRun
        ? "a dry run: nothing was written"
        : err.committedThrough === null
          ? "nothing was sent"
          : `lines up to ${err.committedThrough} were sent; send the file again once it's fixed`
      throw new CliError(
        `${err.message} (lines ${err.range.first}-${err.range.last}): ${sent}`,
        exitCode(err),
        err.issues.map((i) => ({
          path:
            i.origin !== undefined ? `${label}:${i.origin}${i.path ? ` ${i.path}` : ""}` : i.path,
          message: i.message,
        })),
        err.cause instanceof OnyxApiError ? err.cause.code : "error"
      )
    }
    if (dryRun) {
      const through = records[totals.records - 1]?.line ?? null
      if (!c.out.human) return void c.out.ndjson({ done: true, ...totals, checkedThrough: through })
      c.out.line(
        `dry run, nothing written: every line of ${label} is well formed, and the server checked lines ${records[0]?.line ?? "-"}-${through ?? "-"}: they would make ${sum(totals)}`
      )
      if (totals.unchecked)
        c.out.line(
          `the ${totals.unchecked} records after them weren't sent: they name items the first chunk would make (--atomic checks a file that fits one batch whole)`
        )
      return
    }
    // what a person just made, the app's "Your work" button shows (an API key's agent's it doesn't:
    // it's not theirs)
    const app = c.app()
    const yours = app.person && totals.items.created > 0 ? app.url : null
    if (c.out.human) {
      c.out.line(
        `sent ${totals.records} records from ${label} in ${totals.chunks} chunk${totals.chunks === 1 ? "" : "s"}: ${sum(totals)}`
      )
      if (yours) c.out.line(`see it with Your work: ${yours}`)
    } else c.out.ndjson({ done: true, ...totals, ...(yours ? { url: yours } : {}) })
  },
}
