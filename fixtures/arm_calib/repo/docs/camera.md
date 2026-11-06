# The camera

An Intel RealSense D415 on the gripper's base. Its line of sight is parallel to the last joint's axis of rotation, offset from that axis sideways. At home the arm points down, so the camera looks down at the floor.

- `arm.snapshot()` gives its newest color frame as a JPEG: 640 x 480.
- Its intrinsics aren't given. In the sim the camera is ideal (no distortion), with the vertical field of view `scene.json` says (42 degrees, so fx = fy = 240 / tan(21 deg), about 625 px, and the principal point at the image's center). The real camera's are close to that and are worth estimating.
- In the arm's model it's the MuJoCo camera `realsense`. In the sim it looks along its -z with its image's top toward its +y; OpenCV's camera looks along +z with the image's top toward -y.
