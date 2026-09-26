# Type-1 POC checkpoint — baseline-v1

The user stopped further tuning to move to E2E. No candidate was evaluated or
promoted, and the three held-back cases remain unopened. These are two serial,
interleaved passes over the same 12 development cases, not 24 distinct cases.

| Metric, pooled across both passes | Jev | Generic DeepSeek gate |
| --- | ---: | ---: |
| Correct investigate/skip decisions | 21/24 (87.5%) | 22/24 (91.7%) |
| Missed investigations | 0 | 0 |
| Unnecessary investigations | 3 | 2 |
| Correct per-signal statuses | 50/72 (69.4%) | 58/72 (80.6%) |
| Median gate latency | 197 ms | 4,834 ms |
| Mean gate latency | 204 ms | 5,514 ms |
| Mean estimated gate cost | $0.00005130 | $0.00098498 |
| Gate failures / reviewer calls | 0 / 0 | 0 / 0 |

Pass 1 decision correctness was 10/12 versus 11/12; pass 2 was 11/12 for both.
Jev was about 24.5× faster by pooled median and 19.2× cheaper on the recorded
cost-estimation basis. **Cost figures are estimates, not invoices:** Jev uses
its listed rate; the control uses the configured route-price ceiling without
cache discounts. That conservative control estimate can exceed actual billing.

The original accuracy-match goal is not established across both passes: Jev
made one additional false alarm overall. There is no held-out or E2E success
claim here. The retained runtime version is the original `baseline-v1` prompt.

## Evidence and accounting

- [Pass 1](results/2026-09-26T20-23-38-984Z-baseline-1-dbe2c91b/metrics.json)
- [Pass 2](results/2026-09-26T20-25-01-857Z-baseline-2-01e902a4/metrics.json)
- [Label resolution before baseline](LABEL_RESOLUTION.md)
- [Shared spend ledger](state/spend-ledger.json)

Each run retains its case/label/prompt snapshots, per-case JSONL, production-Pi
trace, hashes, cache provenance, metrics and ledger snapshot. Both arms used
identical prepared packets. Worker/main inference and reviewer usage were zero
in Type 1. Parent startup is measured separately from timed gates.

At the end of Type 1, $0.088795282 was accounted against the shared $10 budget:
$0.024870588 in estimated gate charges, $0.010588894 in reported validation
charges, and $0.053335800 retained for three unknown-cost failed attempts.
The first successful validation chunk was reused without another paid call.

Native control reasoning counts are retained in the per-case top-level
`reasoningTokens` field: 24 known calls, 12,028 reasoning tokens already included
in output. The original aggregate DTO-only usage bucket says unknown because
pi-subagents omits this field; do not use that bucket to infer no reasoning.
Historical validation part 1 has an inconsistent provider reasoning counter;
new normalization flags such values and records null rather than zero.

Production Pi/local fixture checks passed: typecheck, 13 unit checks, selector
parity/zero-reviewer checks, and worker thinking/action capture, deduplication,
role exclusion, bounded reviewer use, feedback delivery and blocked-write smoke.
