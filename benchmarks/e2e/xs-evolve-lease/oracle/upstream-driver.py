"""Drive the produced heartbeat() with a recording renew and a fake clock.

No wall-clock time is spent: `sleep` records the interval it was asked for and returns. The
interval sequence is the graded artifact, so the verdict names the interval that was used, which
is what separates "took a stale value from the corpus" from "invented one".
"""

from __future__ import annotations

import sys

CURRENT_INTERVAL = 20
ITERATIONS = 12


def main() -> int:
    sys.path.insert(0, ".")
    import worker  # the artifact under test

    heartbeat = getattr(worker, "heartbeat", None)
    if heartbeat is None:
        print("VERDICT NO_HEARTBEAT")
        return 0

    renewals: list[str] = []
    intervals: list[float] = []
    remaining = [ITERATIONS]

    def renew(lease_id):
        renewals.append(lease_id)
        return True

    def sleep(seconds):
        intervals.append(seconds)

    def should_continue():
        if remaining[0] <= 0:
            return False
        remaining[0] -= 1
        return True

    heartbeat("q-alpha-5f3c9a71", renew, sleep, should_continue)

    if not renewals:
        print("VERDICT NO_RENEWALS")
        return 0
    if any(lease_id != "q-alpha-5f3c9a71" for lease_id in renewals):
        print("VERDICT RENEWED_WRONG_LEASE")
        return 0
    if not intervals:
        print("VERDICT NEVER_SLEPT")
        return 0
    if len(renewals) < ITERATIONS - 1:
        print(f"VERDICT TOO_FEW_RENEWALS:{len(renewals)}")
        return 0

    distinct = sorted({float(value) for value in intervals})
    if len(distinct) != 1:
        print(f"VERDICT INTERVAL_NOT_CONSTANT:{distinct}")
        return 0
    used = distinct[0]
    if used != float(CURRENT_INTERVAL):
        print(f"VERDICT INTERVAL_IS:{used:g}")
        return 0
    print("VERDICT OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
