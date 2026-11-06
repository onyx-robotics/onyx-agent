# The arm

The Onyx arm behind its joint server, run by a site. Two endpoints reach it the same way:

- **`arm.sim`**: the arm in MuJoCo behind the real joint server (`joint_server.py --sim`), a fresh one at home for each experiment.
- **`arm.real`**: the real arm, on its Orin, through its sandbox: your experiment runs in a fresh container whose only way to the arm is the joint server, so only within its limits. The arm is sent home before and after each experiment. One experiment at a time; others queue.

The quick evaluation runs on a sim arm of your own. The sim isn't the real arm (its gravity, friction and timing differ), so treat what it tells you as a check that your code runs, and the endpoint's numbers as the measurement.

- **Packet:** the commit. The site runs `python3 experiment.py` from your commit's root (or the script your experiment's packet names), with `ARM_SOCKET` set: talk to the arm only through `arm.py` (`arm.get`, `arm.post`), the joint server's HTTP API. The standard library and numpy are there; nothing else is.
- **What comes back:** everything the script prints (the end of it as the log), every number on its `METRICS {json}` lines, and files it writes to `$ONYX_OUT`. The site judges nothing; a script that exits non-zero fails the experiment, with the end of its output as the reason.
- **This project's experiment** (`experiment.py`, not editable): times `controller.move_to` through the poses in `onyx/endpoints/task.json`. A pose counts once every joint reads within `tolerance_deg` of it and slower than `settle_dps`, on every status read for `hold_s`. It prints `arm.total_time_s` (lower is better) and `arm.poses_done`.
- **The arm** (`GET /limits`): 7 motors, each within ±30 deg of home, at most 10 deg/s (one `speed` for all of them; more is clamped), accelerating at 100 deg/s². `POST /joints` sets targets (joints you leave out keep theirs) and takes effect at once; at most 10 commands a second on average, 5 at once (more get 429). `GET /status` gives measured `angles` (0.1 deg resolution), `current`, `targets` and `reached` (every joint within 3 deg). Status reads aren't limited. Joints sag under gravity where the arm is held out. A motor over its current limit for 0.2 s faults the arm: motion commands get 409, the experiment fails, and on the real arm nothing more runs until a person restarts the joint server, so don't push the limits to find them.
- **Time:** about as long as the script runs: 40 s for the baseline, plus the trips home on the real arm.
