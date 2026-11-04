/**
 * What the CLI prints. A person at a terminal gets tables and sentences; anything else (a pipe,
 * a script, an agent) gets JSON: one document per command, NDJSON for streams. `--json` and
 * `--human` choose. Errors go to stderr, as the API's envelope in JSON, and set the exit code.
 */
import { DeviceAuthorizationError, IngestStreamError, OnyxApiError, OnyxNetworkError } from "../sdk"

import type { Io } from "./io"

export type Mode = "json" | "human"

/** Exit codes: what went wrong, for scripts to tell apart. */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  invalid: 3,
  auth: 4,
  notFound: 5,
  conflict: 6,
  /** busy, timed out or unreachable, after the client's retries */
  unavailable: 7,
  /** `registry plan --detailed-exitcode`: there are changes */
  changes: 8,
  /** `run --wait`, `jobs wait`: a job ended without succeeding */
  jobFailed: 9,
} as const

/** The command was used wrongly: what to do instead. */
export class UsageError extends Error {
  readonly name = "UsageError"
}

/** An error to show as is, with the exit code it means. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exit: number,
    readonly issues: { path: string; message: string }[] = [],
    readonly code = "error"
  ) {
    super(message)
  }
}

export class Out {
  constructor(
    private readonly io: Io,
    readonly mode: Mode
  ) {}

  get human(): boolean {
    return this.mode === "human"
  }

  /** One JSON document (pretty for a person who asked for JSON at a terminal). */
  json(value: unknown): void {
    this.io.stdout(`${JSON.stringify(value, null, this.io.isTTY ? 2 : undefined)}\n`)
  }

  /** One record of a stream. */
  ndjson(value: unknown): void {
    this.io.stdout(`${JSON.stringify(value)}\n`)
  }

  line(text = ""): void {
    this.io.stdout(`${text}\n`)
  }

  /** Progress and notes for a person: stderr, so stdout stays the result. */
  note(text: string): void {
    this.io.stderr(`${text}\n`)
  }

  /** Columns padded to their widest cell; long cells are cut. */
  table(headers: string[], rows: (string | number | null | undefined)[][]): void {
    const cell = (v: string | number | null | undefined) => {
      const s = v === null || v === undefined ? "" : String(v)
      return s.length > 60 ? `${s.slice(0, 59)}…` : s
    }
    const cells = rows.map((r) => r.map(cell))
    const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]!.length)))
    const fmt = (r: string[]) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd()
    this.line(fmt(headers))
    for (const r of cells) this.line(fmt(r))
  }
}

/** The exit code an error means. */
export function exitCode(e: unknown): number {
  if (e instanceof UsageError) return EXIT.usage
  if (e instanceof CliError) return e.exit
  if (e instanceof IngestStreamError) return exitCode(e.cause)
  if (e instanceof OnyxApiError) {
    if (e.status === 400) return EXIT.invalid
    if (e.status === 401 || e.status === 403) return EXIT.auth
    if (e.status === 404) return EXIT.notFound
    if (e.status === 409) return e.retryable ? EXIT.unavailable : EXIT.conflict
    if (e.status === 429 || e.status >= 500) return EXIT.unavailable
    return EXIT.unexpected
  }
  // the server is down, unreachable or too slow, after the client's retries
  if (e instanceof OnyxNetworkError) return EXIT.unavailable
  // a sign-in turned down, expired or refused
  if (e instanceof DeviceAuthorizationError) return EXIT.auth
  return EXIT.unexpected
}

/** Print an error where it belongs; returns the exit code. */
export function reportError(io: Io, mode: Mode, e: unknown): number {
  const code = exitCode(e)
  const api = e instanceof OnyxApiError ? e : e instanceof IngestStreamError ? e.cause : null
  const issues =
    e instanceof CliError ? e.issues : api instanceof OnyxApiError ? (api.issues ?? []) : []
  const message =
    api instanceof OnyxApiError ? api.message.split(": ")[0]! : ((e as Error)?.message ?? String(e))
  if (mode === "json") {
    const error = {
      code:
        e instanceof UsageError
          ? "usage"
          : e instanceof CliError
            ? e.code
            : api instanceof OnyxApiError
              ? api.code
              : e instanceof OnyxNetworkError
                ? "unavailable"
                : e instanceof DeviceAuthorizationError
                  ? e.code
                  : "error",
      message,
      ...(issues.length ? { issues } : {}),
      ...(api instanceof OnyxApiError && api.requestId ? { requestId: api.requestId } : {}),
    }
    io.stderr(`${JSON.stringify({ error })}\n`)
  } else {
    io.stderr(`error: ${message}\n`)
    for (const i of issues) io.stderr(`  ${i.path ? `${i.path}: ` : ""}${i.message}\n`)
    if (e instanceof UsageError) io.stderr("(onyx help lists the commands)\n")
  }
  return code
}
