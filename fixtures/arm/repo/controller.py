"""Moves the arm to a pose: what experiment.py times, pose after pose.

`move_to(pose)` gets every motor's target in degrees from home ({1: 20.0, ..., 7: -10.0})
and returns once it has moved the arm there; experiment.py then checks the pose holds.
It talks to the arm only through `arm.py`, the joint server's HTTP API.
"""

import time

import arm

SPEED = 5.0  # deg/s, every joint
TOLERANCE = 1.2  # deg: how close every joint must be before returning
SETTLE = 0.5  # s to wait once it's that close
POLL = 0.05  # s between status reads


def move_to(pose):
    arm.post("/joints", {"arm": {str(m): t for m, t in pose.items()}, "speed": SPEED})
    while True:
        angles = arm.get("/status")["angles"]
        if all(abs(angles[str(m)] - t) < TOLERANCE for m, t in pose.items()):
            break
        time.sleep(POLL)
    time.sleep(SETTLE)
