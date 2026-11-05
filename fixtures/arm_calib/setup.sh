#!/usr/bin/env bash
# Makes an arm calibration research project (repo/README.md): a git remote (bare), a working
# clone with calibrate.py (the baseline), scene.json (the tags, as first guessed), the fixed
# experiment.py and docs, and onyx/research.json; and a site for it (site.toml) with the sim
# arm (SIM_UNITS of them, 2 by default) and, with `both`, the real arm:
#
#   bash fixtures/arm_calib/setup.sh <dir> [minutes] [workers] [sim|both]
#
# The sim arm differs from its model by a hidden truth (<dir>/truth.json: small joint offsets
# and a camera mount error, made here, outside the repo) that the site scores calibrations
# against. `both` needs ARM_SSH, as fixtures/arm/setup.sh says.
#
# Needs ONYX_ROOT (the onyx checkout, python/onyx_arm synced: uv sync --extra sim). Then:
#   bun run research:dev -- --org <org> --pack onyx-agent/fixtures/arm/pack.yaml \
#     --pack onyx-agent/fixtures/arm_calib/pack.yaml --site <name> --site-state <dir>/site-state
#   onyx-site --site <dir>/site.toml run      # in python/site-runner
#   onyx research setup <dir>/calib/onyx/research.json && onyx research run <dir>/calib/onyx/research.json
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$(mkdir -p "$1" && cd "$1" && pwd)"
minutes="${2:-15}"
workers="${3:-2}"
which="${4:-sim}"
: "${ONYX_ROOT:?set ONYX_ROOT to the onyx checkout}"
arm="$ONYX_ROOT/python/onyx_arm"
uv="$(command -v uv)"
sim_units="${SIM_UNITS:-2}"
case "$which" in
  sim) real=0 ;;
  both)
    real=1
    : "${ARM_SSH:?set ARM_SSH to the command that reaches the sandbox on the Orin, as a JSON list}" ;;
  *) echo "the endpoints are sim or both, not $which" >&2; exit 2 ;;
esac

# the sim arm's hidden truth: a few tenths of a degree per joint, a few mm and tenths of a degree
# at the camera mount
[ -f "$dir/truth.json" ] || python3 - "$dir/truth.json" <<'PY'
import json, random, sys
r = random.Random()
truth = {
    "joint_offsets_deg": [round(r.uniform(-1.0, 1.0), 3) for _ in range(7)],
    "camera_offset_mm": [round(r.uniform(-4.0, 4.0), 2) for _ in range(3)],
    "camera_rotation_deg": [round(r.uniform(-1.0, 1.0), 3) for _ in range(3)],
}
open(sys.argv[1], "w").write(json.dumps(truth, indent=2) + "\n")
PY
chmod 600 "$dir/truth.json"

rm -rf "$dir/remote.git" "$dir/calib"
git init --quiet --bare --initial-branch=main "$dir/remote.git"
git init --quiet --initial-branch=main "$dir/calib"
cp -r "$here/repo/." "$dir/calib/"
cp "$arm/sandbox/arm.py" "$dir/calib/arm.py"
mkdir -p "$dir/calib/onyx"

real_endpoint=""
if [ "$real" = 1 ]; then
  real_endpoint=',
    { "type": "arm.real", "site": true, "capacity": 1, "timeoutS": 900, "guide": "README.md",
      "label": "the real arm, through the sandbox on its Orin, run by a site: runs experiment.py, sent home before and after; one at a time; the only way to find where the tags really are" }'
fi
cat > "$dir/calib/onyx/research.json" <<JSON
{
  "name": "arm-calibration-$(date +%Y%m%d-%H%M)",
  "goal": "Calibrate the Onyx arm from the three AprilTags its gripper camera can see (README.md): find its camera mount's offset and rotation, each joint's zero offset, and the tags' poses, with as little error and as much confidence as possible. Change calibrate.py (the method) and scene.json (where the tags are believed to be). Some of you should find where the tags really are, on the real arm when it's an endpoint, and put it in scene.json, which is how the sim learns the real world. On the sim, calib.joint_err_deg and calib.camera_err_mm are the honest scores (against a truth no job sees); a calibration's own sigmas should match its errors.",
  "remote": "../remote.git",
  "baseBranch": "main",
  "editable": ["calibrate.py", "scene.json"],
  "evaluate": "$uv run --quiet --project $arm --extra sim python -m onyx_arm.sim_run --scene scene.json --camera -- python3 experiment.py",
  "metrics": [
    { "key": "calib.joint_err_deg", "better": "lower" },
    { "key": "calib.camera_err_mm", "better": "lower" },
    { "key": "calib.reprojection_px", "better": "lower" },
    { "key": "calib.tags_seen", "better": "higher" }
  ],
  "endpoints": [
    { "type": "arm.sim", "site": true, "capacity": $sim_units, "timeoutS": 900, "guide": "README.md",
      "label": "the Onyx arm in MuJoCo behind its joint server, with its camera and the tags where scene.json says, run by a site: runs experiment.py, and scores the calibration against the sim arm's hidden truth" }$real_endpoint
  ],
  "models": { "base": "sonnet", "varop": "sonnet", "worker": "sonnet", "ghost": "haiku" },
  "workers": $workers,
  "experimentsPerTask": 3,
  "minutes": $minutes
}
JSON
printf '.onyx-research/\n__pycache__/\nout/\n' > "$dir/calib/.gitignore"

cat > "$dir/site.toml" <<TOML
[site]
server = "${ONYX_API_URL:-http://localhost:3000}"
state_dir = "$dir/site-state"
health_interval_s = 60

[files]
bind = "127.0.0.1:7443"
public_url = "http://localhost:7443"
insecure_http = true  # development only

[policy]
unit_types = ["arm.sim"$([ "$real" = 1 ] && echo ', "arm.real"')]
max_deadline_s = 900

[repos.calib]
url = "$dir/remote.git"

[drivers.sim_arm]
ref = "sim_arm:SimArm"
python_path = ["$arm/endpoint"]
instances = [$(seq -f '{ id = "sim-arm-%g" }' -s ', ' 1 "$sim_units")]

[drivers.sim_arm.config]
unit_type = "arm.sim"
arm_project = "$arm"
camera = true
truth = "$dir/truth.json"
score = ["$arm/.venv/bin/python", "$arm/endpoint/calib_score.py"]

[unit_types."arm.sim"]
driver = "sim_arm"
fidelity = "sim"
TOML
if [ "$real" = 1 ]; then
  cat >> "$dir/site.toml" <<TOML

[drivers.real_arm]
ref = "real_arm:RealArm"
python_path = ["$arm/endpoint"]
instances = [{ id = "onyx-arm" }]

[drivers.real_arm.config]
unit_type = "arm.real"
ssh = $ARM_SSH

[unit_types."arm.real"]
driver = "real_arm"
fidelity = "hardware"
TOML
fi
mkdir -p "$dir/site-state" && chmod 700 "$dir/site-state"
cd "$dir/calib"
git add -A
git -c user.name=onyx -c user.email=onyx@local commit --quiet -m "calibration: the baseline, and the tags as first guessed"
git remote add origin "$dir/remote.git"
git push --quiet origin main
echo "$dir/calib/onyx/research.json"
