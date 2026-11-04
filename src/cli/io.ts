/**
 * What a run of the CLI reads and writes. `main.ts` wires the process; tests pass their own
 * (an in-process fetch, captured output, a config file of their own).
 */
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

export interface Io {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** standard input, a line at a time */
  stdin: () => AsyncIterable<string>
  /** standard output is a terminal: a person is reading (tables), else a program (JSON) */
  isTTY: boolean
  /** the environment (ONYX_URL, ONYX_TOKEN, ONYX_PROFILE, ONYX_CONFIG, XDG_CONFIG_HOME, HOME) */
  env: Record<string, string | undefined>
  fetch?: typeof fetch
  /** ask a person; null when nobody can answer (not a terminal) */
  prompt: (question: string, opts?: { hidden?: boolean }) => Promise<string | null>
  sleep: (ms: number) => Promise<void>
  /** open a URL in the person's browser (best effort): whether it opened */
  openUrl?: (url: string) => Promise<boolean>
}

/** A file's lines (`-`: standard input). */
export function lines(io: Io, path: string): AsyncIterable<string> {
  if (path === "-") return io.stdin()
  return createInterface({ input: createReadStream(path), crlfDelay: Infinity })
}

/** An environment variable, with empty meaning unset (an env file may hold `X=""`). */
export const envVar = (io: Io, name: string): string | undefined => io.env[name] || undefined

/**
 * Whether trying a browser makes sense: not over SSH (it would open on the other machine, or
 * nowhere), not on Linux with no display, not when ONYX_NO_BROWSER says so. The URL and the code
 * are printed either way.
 */
export function canOpenBrowser(env: Io["env"], platform: string): boolean {
  if (env.ONYX_NO_BROWSER || env.SSH_CONNECTION || env.SSH_TTY) return false
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  return true
}
