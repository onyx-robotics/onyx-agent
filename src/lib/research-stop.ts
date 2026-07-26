import type { ApiSessionControlState } from "./api"
import { getLocalSessionState } from "./research-runtime"
import { onyxStateDir, readState } from "./runtime-state"
import { pathExists } from "./process"
import { join } from "node:path"
import {
  readSessionStateBriefSnapshot,
  type SessionStateBriefSnapshot,
} from "./session-state-brief"

export type LocalResearchStopReasonCode =
  | "stop_requested"
  | "session_terminal"
  | "deadline_reached"
  | "experiment_target_reached"

export type LocalResearchStopCheck = {
  shouldStop: boolean
  sessionId: string
  reasonCodes: LocalResearchStopReasonCode[]
  reasons: string[]
  controlState?: ApiSessionControlState
}

function addReason(
  reasonCodes: Set<LocalResearchStopReasonCode>,
  reasons: string[],
  code: LocalResearchStopReasonCode,
  reason: string
) {
  reasonCodes.add(code)
  if (!reasons.includes(reason)) reasons.push(reason)
}

function addControlStateReasons({
  control,
  nowMs,
  reasonCodes,
  reasons,
}: {
  control: ApiSessionControlState
  nowMs: number
  reasonCodes: Set<LocalResearchStopReasonCode>
  reasons: string[]
}) {
  const add = (code: LocalResearchStopReasonCode, reason: string) =>
    addReason(reasonCodes, reasons, code, reason)

  if (control.status !== "running") {
    if (control.progress.terminalReason === "experiment_target_reached") {
      add("experiment_target_reached", "experiment target reached")
    } else if (control.progress.terminalReason === "deadline_reached") {
      add("deadline_reached", "deadline reached")
    } else if (control.progress.terminalReason === "user_stopped") {
      add("stop_requested", "stop requested")
    }
    add("session_terminal", `session ${control.status}`)
  }
  if (
    control.progress.deadlineAt &&
    nowMs >= Date.parse(control.progress.deadlineAt)
  ) {
    add("deadline_reached", "deadline reached")
  }
  if (control.progress.remainingExperimentCount === 0) {
    add("experiment_target_reached", "experiment target reached")
  }
  if (!control.launch.acceptingExperiments) {
    if (control.progress.terminalReason === "experiment_target_reached") {
      add("experiment_target_reached", "experiment target reached")
    } else if (control.progress.terminalReason === "deadline_reached") {
      add("deadline_reached", "deadline reached")
    } else if (control.progress.terminalReason === "user_stopped") {
      add("stop_requested", "stop requested")
    } else {
      add("session_terminal", "session is not accepting experiments")
    }
  }
}

export async function collectLocalResearchStopReasons({
  root,
  sessionId,
  snapshot,
  nowMs = Date.now(),
}: {
  root: string
  sessionId: string
  snapshot?: SessionStateBriefSnapshot | null
  nowMs?: number
}): Promise<LocalResearchStopCheck> {
  const reasons: string[] = []
  const reasonCodes = new Set<LocalResearchStopReasonCode>()
  const add = (code: LocalResearchStopReasonCode, reason: string) =>
    addReason(reasonCodes, reasons, code, reason)

  const state = await readState(root).catch(() => null)
  const localSession = state?.sessions?.[sessionId]
  const stopMarkerExists = await onyxStateDir(root)
    .then((stateDir) =>
      pathExists(
        join(stateDir, "worker-runtime", sessionId, "stop-marker.json")
      )
    )
    .catch(() => false)
  if (localSession?.stopRequested || stopMarkerExists) {
    add("stop_requested", "stop requested")
  }

  const localSessionState = await getLocalSessionState(root, sessionId).catch(
    () => null
  )
  if (localSessionState) {
    if (localSessionState.session.status !== "running") {
      if (
        localSessionState.session.terminalReason === "experiment_target_reached"
      ) {
        add("experiment_target_reached", "experiment target reached")
      } else if (
        localSessionState.session.terminalReason === "deadline_reached"
      ) {
        add("deadline_reached", "deadline reached")
      } else if (localSessionState.session.terminalReason === "user_stopped") {
        add("stop_requested", "stop requested")
      }
      add(
        "session_terminal",
        `local session ${localSessionState.session.status}`
      )
    }
    const localDeadline = localSessionState.session.deadlineAt
      ? Date.parse(localSessionState.session.deadlineAt)
      : Number.NaN
    if (Number.isFinite(localDeadline) && nowMs >= localDeadline) {
      add("deadline_reached", "deadline reached")
    }
    if (localSessionState.session.remainingExperimentCount === 0) {
      add("experiment_target_reached", "experiment target reached")
    }
  }

  let controlState: ApiSessionControlState | undefined
  const resolvedSnapshot =
    snapshot === undefined
      ? await readSessionStateBriefSnapshot({
          root,
          sessionId,
        }).catch(() => null)
      : snapshot
  const brief = resolvedSnapshot?.brief ?? null
  if (brief) {
    controlState = {
      sessionId,
      status: brief.session.status,
      runtimeState: brief.session.status === "running" ? "active" : "ended",
      finalizationStatus: brief.session.finalizationStatus,
      assignments: [],
      progress: brief.progress,
      launch: {
        activeWorkerCount: 0,
        workerTarget: brief.session.workerTarget ?? 0,
        openWorkerSlotCount: 0,
        activeHypothesisCount: brief.activeHypotheses.length,
        acceptingExperiments: brief.session.status === "running",
      },
      finalization: {
        status: brief.session.finalizationStatus,
        reasons: [],
        terminalReason: brief.session.terminalReason,
      },
      updatedAt: brief.updatedAt,
    }
    addControlStateReasons({
      control: controlState,
      nowMs,
      reasonCodes,
      reasons,
    })
  }

  const workerResearchDeadline = process.env.ONYX_RESEARCH_DEADLINE_AT
    ? Date.parse(process.env.ONYX_RESEARCH_DEADLINE_AT)
    : Number.NaN
  if (
    Number.isFinite(workerResearchDeadline) &&
    nowMs >= workerResearchDeadline
  ) {
    add("deadline_reached", "worker shutdown cushion reached")
  }

  const result: LocalResearchStopCheck = {
    shouldStop: reasons.length > 0,
    sessionId,
    reasonCodes: [...reasonCodes],
    reasons,
  }
  if (controlState) result.controlState = controlState
  return result
}
