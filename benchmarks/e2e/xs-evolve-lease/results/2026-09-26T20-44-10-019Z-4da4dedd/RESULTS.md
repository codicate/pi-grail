# Successful live E2E demo

Both production-Pi arms completed the same fixture and passed the deterministic checker. The
worker patch selected 20 seconds in both arms. This is a functional demo, not a claim of broad E2E
performance: no visible signal was flagged in either arm, so no reviewer was needed in this case.

| Metric | Jev | Generic subagent gate |
| --- | ---: | ---: |
| Checker | `OK` | `OK` |
| Successful worker responses | 7 | 6 |
| Gate checkpoints | 12 | 11 |
| Gate flags | 0 | 0 |
| Reviewer calls | 0 | 0 |
| Pi process wall time | 20.18 s | 83.43 s |
| Arm wall time | 20.42 s | 83.65 s |
| Estimated cost | $0.02698182 | $0.03363450 |

The pair took 104.08 seconds total. The estimates are derived from reported token usage and are not
invoice data. Cost is now telemetry only: the live runner does not reserve spend or stop because of a
local budget. OpenRouter is allowed to choose fallback routes under the existing account/key; no new
provider or credential was added.

The earlier failed run remains preserved separately. This run demonstrates that the rate-limit issue
was not a deterministic Pi or payload failure after routing fallback was enabled. It does not exercise
the reviewer-feedback path; the existing child smoke test covers that wiring.
