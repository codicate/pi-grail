# First live E2E attempt: blocked by upstream rate limits

Both arms ran once, serially, with identical initial fixture hashes and DeepSeek V4.1 Flash at low thinking. Neither produced a patch; both checkers returned `NO_HEARTBEAT`. This is not a valid completed-task performance comparison.

| Observed result | Jev | Generic subagent gate |
| --- | --- | --- |
| Successful worker responses | 3 | 0 |
| Failed worker requests | 1 | 1 |
| Gate checkpoints | 6 | 0 |
| Flagged checkpoints | 2 (evidence leap, same response) | 0 |
| Reviewer requests | 1, failed | 0 |
| Arm wall time | 24.98 s | 2.02 s |
| Final checker | NO_HEARTBEAT | NO_HEARTBEAT |
| Total cost | unknown | unknown |

Native child traces identify HTTP 429 from Modal via OpenRouter, with `limit_source=upstream_provider_shared_pool`. The reviewer failed with the same rate limit. Jev flags demonstrate live gate routing and a reviewer launch, not a verified task error or successful review. No retries or provider switches were performed.

The original control record incorrectly interpreted a failed response's all-zero usage as a known $0 charge. `accounting-correction.json` supersedes that cost interpretation, preserves the original evidence, and restores its $4 reservation. The runner now treats such usage as unknown. The recorded partial Jev-arm estimate is $0.006878256; it excludes unknown failed-call charges and is not a total.

The shared ledger holds $8.088795282 in estimates plus reservations after correction; this is **not actual money spent**. Before another paired run, reconcile unknown failed-call charges/reservations and address the upstream availability issue. Type-1 tuning remains stopped at baseline-v1; held-back cases remain unevaluated.
