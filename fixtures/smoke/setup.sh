#!/usr/bin/env bash
# Makes the smoke test project: a git remote (bare) and a working clone with a slow solver.py, the
# bench endpoint's driver and guide, and a short onyx/research.json for the given coding agent.
# Nightly CI runs it once per agent (.github/workflows/nightly-research.yml) to catch bugs in
# `onyx research` end to end; it needs only git and python3.
#
#   bash fixtures/smoke/setup.sh <dir> <agent> [minutes] [workers]
#
# Prints the config's path.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$(mkdir -p "$1" && cd "$1" && pwd)"
agent="$2"
minutes="${3:-4}"
workers="${4:-1}"

case "$agent" in
  # cheap models: the run is a smoke test of onyx, not of the agents
  claude) models='{ "base": "sonnet", "varop": "sonnet", "worker": "sonnet", "ghost": "haiku" }' ;;
  *) models='{}' ;;
esac

rm -rf "$dir/remote.git" "$dir/smoke"
git init --quiet --bare --initial-branch=main "$dir/remote.git"
git init --quiet --initial-branch=main "$dir/smoke"
cp -r "$here/repo/." "$dir/smoke/"
cat > "$dir/smoke/onyx/research.json" <<JSON
{
  "name": "smoke-$agent-$(date -u +%Y%m%d-%H%M)",
  "goal": "Make count_primes in solver.py as fast as possible, measured as smoke.speedup on the bench, while staying right on every known count (smoke.valid_fraction 1).",
  "remote": "../remote.git",
  "baseBranch": "main",
  "editable": ["solver.py"],
  "metrics": [
    { "key": "smoke.speedup", "better": "higher", "label": "Speedup" },
    { "key": "smoke.valid_fraction", "better": "higher", "label": "Valid fraction" }
  ],
  "endpoints": [
    {
      "type": "smoke.bench",
      "label": "count_primes timed against trial division at n = 60,000",
      "guide": "onyx/endpoints/bench.md",
      "driver": "python3 onyx/endpoints/bench.py",
      "capacity": 1,
      "timeoutS": 60
    }
  ],
  "agent": "$agent",
  "models": $models,
  "workers": $workers,
  "experimentsPerTask": 2,
  "minutes": $minutes
}
JSON
printf '.onyx-research/\n__pycache__/\n' > "$dir/smoke/.gitignore"
cd "$dir/smoke"
git add -A
git -c user.name=onyx -c user.email=onyx@local commit --quiet -m "smoke: a slow count_primes"
git remote add origin "$dir/remote.git"
git push --quiet origin main
echo "$dir/smoke/onyx/research.json"
