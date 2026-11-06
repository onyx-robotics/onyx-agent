"""The experiment: time controller.py through the task's poses, measured through the arm's API.

    python3 experiment.py        # by the endpoint, with ARM_SOCKET set

For each pose in onyx/endpoints/task.json, in order, it calls `controller.move_to(pose)`,
then checks the pose from the arm's status: every joint within `tolerance_deg` of it and
slower than `settle_dps`, on every read for `hold_s`. A pose that doesn't hold within
`pose_timeout_s` of the move's start fails the run. The time is from the first move until
the last pose has held. Prints each pose's time, then `METRICS {json}`, and leaves the same
numbers in `$ONYX_OUT/metrics.json`, where the arm endpoints read a job's metrics.
"""

import json
import os
import sys
import time
from pathlib import Path

import arm
import controller

TASK = Path(__file__).resolve().parent / "onyx" / "endpoints" / "task.json"
# s between status reads while checking a pose: angles come at 0.1 deg resolution, so a
# flicker of one step between reads this far apart reads as 1 deg/s, under settle_dps
POLL = 0.1
MOTORS = [str(m) for m in range(1, 8)]


def holds(pose, task, deadline):
    """Wait until the arm holds pose; returns when that began, or None by the deadline."""
    tol, settle, hold = task["tolerance_deg"], task["settle_dps"], task["hold_s"]
    since, last = None, None
    while time.monotonic() < deadline:
        angles, now = arm.get("/status")["angles"], time.monotonic()
        close = all(abs(angles[m] - pose[m]) < tol for m in MOTORS)
        slow = last is not None and all(
            abs(angles[m] - last[1][m]) / (now - last[0]) < settle for m in MOTORS
        )
        last = (now, angles)
        if not (close and slow):
            since = None
        elif since is None:
            since = now
        elif now - since >= hold:
            return since
        time.sleep(POLL)
    return None


def main():
    task = json.loads(TASK.read_text())
    poses = [{m: float(p.get(m, 0.0)) for m in MOTORS} for p in task["poses"]]
    start, done = time.monotonic(), 0
    for i, pose in enumerate(poses):
        began = time.monotonic()
        controller.move_to({int(m): v for m, v in pose.items()})
        at = holds(pose, task, began + task["pose_timeout_s"])
        if at is None:
            angles = arm.get("/status")["angles"]
            worst = max(MOTORS, key=lambda m: abs(angles[m] - pose[m]))
            print(
                f"pose {i + 1} didn't hold within {task['pose_timeout_s']} s: motor {worst} "
                f"at {angles[worst]:+.2f} deg, wanted {pose[worst]:+.2f}"
            )
            break
        done += 1
        print(f"pose {i + 1} held from {at - start:.3f} s")
    metrics = {"arm.poses_done": done}
    if done == len(poses):
        total = time.monotonic() - start
        metrics["arm.total_time_s"] = round(total, 3)
        print(f"total time: {total:.3f} s")
    print("METRICS " + json.dumps(metrics), flush=True)
    if os.environ.get("ONYX_OUT"):
        with open(os.path.join(os.environ["ONYX_OUT"], "metrics.json"), "w") as f:
            json.dump(metrics, f)
    return 0 if done == len(poses) else 1


if __name__ == "__main__":
    sys.exit(main())
