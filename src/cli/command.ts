/** What every command gets, and how commands read their flags. */
import { parseArgs, type ParseArgsConfig } from "node:util"

import type { OnyxClient } from "../sdk"

import type { Io } from "./io"
import { UsageError, type Out } from "./output"

export interface Context {
  io: Io
  out: Out
  /** the command's own arguments, after its name */
  argv: string[]
  /** --profile */
  profile?: string
  /** --json was given (not only implied by a pipe) */
  jsonAsked: boolean
  configPath: string
  /** a client for the signed-in profile (or ONYX_URL / ONYX_TOKEN) */
  client(): OnyxClient
  /** a page of the app the client talks to, and whether it signs in as a person (not an API key) */
  app(path?: string): { url: string; person: boolean }
}

export interface Command {
  /** one line for `onyx help` */
  summary: string
  /** how to call it, and its flags */
  usage: string
  run(c: Context): Promise<number | void>
}

/** A command's flags and positionals; an unknown flag is a usage error. */
export function flags<O extends NonNullable<ParseArgsConfig["options"]>>(
  argv: string[],
  options: O
) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true })
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
}
