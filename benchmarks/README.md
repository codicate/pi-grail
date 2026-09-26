# Grail selector benchmark

This is the small selector-only synthetic benchmark from `PLAN.md`. It runs the Jev selector against the generic DeepSeek control through the production Pi extension; it does not run workers or reviewers. Calls are serial and paired on the same case packet. The user-authorized `$10.00` overall ledger reserves `$0.20` for final evaluation, reserves estimated maximum cost before dispatch, records failed attempts, and never retries a failed request automatically. This is not an additional $10 allowance for each benchmark phase.

## Commands

First validate and freeze development labels once:

```sh
npx tsx scripts/benchmark-labels.ts validate development
```

Validation never auto-freezes labels. Choose the successful attempt explicitly
(`--attempt 1`, `2`, or `3`); failed attempts remain immutable. If independent
labels disagree, review the differences, then correct the author labels or
explicitly document a reviewed resolution:

```sh
npx tsx scripts/benchmark-labels.ts freeze development --attempt 3 --accept-reviewed-disagreements --note "Brief reviewed resolution"
```

Do not continue after an error report: the API attempt is retained in the ledger and the validator will not repeat it automatically. Baselines require frozen development labels.

Run two interleaved baseline passes, once each:

```sh
npm run benchmark -- baseline --pass 1
npm run benchmark -- baseline --pass 2
```

Candidates use a JSON file with a unique `version`; only the specified Jev signal instructions or outcome criteria can change. For example:

```json
{
  "version": "candidate-01",
  "instructionsBySignal": {
    "instruction_drift": "Keep the fixed signal definition; distinguish a committed action from exploration."
  }
}
```

```sh
npm run benchmark -- candidate --prompt benchmarks/prompts/candidate-01.json
```

The control is frozen and reused from the exact baseline cache. The runner permits at most five unique candidates and refuses tuning after held-back validation starts.

After choosing the final candidate, select it to lock its prompt hash and open the held-back set. The first command intentionally stops if held-back labels are not yet frozen, but preserves that selection:

```sh
npm run benchmark -- final --prompt benchmarks/prompts/candidate-01.json
npx tsx scripts/benchmark-labels.ts validate heldback --final
```

Freeze the successful held-back attempt explicitly. Omit the disagreement flag
and note if labels agree; otherwise review and document the resolution:

```sh
npx tsx scripts/benchmark-labels.ts freeze heldback --attempt 1 --final --accept-reviewed-disagreements --note "Brief reviewed resolution"
```

Then run the same final command again. Held-back labels are accepted only when their validation report records the selected prompt version and hash.

## Routing, estimates, and saved results

The control requests `openrouter/deepseek/deepseek-v4.1-flash` at low effort. A pinned provider route returned HTTP 404 during the second recorded fixture-validation attempt, so the current policy in `src/runtime-policy.ts` lets OpenRouter choose an available route while setting `allow_fallbacks: false` and a maximum price of `$0.30/M` prompt and `$1.20/M` completion. The selector output cap is shared with that policy. Jev uses `jev-1.13.0`. Do not change routing or limits without invalidating control caches.

Pi's `pi-subagents` `usage.cost` is derived from its local model catalog, not a provider invoice, so it is retained only in the raw Pi trace and is not used as billed cost. Selector cost rows are labeled estimates from the checked maximum-price ceiling, not billed amounts. Reservations and estimates use `$0.30/M` input, `$1.20/M` output, and `$0.30/M` cached-read input; no cache discount is assumed because OpenRouter may choose different available routes. The direct OpenRouter fixture-validation call may record its provider-reported `usage.cost`; if that is unavailable, it is estimated. Unknown token usage/cost stays null, and an attempted call with unknown cost commits its reserved upper bound. Reasoning tokens are a subset of output tokens.

Each iteration is immutable under `benchmarks/results/<iteration-id>/`, including its manifest, packet and label snapshots, prompt contract, reservation plan, per-case JSONL, metrics, Pi batch trace, ledger snapshot, and tuning notes. Shared parent startup is reported separately from per-gate latency. Candidate metrics separate fresh gate calls from historical cached control rows. The cumulative validation ledger is reported separately from gate-row cost.

## Existing development validation attempt

The current workspace contains two failed development label-validation attempts. Attempt 1 used a 4,096-token output cap and returned exactly that many output tokens without parseable label JSON. The direct OpenRouter response reported `$0.0054918`; the original preflight reservation was `$0.0017848`, and the ledger records the higher reported amount. Attempt 2 returned HTTP 404 before usage was available; its unknown cost was conservatively charged at the `$0.0149601` reservation. Both attempts remain immutable audit records. The validation report has no independent labels, so development labels are not frozen and baselines cannot run until a successful, explicitly recorded label-validation attempt is resolved and frozen. No automatic retries occur. Do not delete the report or ledger entries to bypass the attempt guard.
