// Renders a seeded `onyx listen` frame for the README screenshot.
//
// This drives the real TUI renderer (src/lib/tui.ts renderFrame) with
// hand-authored data, so the screenshot is pixel-faithful to the product
// without launching a research session. Rendered by assets/onyx-listen.tape.
//
//   bun scripts/demo-listen-frame.ts

import {
  renderFrame,
  type ExperimentRow,
  type ListenModel,
  type ListenWorkerRow,
} from "../src/lib/tui"

const NOW = Date.parse("2026-08-02T22:40:00.000Z")

const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

function worker(
  slot: number,
  hypothesis: string,
  trace: string,
  phase: string,
  ageSeconds: number
): ListenWorkerRow {
  return {
    workerId: `worker_${slot}`,
    workerName: `codex-${slot}`,
    hypothesisName: hypothesis,
    status: "running",
    phase,
    progressMessage: null,
    trace,
    slotIndex: slot,
    latestAt: at(ageSeconds),
    lastSeenAt: at(ageSeconds),
    lastOutputAt: at(ageSeconds),
    startedAt: at(ageSeconds + 300),
    completedAt: null,
    attemptDelivery: null,
    resultRefPushStatus: null,
    terminalReasonCode: null,
    worktreeCleanup: null,
    terminalError: null,
    activityLogPath: null,
    logPath: null,
  }
}

function experiment(
  name: string,
  description: string,
  metric: number,
  sha: string,
  ageSeconds: number,
  durationSeconds: number
): ExperimentRow {
  return {
    campaignName: "controller-design",
    name,
    description,
    status: "succeeded",
    resultCommitSha: sha,
    primaryMetricName: "integral_abs_error",
    primaryMetricValue: metric,
    createdAt: at(ageSeconds),
    startedAt: at(ageSeconds + durationSeconds),
    completedAt: at(ageSeconds),
    source: "api",
  }
}

const rows: ExperimentRow[] = [
  experiment("pid-baseline-zn-tuned", "Ziegler-Nichols tuned PID baseline for the plant.", 2.8571, "b2c02c1a", 870, 11.313),
  experiment("pid-filtered-derivative", "Added first-order filtered derivative, tau=0.05.", 2.3193, "2bf9242e", 820, 14.084),
  experiment("lqr-state-feedback", "LQR state feedback from the linearized plant model.", 1.9642, "d943d9d3", 764, 21.226),
  experiment("lqr-integral-augmented", "Augmented LQR with integral state to remove offset.", 1.6237, "bf9d1f97", 705, 24.042),
  experiment("smc-boundary-layer", "Sliding-mode control with tanh boundary layer.", 1.7332, "f24bb751", 648, 19.412),
  experiment("pid-feedforward-static", "Static setpoint feedforward over the PID baseline.", 1.8561, "f684dab2", 590, 12.604),
  experiment("mpc-horizon-4", "Short-horizon MPC, N=4, input clamped to ±10.", 1.5814, "c0c9c832", 531, 33.41),
  experiment("mpc-horizon-8", "Extended prediction horizon to 8 steps.", 1.4276, "83936cdf", 470, 41.849),
  experiment("smc-adaptive-gain", "Sliding-mode gain scheduled on |error|.", 1.6098, "c92ab1c4", 415, 22.955),
  experiment("lqr-effort-retuned", "Reweighted LQR effort penalty, R=0.08.", 1.5127, "434cb4e9", 356, 25.371),
  experiment("mpc-move-blocking", "Move blocking cuts MPC compute at equal horizon.", 1.4409, "2c6926f0", 300, 29.962),
  experiment("pid-gain-scheduled", "Gain-scheduled PID across the reference steps.", 1.7846, "f2343117", 246, 13.678),
  experiment("mpc-terminal-cost", "Added LQR terminal cost to the MPC objective.", 1.3762, "483cc5c8", 195, 38.219),
  experiment("smc-feedforward-hybrid", "Feedforward-augmented sliding-mode controller.", 1.5308, "e91a935b", 140, 20.108),
  experiment("mpc-horizon-12", "Longer horizon: marginal gain, 2.1x compute.", 1.3714, "52408b3d", 92, 47.263),
  experiment("mpc-constraint-soften", "Softened input-rate constraints near saturation.", 1.3529, "9c4f93c6", 41, 36.117),
  experiment("mpc-terminal-retuned", "Retuned terminal weight against overshoot.", 1.3218, "ac8ed8e1", 12, 34.098),
]

const workers: ListenWorkerRow[] = [
  worker(1, "Model predictive control", "Sweeping prediction horizon against compute budget", "measuring", 2),
  worker(2, "LQR state feedback", "Retuning effort penalty after integral augmentation", "editing", 5),
  worker(3, "Sliding-mode control", "Widening boundary layer to cut chattering", "measuring", 3),
  worker(4, "Feedforward augmentation", "Combining model feedforward with PI feedback", "committing", 8),
  worker(5, "Optimized PID baseline", "Evaluating filtered-derivative time constants", "measuring", 1),
  worker(6, "Model predictive control", "Testing move blocking at horizon 8", "editing", 6),
  worker(7, "LQR state feedback", "Verifying gain margins on the linearized model", "measuring", 4),
  worker(8, "Sliding-mode control", "Scheduling switching gain on tracking error", "editing", 7),
  worker(9, "Model predictive control", "Adding terminal cost from the LQR solution", "measuring", 2),
  worker(10, "Feedforward augmentation", "Measuring tracking lag on reference steps", "measuring", 5),
]

const model: ListenModel = {
  projectName: "hardware-system",
  campaignName: "controller-design",
  sessionId: "session_demo",
  sessionStatus: "running",
  metricName: "integral_abs_error",
  metricUnit: "error_seconds",
  metricDirection: "minimize",
  bestValue: Math.min(...rows.map((row) => row.primaryMetricValue ?? Infinity)),
  activity: "committed ac8ed8e · Retune MPC terminal weight · 3m",
  active: true,
  rows,
  workers,
  workerTarget: 10,
}

const columns = process.stdout.columns || 137
const rowsAvail = process.stdout.rows || 42

// Clear the scrollback so only the frame is visible in the capture.
process.stdout.write("[?25l[2J[3J[H")
process.stdout.write(
  renderFrame(model, { columns, rows: rowsAvail, nowMs: NOW }).join("\n") + "\n"
)

// Hold the frame on screen so the capture never shows a shell prompt.
await Bun.sleep(60_000)
