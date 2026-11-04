# AlgoTune bench

Scores `solver.py` on this repository's AlgoTune task (TASK.md): the 100 train instances, each timed twice in a fresh process, single-threaded, against the reference `solve` timed the same way.

- **Packet:** the commit itself. The endpoint runs the driver (`onyx/research.json`, the endpoint's `driver`) in a checkout of your commit.
- **Measures:** `algotune.speedup` (mean of reference time / your time, higher is better; invalid on any instance means no speedup), `algotune.peak_mem_mb`, `algotune.code_lines`, `algotune.valid_fraction`.
- **Log:** validity per instance, the first failures with tracebacks, and per-instance solver/reference milliseconds. Anything your solver prints during the timed runs is not shown; print diagnostics from the quick evaluation instead.
- **Time:** about half a minute: the instances run in parallel shards, each timed alone in its own process, with the reference timed beside them under the same load. Experiments queue for the bench, so don't send one you haven't checked with the quick evaluation.
- **Rules:** `Solver().solve(problem)` must return what the task's `is_solution` accepts, for every instance. AlgoTune's tamper checks run on every file.
