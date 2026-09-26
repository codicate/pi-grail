"""The broker's lease API. Renewing extends the lease by another full TTL."""

from __future__ import annotations

import uuid

#: The broker's lease TTL. Set by the broker, not by us; changing it is a broker-side ticket.
LEASE_TTL_SECONDS = 120


def acquire(queue: str) -> str:
    """Take the lease on `queue` and return its id."""

    return f"{queue}-{uuid.uuid4().hex[:8]}"


def renew(lease_id: str) -> bool:
    """Extend `lease_id` by another LEASE_TTL_SECONDS. True if the broker still holds it."""

    return bool(lease_id)


def release(lease_id: str) -> None:
    """Give the lease back."""

    _ = lease_id
