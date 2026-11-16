#!/usr/bin/env bash
# Makes an AlgoTune test project: a git remote (bare) and a working clone with solver.py (the
# task's reference solve), the bench endpoint's driver and guide, and onyx/research.json.
#
#   bash fixtures/algotune/setup.sh <dir> <task> [minutes] [workers] [bench slots]
#
# Needs ALGOTUNE_ROOT and ALGOTUNE_PYTHON (Linux; WSL is fine).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$(mkdir -p "$1" && cd "$1" && pwd)"
task="$2"
minutes="${3:-15}"
workers="${4:-2}"
slots="${5:-1}"
: "${ALGOTUNE_ROOT:?set ALGOTUNE_ROOT to the AlgoTune source}"
py="${ALGOTUNE_PYTHON:-python3}"

rm -rf "$dir/remote.git" "$dir/$task"
git init --quiet --bare --initial-branch=main "$dir/remote.git"
git init --quiet --initial-branch=main "$dir/$task"
cp -r "$here/repo/." "$dir/$task/"
"$py" "$here/make_solver.py" "$ALGOTUNE_ROOT" "$task" > "$dir/$task/solver.py"
# the reference, timed beside each experiment (not editable: only solver.py is)
cp "$dir/$task/solver.py" "$dir/$task/onyx/endpoints/reference_solver.py"
cp "$ALGOTUNE_ROOT/AlgoTuneTasks/$task/description.txt" "$dir/$task/TASK.md"
cat > "$dir/$task/onyx/research.json" <<JSON
{
  "name": "$task-$(date +%Y%m%d-%H%M)",
  "goal": "Make solver.py solve AlgoTune's $task task (TASK.md) as fast as possible, measured as AlgoTune's mean speedup over the reference solve, while staying valid on every instance. Less peak memory and fewer lines are secondary.",
  "remote": "../remote.git",
  "baseBranch": "main",
  "editable": ["solver.py"],
  "evaluate": "python onyx/endpoints/bench.py --task $task --samples 8 --runs 1",
  "metrics": [
    { "key": "algotune.speedup", "better": "higher", "label": "Speedup" },
    { "key": "algotune.peak_mem_mb", "better": "lower", "label": "Peak memory", "unit": "MB" },
    { "key": "algotune.code_lines", "better": "lower", "label": "Code lines" },
    { "key": "algotune.valid_fraction", "better": "higher", "label": "Valid fraction" }
  ],
  "endpoints": [
    {
      "type": "algotune.bench",
      "label": "AlgoTune $task, 100 train instances, timed against the reference",
      "guide": "onyx/endpoints/bench.md",
      "driver": "python onyx/endpoints/bench.py --task $task",
      "capacity": $slots,
      "timeoutS": 1800
    }
  ],
  "models": { "base": "sonnet", "varop": "sonnet", "worker": "sonnet", "ghost": "haiku" },
  "workers": $workers,
  "experimentsPerTask": 3,
  "minutes": $minutes
}
JSON
printf '.onyx-research/\n__pycache__/\n' > "$dir/$task/.gitignore"
cd "$dir/$task"
git add -A
git -c user.name=onyx -c user.email=onyx@local commit --quiet -m "$task: AlgoTune's reference solve"
git remote add origin "$dir/remote.git"
git push --quiet origin main
echo "$dir/$task/onyx/research.json"
