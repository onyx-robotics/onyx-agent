"""The experiment: run calibrate.py on the arm, and record the calibration it finds.

    python3 experiment.py        # by the endpoint, with ARM_SOCKET set

`calibrate.calibrate(arm, scene)` drives the arm (through arm.py), looks at the AprilTags
through the gripper's camera, and returns `{"calibration": {...}, "report": {...}}` (README.md,
"What a calibration is"). This checks its shape, writes it to `$ONYX_OUT/calibration.json`
(./out/ when there's no $ONYX_OUT), sends the arm home, and reports the calibration's own
numbers as metrics in `metrics.json` and on a last line `METRICS {json}`.

On the sim endpoint the site also measures the calibration against the arm's hidden truth
(calib.joint_err_deg, calib.camera_err_mm): numbers no experiment can see.
"""

import json
import math
import os
import sys
from pathlib import Path

import arm
import calibrate

HERE = Path(__file__).resolve().parent
JOINTS = 7
# the report's numbers that become metrics, and their names
REPORTED = {
    "reprojection_px": "calib.reprojection_px",
    "views": "calib.views",
    "tags_seen": "calib.tags_seen",
    "joint_sigma_deg": "calib.joint_sigma_deg",
    "camera_sigma_mm": "calib.camera_sigma_mm",
}


def check(result):
    """The calibration's shape (README.md); raises ValueError if it's wrong."""
    if not isinstance(result, dict) or not isinstance(result.get("calibration"), dict):
        raise ValueError('calibrate() must return {"calibration": {...}, "report": {...}}')
    c = result["calibration"]
    for key, n in (("joint_offsets_deg", JOINTS), ("camera_offset_mm", 3), ("camera_rotation_deg", 3)):
        v = c.get(key)
        if not (isinstance(v, list) and len(v) == n and all(isinstance(x, (int, float)) for x in v)):
            raise ValueError(f"calibration.{key} must be {n} numbers")
    for tag in c.get("tags") or []:
        if not ({"id", "pos", "rpy"} <= set(tag)):
            raise ValueError("each of calibration.tags has an id, pos and rpy (scene.json's form)")


def main():
    scene = json.loads((HERE / "scene.json").read_text())
    out = Path(os.environ.get("ONYX_OUT") or HERE / "out")
    out.mkdir(parents=True, exist_ok=True)
    try:
        result = calibrate.calibrate(arm, scene)
    finally:
        try:
            arm.post("/home")
        except Exception as e:  # noqa: BLE001 - a faulted arm says so in the log
            print(f"couldn't send the arm home: {e}")
    check(result)
    (out / "calibration.json").write_text(json.dumps(result, indent=2))
    report = result.get("report") or {}
    metrics = {
        name: float(report[key])
        for key, name in REPORTED.items()
        if isinstance(report.get(key), (int, float)) and math.isfinite(report[key])
    }
    (out / "metrics.json").write_text(json.dumps(metrics))
    print("calibration:", json.dumps(result["calibration"])[:500])
    print("METRICS " + json.dumps(metrics), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
