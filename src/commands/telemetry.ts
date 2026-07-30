import type { Args } from "../lib/args"
import { readConfig } from "../lib/config"
import {
  telemetryEffectiveState,
  updateTelemetryPreference,
} from "../lib/telemetry"

export async function commandTelemetry(args: Args) {
  const action = args.positional[1] ?? "status"
  if (action === "enable" || action === "disable") {
    await updateTelemetryPreference(action === "enable")
    console.log(
      `Onyx CLI telemetry ${action === "enable" ? "enabled" : "disabled"}.`
    )
    return
  }
  if (action !== "status") {
    throw new Error("Usage: onyx telemetry status|enable|disable")
  }
  const config = await readConfig()
  const effective = telemetryEffectiveState({ config, args })
  console.log(
    JSON.stringify(
      {
        preference: config.telemetry.enabled === false ? "disabled" : "enabled",
        effective: effective.enabled,
        identity: effective.profile?.userId ? "user" : "installation",
        notice: config.telemetry.noticeShownAt
          ? `shown ${config.telemetry.noticeShownAt}`
          : "pending (telemetry inactive until shown)",
      },
      null,
      2
    )
  )
}
