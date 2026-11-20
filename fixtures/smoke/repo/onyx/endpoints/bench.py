"""
The smoke bench: times solver.count_primes against a fixed trial-division reference, after checking
it on known counts. Standard library only. Prints its log, then a last line `METRICS {json}`.

    python3 onyx/endpoints/bench.py
"""

import json
import os
import sys
import time

sys.path.insert(0, os.getcwd())

KNOWN = {0: 0, 2: 0, 3: 1, 10: 4, 100: 25, 1000: 168, 7919: 999, 7920: 1000, 20000: 2262}
N = 60_000
EXPECTED = 6057


def reference(n: int) -> int:
    count = 0
    for k in range(2, n):
        if all(k % d for d in range(2, int(k**0.5) + 1)):
            count += 1
    return count


def best_of(fn, n: int, runs: int = 3) -> float:
    best = float("inf")
    for _ in range(runs):
        t = time.perf_counter()
        fn(n)
        best = min(best, time.perf_counter() - t)
    return best


def main() -> int:
    try:
        from solver import count_primes
    except Exception as e:
        print(f"solver.py doesn't import: {e!r}")
        print("METRICS " + json.dumps({"smoke.valid_fraction": 0.0}))
        return 1

    checks = {**KNOWN, N: EXPECTED}
    valid = 0
    for n, want in checks.items():
        try:
            got = count_primes(n)
        except Exception as e:
            print(f"count_primes({n}) raised {e!r}")
            continue
        if got == want:
            valid += 1
        else:
            print(f"count_primes({n}) = {got}, want {want}")
    fraction = valid / len(checks)
    print(f"valid on {valid} of {len(checks)} known counts")
    if fraction < 1:
        print("METRICS " + json.dumps({"smoke.valid_fraction": fraction, "smoke.speedup": 0.0}))
        return 0

    ref = best_of(reference, N)
    mine = best_of(count_primes, N)
    speedup = ref / max(mine, 1e-9)
    print(f"reference {ref * 1000:.1f} ms, solver {mine * 1000:.3f} ms, speedup {speedup:.2f}x")
    print("METRICS " + json.dumps({"smoke.valid_fraction": 1.0, "smoke.speedup": speedup}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
