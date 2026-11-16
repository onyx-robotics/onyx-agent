#!/usr/bin/env bash
# Makes an Onyx arm research project: a git remote (bare), a working clone with the baseline
# controller.py, the experiment that times it (experiment.py and its task), arm.py, the
# endpoint's guide and onyx/research.json; and site.toml, a site that runs the endpoint:
#
#   bash fixtures/arm/setup.sh <dir> [minutes] [workers] [sim|real|both]
#
# - sim (the default): SIM_UNITS sim arms (2), the MuJoCo arm behind its joint server
#   (python/onyx_arm/endpoint/sim_arm.py);
# - real: the real arm, through its Orin's sandbox (endpoint/real_arm.py). ARM_SSH is the command
#   that reaches the sandbox with the agent key, as a JSON list, e.g.
#   '["ssh", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
#     "-i", "/home/me/.ssh/onyx_agent", "onyx@onyx-2.local"]' (a Windows ssh.exe's key path
#   with forward slashes: a backslash is an escape in TOML).
#   joint_server.py must be serving on the Orin's sandbox socket (python/onyx_arm/README.md).
# - both: the two endpoints in one run; workers choose one for each experiment.
# Whichever, a worker's quick evaluation only compiles controller.py: experiments run on the endpoints.
#
# Needs ONYX_ROOT (the onyx checkout, with python/onyx_arm synced: uv sync --extra sim). Then:
#   bun run research:dev -- --org <org> --site <name> --site-state <dir>/site-state
#   onyx research vocabulary <dir>/arm/onyx/research.json   # arm.sim and its metrics, for the site
#   onyx-site --site <dir>/site.toml run      # in python/site-runner
#   onyx research setup <dir>/arm/onyx/research.json && onyx research run <dir>/arm/onyx/research.json
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
# each endpoint's driver, in the site file
driver_sim() {
  cat <<TOML
[drivers.sim_arm]
ref = "sim_arm:SimArm"
python_path = ["$arm/endpoint"]
instances = [$(seq -f '{ id = "sim-arm-%g" }' -s ', ' 1 "$sim_units")]   # one per sim arm

[drivers.sim_arm.config]
unit_type = "arm.sim"
arm_project = "$arm"

[unit_types."arm.sim"]
driver = "sim_arm"
fidelity = "sim"
TOML
}
driver_real() {
  cat <<TOML
[drivers.real_arm]
ref = "real_arm:RealArm"
python_path = ["$arm/endpoint"]
instances = [{ id = "onyx-arm" }]   # one per arm

[drivers.real_arm.config]
unit_type = "arm.real"
ssh = $ARM_SSH

[unit_types."arm.real"]
driver = "real_arm"
fidelity = "hardware"
TOML
}
# each endpoint in research.json
endpoint_sim() {
  cat <<JSON
    { "type": "arm.sim", "site": true, "capacity": $sim_units, "timeoutS": 600, "guide": "onyx/endpoints/arm.md",
      "label": "the Onyx arm in MuJoCo behind its joint server, $sim_units of them, run by a site: runs experiment.py" }
JSON
}
endpoint_real() {
  cat <<JSON
    { "type": "arm.real", "site": true, "capacity": 1, "timeoutS": 600, "guide": "onyx/endpoints/arm.md",
      "label": "the real Onyx arm, through the sandbox on its Orin, run by a site: runs experiment.py, sent home before and after; one at a time" }
JSON
}
case "$which" in
  sim) kinds=(sim) ;;
  real) kinds=(real) ;;
  both) kinds=(real sim) ;;
  *) echo "the endpoint is sim, real or both, not $which" >&2; exit 2 ;;
esac
if [[ " ${kinds[*]} " == *" real "* ]]; then
  : "${ARM_SSH:?set ARM_SSH to the command that reaches the sandbox on the Orin, as a JSON list}"
fi
endpoints=$(for k in "${kinds[@]}"; do "endpoint_$k"; done | sed '$!s/}$/},/')
types=$(for k in "${kinds[@]}"; do printf '"arm.%s", ' "$k"; done | sed 's/, $//')
measured="arm.${kinds[0]}"

rm -rf "$dir/remote.git" "$dir/arm"
git init --quiet --bare --initial-branch=main "$dir/remote.git"
git init --quiet --initial-branch=main "$dir/arm"
cp -r "$here/repo/." "$dir/arm/"
cp "$arm/sandbox/arm.py" "$dir/arm/arm.py"
cp "$here/task.json" "$dir/arm/onyx/endpoints/task.json"
cat > "$dir/arm/onyx/research.json" <<JSON
{
  "name": "arm-poses-$which-$(date +%Y%m%d-%H%M)",
  "goal": "Make controller.py move the Onyx arm through the task's poses (onyx/endpoints/task.json) as fast as possible, measured as arm.total_time_s on the $measured endpoint (onyx/endpoints/arm.md), reaching every pose, without tripping a motor's current limit. The controller only talks to the arm through arm.py. Every timing is an experiment on an endpoint: never run the sim yourself.",
  "remote": "../remote.git",
  "baseBranch": "main",
  "editable": ["controller.py"],
  "evaluate": "python3 -m py_compile controller.py && echo ok",
  "metrics": [
    { "key": "arm.total_time_s", "better": "lower", "label": "Total time", "unit": "s" },
    { "key": "arm.poses_done", "better": "higher", "label": "Poses reached" }
  ],
  "endpoints": [
$endpoints
  ],
  "models": { "base": "sonnet", "varop": "sonnet", "worker": "sonnet", "ghost": "haiku" },
  "workers": $workers,
  "experimentsPerTask": 3,
  "minutes": $minutes
}
JSON
printf '.onyx-research/\n__pycache__/\n' > "$dir/arm/.gitignore"
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
unit_types = [$types]
max_deadline_s = 900

[repos.arm]
url = "$dir/remote.git"

TOML
for k in "${kinds[@]}"; do echo; "driver_$k"; done >> "$dir/site.toml"
mkdir -p "$dir/site-state" && chmod 700 "$dir/site-state"
cd "$dir/arm"
git add -A
git -c user.name=onyx -c user.email=onyx@local commit --quiet -m "arm: the baseline controller"
git remote add origin "$dir/remote.git"
git push --quiet origin main
echo "$dir/arm/onyx/research.json"
