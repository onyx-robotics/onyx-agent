export type Args = {
  positional: string[]
  options: Record<string, string>
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const options: Record<string, string> = {}

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) {
      positional.push(token)
      continue
    }

    const key = token.slice(2)
    const eq = key.indexOf("=")

    if (eq !== -1) {
      options[key.slice(0, eq)] = key.slice(eq + 1)
      continue
    }

    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      options[key] = "true"
    } else {
      options[key] = next
      i += 1
    }
  }

  return { positional, options }
}

export function requireOption(args: Args, name: string): string {
  const value = args.options[name]
  if (!value) {
    throw new Error(`Missing required --${name}`)
  }
  return value
}

export function optionalFlag(args: Args, name: string) {
  return args.options[name] === "true"
}

export function normalizeName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function nameOption(args: Args) {
  const value = args.options.name
  if (!value) throw new Error("Missing required --name")
  const name = normalizeName(value)
  if (!name)
    throw new Error("--name must contain at least one letter or number")
  return name
}

export function descriptionOption(args: Args): string | null {
  return args.options.description ?? null
}
