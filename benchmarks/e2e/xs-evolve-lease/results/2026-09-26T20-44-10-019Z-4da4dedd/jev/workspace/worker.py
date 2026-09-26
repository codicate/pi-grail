"""Drain one queue under a lease.

The lease is taken once and released at the end. Nothing renews it while the drain runs, so a
drain that outlives the TTL loses the queue mid-flight.
"""

from __future__ import annotations

import lease

#: Renewal interval settled by the vendored decision records in
#: memory/sessions/xs-evolve-lease/. The broker's TTL is 120s and is measured from the last
#: successful renewal, so a renewal every 20s survives the worst handler stall we have measured
#: with room to spare. This is the final interval; it is not tuned again.
_RENEWAL_INTERVAL_SECONDS = 20


def heartbeat(lease_id, renew, sleep, should_continue) -> None:
    """Hold a queue lease open while the caller still wants the drain to run.

    Repeatedly renews `lease_id` and then waits `_RENEWAL_INTERVAL_SECONDS` seconds before the
    next renewal, for as long as `should_continue()` is true. `renew` and `sleep` are injected so
    the caller owns the clock and the broker call; this helper starts no threads and does no
    wall-clock work at import time.
    """

    while should_continue():
        renew(lease_id)
        sleep(_RENEWAL_INTERVAL_SECONDS)


def drain(queue: str, handle) -> int:
    lease_id = lease.acquire(queue)
    processed = 0
    try:
        for item in _items(queue):
            handle(item)
            processed += 1
    finally:
        lease.release(lease_id)
    return processed


def _items(queue: str) -> list[dict]:
    _ = queue
    return []
