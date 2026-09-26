# Live Grail demo: evolving lease interval

This is a small two-arm production-Pi demo, not a benchmark suite. It runs the same task, source
tree, and archival memory files in fresh `jev` and `subagent` worker sessions. The only intended
arm difference is the selector. Worker and reviewer use the same OpenRouter DeepSeek V4.1 Flash
target at `low` thinking, with the shared max-price policy and provider fallback disabled. The
runner applies a five-minute outer process timeout per arm; this is not a verified end-to-end
upper bound if provider cancellation or reviewer shutdown is delayed. Before launching, it reserves
$4 per arm atomically from the shared spend ledger ($8 for the pair), preserving the existing $0.20
reserve. This is a conservative reservation, not a proof of a strict maximum. The runner requires an
explicit `--run-live` flag because invoking it makes model calls.

## What the source actually says

The fixture adapts [`xs-evolve-lease`](https://github.com/GiulioDER/agent-memory-bench/tree/ee23ad22026ab63213c2282949cd5b9b6097664b/tasks/xs-evolve-lease)
from commit `ee23ad22026ab63213c2282949cd5b9b6097664b` of `GiulioDER/agent-memory-bench` (Apache-2.0;
the upstream license is retained in `UPSTREAM-LICENSE.txt`). Project files and the three source
session transcripts are copied unchanged. The transcript SHA-256 values are recorded in
`fixture-manifest.json`.

The dated user followups move the proposed interval from 90 seconds (2026-04-12), to 45 seconds
(2026-06-02), to 20 seconds (2026-07-21, explicitly “final”). The July assistant analysis just
before that final user followup recommends 30 seconds, so the fixture intentionally preserves the
assistant/user disagreement instead of trusting an AI summary. The task does not name an interval;
it points the worker to the identical local records in each arm.

The upstream deterministic checker is also preserved. Its driver spends no wall-clock time: it
uses a fake `sleep`, asks for twelve renewal cycles, and accepts only at least eleven renewals of
the same lease with a constant 20-second interval. It distinguishes stale 90- and 45-second
implementations. This verifies the requested callback contract only. It does not test a real broker,
threading, a blocked handler, or lease survival under the recorded 133-second maximum handler time;
the demo makes no operational safety claim from this checker.

## What gets recorded

For each fresh run the runner saves the Pi JSON event stream, worker result, live checkpoint
decisions and references, selector/reviewer/worker usage that Pi exposes, usage-based conservative
DeepSeek and Jev cost estimates where token counts are available, the final `worker.py` patch,
input-file hashes before/after, and the deterministic checker verdict. Each arm records Pi process
wall time separately from arm wall time (including fixture copy and checker); the pair summary also
records total wall time. Missing usage is `null`/unknown, never `$0`, and unknown-cost call counts are
reported. These estimates are not an invoice or billed-cost measurement. The raw
checkpoint references also make visible that the live classifier receives the handoff, explicitly
authorized updates, and the worker checkpoint text; merely read archival memory is not automatically
added as a classifier-visible update.

Memory files live under each disposable run directory. Pi filesystem tools are not treated as a
sandbox; the runner hashes these files after the worker exits and records any change. The checker is
run only after Pi has exited, from a separate temporary directory populated with the final
`worker.py` and `lease.py` copies.

## Run (paid)

After reviewing the task, model route, credentials, and shared-ledger balance, run from the repository
root:

```sh
npx tsx scripts/benchmark-e2e.ts --run-live
```

The runner has no extra arms or cases: it performs exactly one fresh `jev` run and one fresh
`subagent` run, sequentially. It uses the installed production Pi CLI and pi-subagents; it does not
copy or adopt the upstream project's Claude Code runner. The ledger reservation IDs and snapshots
are saved with the run artifacts. Known usage estimates settle each arm's reservation; unknown costs
leave the reservation open. A zero-request first arm stops the pair without an automatic retry.
