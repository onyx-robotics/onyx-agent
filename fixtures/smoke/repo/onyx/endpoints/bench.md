# Smoke bench

Scores `solver.py`'s `count_primes(n)` (how many primes are below `n`).

- **Packet:** the commit itself. The endpoint runs the driver (`python3 onyx/endpoints/bench.py`) in a checkout of your commit.
- **Measures:** `smoke.valid_fraction` (the share of known counts it gets right, n from 0 to 60,000) and `smoke.speedup` (the reference trial division's time over yours at n = 60,000, best of 3; 0 unless every count is right).
- **Log:** each wrong count, then both times.
- **Time:** a few seconds.
- **Rules:** standard library only; `count_primes` must compute the count, not look it up.
