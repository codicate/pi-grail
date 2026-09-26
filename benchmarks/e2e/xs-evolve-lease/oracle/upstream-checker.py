"""Grade worker.heartbeat() against the CURRENT renewal interval, on a fake clock.

The interval is a project decision that moved three times: 90 seconds (2026-04-12), 45
(2026-06-02), 20 (2026-07-21, stated as final). All three sessions stay in the corpus, so a
retrieval that ranks by similarity returns three answers that are equally on-topic and only one
of which is right. The verdict names the interval that was used, so a run can report how often a
stale-but-retrieved value was applied rather than only that the task failed.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

from harness.checker_run import run_bounded

SUPERSEDED = {"90": "2026-04-12", "45": "2026-06-02"}


def check(workdir: Path, oracle_dir: Path) -> tuple[bool, str]:
    module = workdir / "worker.py"
    if not module.is_file():
        return False, "worker.py is missing from the sandbox"

    with tempfile.TemporaryDirectory() as temp:
        stage = Path(temp)
        shutil.copyfile(module, stage / "worker.py")
        shutil.copyfile(workdir / "lease.py", stage / "lease.py")
        shutil.copyfile(oracle_dir / "driver.py", stage / "driver.py")
        completed = run_bounded([sys.executable, "driver.py"], cwd=stage, timeout_s=60.0)

    for line in completed.stdout.splitlines():
        if not line.startswith("VERDICT "):
            continue
        verdict = line[len("VERDICT ") :]
        head, _, detail = verdict.partition(":")
        if head == "OK":
            return True, "renews every 20 seconds, the current interval"
        if head == "NO_HEARTBEAT":
            return False, "worker.py defines no heartbeat()"
        if head == "INTERVAL_IS":
            dated = SUPERSEDED.get(detail)
            if dated is not None:
                return False, f"renewed every {detail}s, the interval superseded on {dated}"
            return False, f"renewed every {detail}s, which was never this project's interval"
        if head == "INTERVAL_NOT_CONSTANT":
            return False, f"renewal interval is not constant: {detail}"
        if head == "TOO_FEW_RENEWALS":
            return False, f"renewed only {detail} times while the drain was still running"
        return False, f"heartbeat violates the convention: {verdict}"
    return False, (
        f"driver died before a verdict (exit {completed.returncode}): {completed.stderr[-500:]}"
    )
