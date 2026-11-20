def count_primes(n: int) -> int:
    """How many primes are below n."""
    count = 0
    for k in range(2, n):
        if all(k % d for d in range(2, int(k**0.5) + 1)):
            count += 1
    return count
