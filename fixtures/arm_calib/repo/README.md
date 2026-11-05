# Calibrating the Onyx arm from AprilTags

The arm (7 CubeMars joints, mounted upside down under a table, pointing down) has a RealSense camera on its gripper. Its line of sight is parallel to the last joint's axis, offset from it sideways. Three AprilTags (36h11, ids 0, 1 and 2, 165.1 mm black squares) are in its world: two on the floor roughly under the arm, and one standing up nearby. Where exactly is part of the problem.

**The goal:** calibrate the arm so it knows where its camera and joints really are, with as little error and as much confidence as possible:
- **the camera's mount:** its offset and rotation from where the arm's model (`docs/onyx_arm.urdf`) puts it;
- **each joint's zero:** its home is posed by hand, so each joint's true zero is off by a small offset;
- **the tags' poses,** which a calibration needs to find as well.

## What you change

- **`calibrate.py`:** the method. `calibrate(arm, scene)` drives the arm through `arm.py` (`arm.get`, `arm.post`, `arm.snapshot()` for a JPEG of the camera now) and returns what it found (below).
- **`scene.json`:** where the tags are believed to be, and the camera's size and field of view. On the sim endpoint the sim puts the tags where it says, so finding where they really are (on the real arm) and writing it here is how the sim learns the real world.

`experiment.py` (the experiment), `arm.py` and `docs/` are fixed.

## What a calibration is

```json
{"calibration": {"joint_offsets_deg": [7 numbers], "camera_offset_mm": [x, y, z],
                 "camera_rotation_deg": [roll, pitch, yaw],
                 "tags": [{"id": 0, "pos": [x, y, z], "rpy": [r, p, y]}, ...]},
 "report": {"reprojection_px": n, "views": n, "tags_seen": n,
            "joint_sigma_deg": n, "camera_sigma_mm": n}}
```

- A joint's offset is how far its true zero is from the zero it reports: commanding `a` puts it at `a + offset` in the model.
- The camera's offset and rotation are against the model's mount, in the camera's own frame.
- The tags are in the arm's base frame, as in `scene.json`.
- The report is the calibration's own account of itself: its reprojection error (pixels, root mean square), how many views and tags it used, and its 1-sigma uncertainty in the joints and the camera mount (its confidence). Leave out what you don't compute.

## How it's measured

- **Every endpoint:** the report becomes metrics: `calib.reprojection_px`, `calib.views`, `calib.tags_seen`, `calib.joint_sigma_deg`, `calib.camera_sigma_mm`.
- **The sim endpoint (`arm.sim`)** also measures the calibration against the sim arm's hidden truth: `calib.joint_err_deg` (root mean square over the joints) and `calib.camera_err_mm`. That truth is the same on every sim arm and no job sees it, so these are the honest scores of a method. A sigma near its error is a calibration that knows how good it is.
- **The real arm (`arm.real`)** has no truth to compare with: its reprojection error, and how well its tags agree across views, are what it has. It's also the only way to find where the tags really are.

## Docs

- `docs/onyx_arm.urdf`: the arm's model; its kinematics (joints Revolute_18, 19, 17, 20, 24, 22, 23 are motors 1 to 7).
- `docs/dimensions.md`: the arm's drawing's dimensions, approximate.
- `docs/camera.md`: the camera.
