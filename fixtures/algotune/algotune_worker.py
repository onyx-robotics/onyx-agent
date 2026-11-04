"""Score one AlgoTune solver directory exactly as AlgoTune does. Linux/WSL only.

Runs inside AlgoTune's environment, in its own process:
    python algotune_worker.py --root <AlgoTune> --task svm --solver-dir <dir>
        --data-dir <dir> --subset train|test --runs N [--max-samples K]
Prints one JSON line prefixed with RESULT: on stdout.
"""

import argparse
import json
import os
import sys
import time
import traceback


def _first(row, *keys):
    for k in keys:
        v = row.get(k)
        if v is not None:
            return v
    return None


def _failures(rows, limit=3):
    """Why instances failed: execution errors and is_solution rejections (with code context)."""
    out = []
    for r in rows:
        if r.get("is_valid"):
            continue
        parts = [f"problem {r.get('problem_id')}:"]
        if r.get("timeout_occurred"):
            parts.append("timed out")
        if r.get("error"):
            parts.append(f"{r.get('error_type', 'error')}: {r['error']}")
            if r.get("traceback"):
                parts.append(str(r["traceback"])[-800:])
        v = r.get("validation_result") or {}
        if v and not v.get("success"):
            parts.append(f"rejected by is_solution ({v.get('error_type')}): {v.get('error')}")
        if r.get("code_context"):
            parts.append(str(r["code_context"])[:800])
        out.append(" ".join(parts)[:1500])
        if len(out) >= limit:
            break
    return out


_PROBE = r"""
import importlib.util, pickle, sys
d, f = sys.argv[1], sys.argv[2]
sys.path.insert(0, d)
spec = importlib.util.spec_from_file_location("solver", d + "/solver.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with open(f, "rb") as fh:
    problem = pickle.load(fh)
m.Solver().solve(problem)
"""


def peak_memory_mb(solver_dir: str, problems: list, timeout_s: float = 120.0) -> float | None:
    """Peak resident memory (MB) of a fresh process that imports the solver and solves one
    instance, maxed over `problems`. Run after timing, never during it; same single-thread
    environment as AlgoTune's timed workers."""
    import pickle
    import subprocess
    import tempfile

    env = {**os.environ, **{v: "1" for v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                                              "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS")}}
    peak = None
    for prob in problems:
        with tempfile.NamedTemporaryFile(suffix=".pkl", delete=False) as fh:
            pickle.dump(prob, fh)
        try:
            p = subprocess.Popen([sys.executable, "-c", _PROBE, solver_dir, fh.name], env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            t0 = time.time()
            while True:
                pid, status, ru = os.wait4(p.pid, os.WNOHANG)
                if pid:
                    break
                if time.time() - t0 > timeout_s:
                    p.kill()
                    pid, status, ru = os.wait4(p.pid, 0)
                    break
                time.sleep(0.02)
            if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0:
                mb = ru.ru_maxrss / 1024.0  # Linux reports KB
                peak = mb if peak is None else max(peak, mb)
        finally:
            os.unlink(fh.name)
    return peak


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--solver-dir", required=True)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--subset", default="train", choices=["train", "test"])
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--max-samples", type=int, default=None)
    ap.add_argument("--offset", type=int, default=0, help="skip this many instances first (a shard's start)")
    ap.add_argument("--warm", action="store_true",
                    help="only time the reference (cached for the session), then exit: before shards run")
    ap.add_argument("--mem-samples", type=int, default=5, help="instances re-run to measure peak memory")
    ap.add_argument("--session", default="adhoc",
                    help="reference timings are cached per session only: timings from another sitting drift")
    ap.add_argument("--dump-problems", type=int, default=0, help="write the first N train problems as pickles")
    ap.add_argument("--dump-dir", default=None)
    a = ap.parse_args()

    sys.path.insert(0, a.root)
    # AGENT_MODE=1 makes the executor time the candidate, not task.solve.
    os.environ.update(AGENT_MODE="1", ISOLATED_EVAL="1", CODE_DIR=os.path.abspath(a.solver_dir),
                      DATA_DIR=os.path.abspath(a.data_dir))
    # Use the official HF instances (comparable with published AlgoTune numbers). Lazy mode's
    # pattern "data/<task>/**/*.jsonl" matches nothing with huggingface_hub 0.32, so force full mode.
    os.environ.pop("ALGOTUNE_HF_LAZY", None)
    os.environ.setdefault("ALGOTUNE_HF_CACHE_DIR", os.path.join(os.path.abspath(a.data_dir), "_hf"))
    import multiprocessing as mp

    mp.set_start_method("forkserver", force=True)
    from AlgoTuneTasks.factory import TaskFactory
    from AlgoTuner.utils.evaluator.baseline_manager import BaselineManager
    from AlgoTuner.utils.evaluator.main import _calculate_aggregate_metrics, evaluate_code_on_dataset

    t0 = time.time()
    out = {"task": a.task, "subset": a.subset}
    # Rules are checked here, not stated to agents: AlgoTune's own tamper validator on every file.
    from AlgoTuner.security.code_validator import check_code_for_tampering, check_protected_filename
    if not a.dump_problems:
        for path in sorted(os.listdir(a.solver_dir)):
            if path.endswith(".py"):
                with open(os.path.join(a.solver_dir, path), encoding="utf-8") as fh:
                    msg = check_protected_filename(path) or check_code_for_tampering(fh.read(), path)
                if msg:
                    out.update(valid=False, error=f"rejected by AlgoTune's code validator ({path}): {msg}",
                               seconds=time.time() - t0)
                    print("RESULT:" + json.dumps(out, default=float), flush=True)
                    return
    try:
        task = TaskFactory(a.task, oracle_time_limit=100, data_dir=a.data_dir)
        train_it, test_it = task.load_dataset(train_size=100, test_size=100)
        if a.dump_problems:
            import pickle
            os.makedirs(a.dump_dir, exist_ok=True)
            for i, d in enumerate(list(train_it)[: a.dump_problems]):
                with open(os.path.join(a.dump_dir, f"{i}.pkl"), "wb") as fh:
                    pickle.dump(d["problem"] if isinstance(d, dict) and "problem" in d else d, fh)
            print("RESULT:" + json.dumps({"dumped": a.dump_problems}), flush=True)
            return
        data = list(train_it if a.subset == "train" else test_it)
        whole = len(data)
        data = data[a.offset: a.offset + a.max_samples if a.max_samples else None]
        bm = BaselineManager(task)
        # AlgoTuner times the reference once per agent session and keeps it in memory; each worker
        # is a new process, so persist it per (session, task, split) to match that. Never reuse
        # across sessions: on a laptop the same code timed 0.9x one day and 1.8x the next.
        # The whole split is timed, so one file serves official evaluations and worker probes alike.
        cache = os.path.join(os.path.abspath(a.data_dir), "_baselines", a.session, f"{a.task}_{a.subset}.json")
        # Stored as [key, ms] pairs: the evaluator looks problems up by the exact key type
        # (a JSON object would turn integer ids into strings and every lookup would miss).
        bt = None
        if os.path.exists(cache):
            with open(cache) as f:
                bt = {k: v for k, v in json.load(f)}
            if len(bt) < whole:
                bt = None  # incomplete: re-time
            else:
                bm._cache[a.subset] = bt
        if bt is None:
            bt = bm.get_baseline_times(subset=a.subset, max_samples=None)
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            with open(f"{cache}.{os.getpid()}", "w") as f:
                json.dump(list(bt.items()), f)
            os.replace(f"{cache}.{os.getpid()}", cache)
        if a.warm:
            out.update(warmed=len(bt), seconds=time.time() - t0)
            print("RESULT:" + json.dumps(out, default=float), flush=True)
            return
        res = evaluate_code_on_dataset(task_obj=task, dataset_iterable=data, baseline_times=bt,
                                       baseline_manager=bm, data_subset=a.subset,
                                       default_num_eval_runs=a.runs)
        if isinstance(res, dict):  # early abort: error report instead of per-instance list
            out.update(valid=False, error=str(res.get("error") or res)[:4000],
                       traceback=str(res.get("traceback") or "")[-4000:])
        else:
            rows = list(res)
            agg = _calculate_aggregate_metrics(rows)
            sp = agg.get("mean_speedup")
            out.update(valid=sp is not None, mean_speedup=sp, num_valid=agg.get("num_valid"),
                       num_evaluated=agg.get("num_evaluated"),
                       errors=_failures(rows),
                       solver_ms=[_first(r, "min_time_ms", "elapsed_ms", "solver_time_ms") for r in rows],
                       oracle_ms=[_first(r, "baseline_time_ms", "oracle_time_ms") for r in rows])
            if sp is not None and a.mem_samples:
                probes = [d["problem"] if isinstance(d, dict) and "problem" in d else d for d in data[:a.mem_samples]]
                out["peak_mem_mb"] = peak_memory_mb(os.path.abspath(a.solver_dir), probes)
    except Exception as e:  # noqa: BLE001 - every failure is a result for the loop
        out.update(valid=False, error=f"{type(e).__name__}: {e}", traceback=traceback.format_exc()[-4000:])
    out["seconds"] = time.time() - t0
    print("RESULT:" + json.dumps(out, default=float), flush=True)


if __name__ == "__main__":
    main()
