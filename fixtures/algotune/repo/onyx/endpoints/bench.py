"""The AlgoTune bench endpoint's driver: scores this checkout's solver.py with AlgoTune's own harness.

    python onyx/endpoints/bench.py --task <task> [--subset train|test] [--samples N] [--runs N] [--shards N]

Prints AlgoTune's diagnostics, then a last line `METRICS {json}`. Needs ALGOTUNE_ROOT (the AlgoTune
source), ALGOTUNE_DATA (its data) and ALGOTUNE_HARNESS (algotune_worker.py); ALGOTUNE_PYTHON is
the interpreter with AlgoTune's dependencies. Reference timings are cached per ALGOTUNE_SESSION,
so every experiment of a run is timed against the same reference.

AlgoTune times each instance alone, in fresh single-threaded processes, so most of a run is
starting them: about 1.5 s an instance whatever the solver. The instances are split into shards
that run side by side (each instance is still timed alone in its own process), and the shards'
results merged exactly: the mean speedup over every instance, valid only if every one is.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor


def code_lines(src: str) -> int:
    return sum(1 for line in src.splitlines() if line.strip() and not line.strip().startswith("#"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--subset", default="train", choices=["train", "test"])
    ap.add_argument("--samples", type=int, default=100)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--shards", type=int, default=int(os.environ.get("ALGOTUNE_SHARDS", "4")))
    a = ap.parse_args()
    env = os.environ
    root, data, harness = env["ALGOTUNE_ROOT"], env["ALGOTUNE_DATA"], env["ALGOTUNE_HARNESS"]
    py = env.get("ALGOTUNE_PYTHON", sys.executable)
    session = env.get("ALGOTUNE_SESSION", time.strftime("onyx-%Y%m%d"))
    src = open("solver.py", encoding="utf-8").read()
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="algotune_bench_") as d:
        shutil.copy("solver.py", os.path.join(d, "solver.py"))
        base = [py, harness, "--root", root, "--task", a.task, "--solver-dir", d, "--data-dir", data,
                "--subset", a.subset, "--runs", str(a.runs), "--session", session]

        def run(extra):
            p = subprocess.run(base + extra, capture_output=True, text=True, timeout=3600,
                               env={**env, "PYTHONUNBUFFERED": "1"})
            line = next((ln for ln in reversed(p.stdout.splitlines()) if ln.startswith("RESULT:")), None)
            if line is None:
                return {"valid": False, "error": f"the harness crashed (exit {p.returncode}): {p.stderr[-3000:]}"}
            return json.loads(line[len("RESULT:"):])

        # the reference, timed once for the session, before shards could each start timing it
        warm = run(["--warm"])
        if warm.get("error"):
            print(f"error: {warm['error']}")
            print("METRICS " + json.dumps({"algotune.code_lines": float(code_lines(src)),
                                           "algotune.valid_fraction": 0.0}))
            return 1
        n = a.samples
        k = max(1, min(a.shards, n))
        bounds = [(i * n // k, (i + 1) * n // k) for i in range(k)]
        # The reference is timed again beside the candidate, shard for shard, under the same load:
        # a reference timed alone and a candidate timed among shards read 20% apart for the same
        # code. Without a reference solver here, the session's cached timings are used instead.
        ref = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference_solver.py")
        paired = os.path.exists(ref)
        rd = os.path.join(d, "reference")
        if paired:
            os.makedirs(rd)
            shutil.copy(ref, os.path.join(rd, "solver.py"))

        def shard(job):
            i, (lo, hi), solver_dir = job
            cmd = ["--offset", str(lo), "--max-samples", str(hi - lo),
                   "--mem-samples", "2" if i == 0 and solver_dir == d else "0"]
            if solver_dir != d:
                cmd += ["--solver-dir", solver_dir]
            return run(cmd)

        jobs = [(i, b, d) for i, b in enumerate(bounds)] + ([(i, b, rd) for i, b in enumerate(bounds)] if paired else [])
        with ThreadPoolExecutor(len(jobs)) as pool:
            done = list(pool.map(shard, jobs))
        parts, refs = done[:k], done[k:]

    evaluated = sum(p.get("num_evaluated") or 0 for p in parts)
    ok = sum(p.get("num_valid") or 0 for p in parts)
    valid = all(p.get("valid") for p in parts) and evaluated == n
    speedup = None
    if valid and paired:
        ratios = [r / s for p, q in zip(parts, refs)
                  for s, r in zip(p.get("solver_ms") or [], q.get("solver_ms") or []) if s and r]
        speedup = sum(ratios) / len(ratios) if len(ratios) == evaluated else None
    elif valid and all(p.get("mean_speedup") for p in parts):
        speedup = sum(p["mean_speedup"] * p["num_evaluated"] for p in parts) / evaluated
    peak = parts[0].get("peak_mem_mb")
    print(f"{a.task}, subset {a.subset}: {ok}/{evaluated} instances valid; {time.time() - t0:.0f} s "
          f"({k} shards side by side)")
    if speedup:
        print(f"mean speedup {speedup:.3f}x; peak memory {peak} MB")
    for p in parts:
        for e in (p.get("errors") or [])[:2]:
            print(f"error: {e}")
        if p.get("error"):
            print(f"error: {p['error']}")
        if p.get("traceback"):
            print(p["traceback"][-2000:])
    sm = [x for p in parts for x in (p.get("solver_ms") or [])]
    om = [x for p in (refs if paired else parts) for x in (p.get("solver_ms" if paired else "oracle_ms") or [])]
    if sm:
        pairs = ", ".join(f"{s:.2f}/{o:.2f}" for s, o in list(zip(sm, om))[:12] if s is not None and o is not None)
        print(f"per instance solver/reference ms (first 12): {pairs}")
    metrics = {"algotune.code_lines": float(code_lines(src)),
               "algotune.valid_fraction": ok / evaluated if evaluated else 0.0}
    if speedup:
        metrics["algotune.speedup"] = float(speedup)
        if peak:
            metrics["algotune.peak_mem_mb"] = float(peak)
    print("METRICS " + json.dumps(metrics))
    return 0 if valid else 1


if __name__ == "__main__":
    sys.exit(main())
