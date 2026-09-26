# Pi–Jev POC: Live Gates and Type-1 Benchmark Tuning

Approved implementation plan. Saved September 26, 2026. Implementation and benchmark execution remain pending.

## 1. Goal and boundaries

Implement signals 1–3, connect them to live worker checkpoints, and self-iterate on a small selector-only synthetic benchmark.

Success means Jev matches or exceeds the generic LLM gate’s decision correctness, without more missed investigations, while lowering average gate cost and median gate latency.

- Use released production Pi and installed pi-subagents; no forks.
- Keep the control basic; concentrate development and tuning effort on Jev.
- Implement live hooks, but do not run E2E benchmarks.
- No verify-everything/verify-nothing arms, Sol judging, or reviewer calls inside Type 1.
- Total paid-API budget: $1, including fixture validation and live smoke calls. Codex implementation-agent usage is separate.
- First execution step: save this plan as PLAN.md (completed by creating this file).

## 2. Implementation

### Three-signal gate

Implement these fixed semantic definitions:

1. Instruction drift: a committed action conflicts with the current objective or constraint.
2. Explicit unverified assumption: an acknowledged unresolved fact is followed by an action depending on it.
3. Evidence-to-conclusion leap: explicitly limited evidence supports a visibly overbroad conclusion.

Use signal-specific instructions initially, not a combined judgment:

- Jev: three independent Choice judgments in one request.
- Control: one fresh, tool-free subagent call returning the same three statuses.
- Preserve --grail-selector jev|subagent.
- Use jev-1.13.0 for reproducibility; generative runtime calls use openrouter/deepseek/deepseek-v4.1-flash, thinking low.

The common result contains per-signal statuses, overall status, investigate, raw references, and telemetry. Any FLAG means investigate; otherwise skip. Keep INSUFFICIENT_INPUT distinguishable in records, with no fallback or escalation.

Extract a selector-only operation and expose /grail classify <packet>. Existing review commands use that operation, then invoke the reviewer only when appropriate.

### Input and context

Both arms receive the same code-assembled context:

> Existing kickoff handoff + authorized instruction updates + current raw thinking/actions.

Reuse the handoff; perform only code-based removal of duplicate/protocol metadata. No new summaries or recurring LLM compaction. Preserve essential instructions and raw source references.

For this POC, retain the existing conservative 16k UTF-8-byte packet limit, explicitly documented as an application limit—not Jev’s token limit. If essential content cannot fit, return insufficient and skip; never silently truncate it.

### Live worker integration

Add an explicit grail_worker launch tool backed by pi-subagents and a monitored worker persona. This is the POC’s supported path; existing arbitrary/background workers are not silently claimed as covered.

Attach a child extension to that persona. Use a small launch envelope carrying parent/worker identity and raw task text; remove transport metadata before model consumption. Foreground children communicate with their parent coordinator through a versioned process-local registry. Do not assume parent and child event buses are shared.

- Gate at completed thinking_end blocks and finalized assistant message_end, before tools execute.
- Deduplicate unchanged input within a response; no token-by-token or agent_end checks.
- Never monitor the main agent, selector, or reviewer.
- Retain every early FLAG even if a later checkpoint is reassuring.
- Combine concerns from one assistant response into one reviewer invocation at its completed-message boundary.
- The reviewer receives raw records and determines what/how to investigate. No exact-claim extraction is required.
- Deliver findings to the worker. If an action batch is already proposed, pause that batch once and let the worker reconsider with the findings; a FLAG is not treated as proof of error.

Bound live runs to 10 worker responses, 20 gate checkpoints, and three minutes per worker. Reviewers are limited to four responses and eight read-only tool calls. Limit exhaustion is recorded, not disguised as successful completion.

## 3. Benchmark and telemetry

### Small synthetic suite

Create 12 development cases, four per signal: two positives, one hard negative, and one missing-input case. Include authorized updates, investigation versus commitment, and distracting context.

Luna agents author cases and intended labels. Validate labels once with a separate DeepSeek-low call, resolve disagreements before freezing, and cache the labels. Subsequent scoring is deterministic—no judge call per iteration.

Generate three additional validation cases, one per signal, held back until the final selected version is evaluated.

Run the actual production-Pi control path, including child startup and parsing. Time Jev’s actual request path similarly. Exclude common parent startup from gate timing, but record it separately.

### Accounting

Record distinct buckets:

- Shared setup, fixture preparation, and context packing.
- Main/worker usage during live smoke.
- A/B gate usage.
- Reviewer usage during live smoke.
- Fixture validation/evaluation expense.

Worker and reviewer buckets are zero in Type 1 because neither runs there. Cached context’s input-token charges belong to each consuming gate call.

Each result records case/iteration IDs, arm, input and prompt hashes, model/effort, decisions, failures, call counts, latency, token usage, and cost provenance. Missing usage is null, not zero; reasoning tokens are a subset of output, not an additional total. Label computed costs as estimates when billed cost is unavailable.

Report investigation accuracy, missed investigations, unnecessary investigations, per-signal status accuracy, insufficient/error counts, mean cost, and mean/median latency. Do not silently exclude failed calls.

## 4. Self-iteration and cache rules

1. Finish wiring and verify telemetry before tuning.
2. Run two interleaved baseline passes for both gates; freeze the basic control prompt.
3. Tune Jev-specific wording/formatting on development cases. Keep signal meanings, inputs, and labels fixed.
4. Evaluate each candidate and retain the best valid version, prioritizing correctness, then cost and latency.
5. Run a fresh paired comparison on the held-back cases.

This becomes a tuned Jev versus frozen control comparison, not a claim of prompt-identical model ablation.

Cache control results using the dataset, labels, control prompt, shared packing/scoring logic, runtime versions, model/effort, and limits. Jev-only changes can reuse them. Shared changes or legitimate benchmark corrections invalidate affected controls. Mark reused results as historical; final validation uses fresh calls.

Stop on success, two consecutive non-improving candidates, five candidate versions, or the $1 ceiling. Reserve $0.20 for final validation. Reserve bounded estimated call cost before launching; count failed attempts and do not automatically retry or switch arms. Report unmet goals honestly.

## 5. Parallel work, checkpoints, and acceptance

Use three Luna max implementation subagents with separate ownership:

- Gate agent: signal definitions, typed results, selector-only operation, and control adapter.
- Integration agent: monitored worker launch, child hooks, reviewer feedback, and native usage capture.
- Benchmark agent: cases, scoring, ledger, caches, and iteration reports.

The main agent locks shared interfaces first, coordinates integration, and reviews results. Do not parallelize benchmark timing runs; interleave them serially.

Persist every iteration under benchmarks/results/<iteration-id>/: manifest, cases/labels, prompt versions, per-case JSONL, metrics, spend ledger, and tuning notes. Never overwrite prior runs.

Create codex/jev-gate-poc, preserve existing work, and commit/push checkpoints after the plan, integrated POC, baseline results, and each meaningful tuning iteration. Commit only task-owned files; scan for secrets before pushing.

Acceptance is deliberately small:

- Existing relevant checks/typecheck still pass.
- A scripted child smoke proves thinking/action capture, deduplication, role exclusions, and reviewer-feedback delivery.
- Selector-only runs invoke zero reviewers.
- Both arms receive identical prepared case inputs.
- Telemetry reconciles without double-counting or converting unknown usage to zero.
- Results and cache provenance are saved, limits work, and the final report identifies the best version and any unmet goals.

No production-hardening project, large test suite, or E2E benchmark in this phase.
