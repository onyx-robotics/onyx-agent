"""Calibrate the arm from the AprilTags its gripper camera sees: the baseline, to improve.

`calibrate(arm, scene)` returns `{"calibration": {...}, "report": {...}}` (README.md). This
baseline only looks: it visits a few poses, finds the tags in each camera frame, and saves
every observation, with the joint angles it was taken at, to `$ONYX_OUT/views.json`. It
returns the arm's nominal calibration (no corrections) and the scene's tags as they were.
"""

import json
import os
import time
from pathlib import Path

import cv2
import numpy as np

SPEED = 10.0  # deg/s
SETTLE = 0.5  # s to let the arm stop before a frame
# poses to look from, degrees from home for motors 1-7; within +/-30 deg of home
POSES = [
    {},
    {"1": 15},
    {"1": -15},
    {"6": 10},
    {"6": -10},
    {"5": 10, "7": 10},
]
DETECTOR = cv2.aruco.ArucoDetector(
    cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11),
    cv2.aruco.DetectorParameters(),
)


def move(arm, pose):
    targets = {str(m): float(pose.get(str(m), 0.0)) for m in range(1, 8)}
    arm.post("/joints", {"arm": targets, "speed": SPEED})
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if arm.get("/status")["reached"]:
            break
        time.sleep(0.1)
    time.sleep(SETTLE)
    return arm.get("/status")["angles"]


def look(arm):
    """The tags in a camera frame now: {id: 4 corners in pixels}, and the frame's size."""
    frame = cv2.imdecode(np.frombuffer(arm.snapshot(), np.uint8), cv2.IMREAD_GRAYSCALE)
    corners, ids, _ = DETECTOR.detectMarkers(frame)
    found = {} if ids is None else {int(i): c.reshape(4, 2).tolist() for c, i in zip(corners, ids.ravel())}
    return found, frame.shape[::-1]


def calibrate(arm, scene):
    views = []
    for pose in POSES:
        angles = move(arm, pose)
        tags, size = look(arm)
        views.append({"angles_deg": angles, "tags": tags, "image_size": size})
        print(f"pose {pose}: tags {sorted(tags)}")
    out = Path(os.environ.get("ONYX_OUT") or "out")
    out.mkdir(parents=True, exist_ok=True)
    (out / "views.json").write_text(json.dumps(views))
    seen = sorted({t for v in views for t in v["tags"]})
    return {
        "calibration": {
            "joint_offsets_deg": [0.0] * 7,
            "camera_offset_mm": [0.0, 0.0, 0.0],
            "camera_rotation_deg": [0.0, 0.0, 0.0],
            "tags": scene.get("tags", []),
        },
        "report": {"views": len(views), "tags_seen": len(seen)},
    }
