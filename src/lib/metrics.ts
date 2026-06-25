export function parseMetricLines(stdout: string, fallbackName = "score") {
  const metrics: Record<string, number> = {}
  for (const line of stdout.split("\n")) {
    const match = line
      .trim()
      .match(/^METRIC\s+([A-Za-z0-9_.:-]+)=(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i)
    if (!match) continue
    metrics[match[1]!] = Number(match[2])
  }

  if (Object.keys(metrics).length === 0) {
    const trimmed = stdout.trim()
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed)) {
      metrics[fallbackName] = Number(trimmed)
    }
  }

  return metrics
}

export function parseWorkflowMetricLines(
  stdout: string,
  metricName: string
): { metrics: Record<string, number>; error: string | null } {
  const metricLines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("METRIC "))
  if (metricLines.length === 0) {
    return {
      metrics: {},
      error: `Expected one primary METRIC ${metricName}=<number> line; found none.`,
    }
  }
  const metrics: Record<string, number> = {}
  for (const line of metricLines) {
    const match = line.match(
      /^METRIC\s+([A-Za-z0-9_.:-]+)=(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i
    )
    if (!match) {
      return { metrics: {}, error: `Invalid METRIC line: ${line}` }
    }
    const name = match[1]!
    if (Object.hasOwn(metrics, name)) {
      return {
        metrics: {},
        error: `Duplicate METRIC ${name}=<number> line.`,
      }
    }
    metrics[name] = Number(match[2])
  }
  if (!Object.hasOwn(metrics, metricName)) {
    return {
      metrics: {},
      error: `Expected one primary METRIC ${metricName}=<number> line; found ${metricLines.length} metric line(s) without the primary metric.`,
    }
  }
  return { metrics, error: null }
}

export function summarizeOutput(stdout: string, stderr: string) {
  return [stdout.trim(), stderr.trim()]
    .filter(Boolean)
    .join("\n--- stderr ---\n")
    .slice(0, 4000)
}

export function primaryMetric(
  metrics: Record<string, number>,
  preferredName: string
): { name: string; value: number | null } {
  if (Object.hasOwn(metrics, preferredName)) {
    return { name: preferredName, value: metrics[preferredName] ?? null }
  }

  const [firstName, firstValue] = Object.entries(metrics)[0] ?? []
  return {
    name: firstName ?? preferredName,
    value: firstValue ?? null,
  }
}
