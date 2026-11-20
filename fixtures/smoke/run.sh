#!/usr/bin/env bash
# One smoke run, end to end, against the local stack (`bun run dev`, or the app and dev-compactor
# nightly CI starts): an org for it, the project (setup.sh), `onyx research setup` and `run`, each
# under a time limit, then scripts/smoke-check.ts on what it left. Run from typescript/onyx-app.
#
#   bash onyx-agent/fixtures/smoke/run.sh <agent> <work dir> <out dir> [minutes]
#
# Leaves setup.log, run.log, findings.json and summary.md in <out dir>, and a copy of the run's
# directory in <out dir>/run. Exits as the check does: 1 when it found a hard failure.
set -uo pipefail
agent="$1"
work="$2"
out="$3"
minutes="${4:-4}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$work" "$out"
out="$(cd "$out" && pwd)"

# the org, and a sign-in for its admin (research:dev prints the exports)
eval "$(bun run research:dev -- --org "smoke-$agent" | grep '^export ')"
cfg="$(bash "$here/setup.sh" "$work" "$agent" "$minutes" 1)"
echo "[$agent] config: $cfg"

# setup has the base agent study the repo; the run stops proposing after its minutes, and lets
# what's running finish: a run still going well past that is a hang (exit 124)
timeout 15m bun run onyx -- research setup "$cfg" >"$out/setup.log" 2>&1
setup=$?
echo "[$agent] setup exited $setup"
run=0
if [ "$setup" -eq 0 ]; then
  timeout "$((minutes + 16))m" bun run onyx -- research run "$cfg" >"$out/run.log" 2>&1
  run=$?
  echo "[$agent] run exited $run"
fi
cat "$out/setup.log" "$out/run.log" 2>/dev/null >"$out/supervisor.log"

rundir="$(dirname "$cfg")/../.onyx-research"
[ -d "$rundir" ] && cp -r "$rundir" "$out/run"
bun onyx-agent/scripts/smoke-check.ts "$cfg" "$out" "setup=$setup" "run=$run" "log=$out/supervisor.log"
