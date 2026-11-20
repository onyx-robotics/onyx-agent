/** This same onyx, for the commands that run it again: an agent's `onyx` shim, a CLI's hook. */

/** This same onyx, to run again: the binary itself, or bun with its entry point (and no .env). */
export function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/")
    ? [process.execPath]
    : [process.execPath, "--no-env-file", Bun.main]
}

export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
