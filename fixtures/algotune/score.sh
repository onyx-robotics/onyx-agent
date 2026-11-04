#!/usr/bin/env bash
# Scores commits on the held-out split: an AlgoTune task's 100 test instances, 10 timed runs each,
# which neither a run nor the greedy baseline ever sees. One commit at a time, never in parallel.
#
#   bash fixtures/algotune/score.sh <remote> <task> <label>=<commit> ...
#
# Needs the same environment as the endpoint (ALGOTUNE_*); prints one METRICS line per commit.
set -euo pipefail
remote="$1"
task="$2"
shift 2
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone --quiet --mirror "$remote" "$work/mirror.git"
for pair in "$@"; do
  label="${pair%%=*}"
  commit="${pair#*=}"
  rm -rf "$work/co"
  git clone --quiet "$work/mirror.git" "$work/co"
  git -C "$work/co" checkout --quiet --detach "$commit"
  echo "== $label ($commit)"
  (cd "$work/co" && python onyx/endpoints/bench.py --task "$task" --subset test --runs 10 | grep -E "subset|^mean|^METRICS") || true
done
