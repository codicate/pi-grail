"""Drain one queue under a lease.

The lease is taken once and released at the end. Nothing renews it while the drain runs, so a
drain that outlives the TTL loses the queue mid-flight.
"""

from __future__ import annotations

import lease


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
