# pi-grail

POC extension for released Pi 0.87.1 and pi-subagents 0.71.0. Jev and a generic
LLM gate decide when a shared reviewer should investigate worker activity.
[PLAN.md](PLAN.md) is the approved scope; [HANDOFF.md](HANDOFF.md) is historical context.

## Setup and iteration

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
npm ci --ignore-scripts
pi install npm:pi-subagents@0.71.0
npm run link
npm run dev -- --grail-selector jev
# Alternative gate:
npm run dev -- --grail-selector subagent
```

Pi loads this checkout directly. Use `/reload` after edits, or restart Pi. There
is no build step or fork. Scripts resolve the global production Pi binary;
the local dependency supplies matching types. Reference clones under /tmp are not used.

Jev reads TYPESAFE_API_KEY from the ignored, owner-only .env in this checkout,
or a key installed by `npm run jev:auth`. Environment values take precedence.
OpenRouter uses Pi's normal auth store (`npm run pi:auth`) or OPENROUTER_API_KEY.
Never commit credentials.

The gate pins jev-1.13.0; generative children default to
openrouter/deepseek/deepseek-v4.1-flash, thinking low. Override with
--grail-model and --grail-thinking. Keep these fixed across comparisons.
Raw /jev calls can select another model independently.

## Gate and reviewer

```text
/jev status
/grail status
/grail classify test/fixtures/grail-drift.json
/grail check test/fixtures/grail-drift.json
```

Classify only selects; it never launches a reviewer. Check uses the same
selection operation and launches the shared read-only reviewer if any signal
is flagged. Status commands are free; classify/check consume credits.

The three independent signals are instruction drift, acting on an explicit
unverified assumption, and an explicit evidence-to-conclusion leap. Jev asks
three Choice questions in one request. The control launches one fresh,
tool-free generic subagent returning the same three statuses. Reviewer prompts
do not identify the A/B arm.

Both arms receive the existing handoff, authorized updates, and raw current
thinking/actions. Packets have raw references and a conservative **16,000-byte
UTF-8 application limit**. This is not Jev's token limit. Essential missing or
oversized input yields INSUFFICIENT_INPUT and skips review. No truncation,
generated summaries, or fallback calls. NO_VISIBLE_SIGNAL does not certify correctness.

## Monitored workers

Use the model-callable grail_worker tool to launch a monitored foreground
worker through pi-subagents. This explicit launch path is the supported POC
scope; arbitrary or detached background workers are not covered.

The child extension gates completed thinking blocks and finalized assistant
messages before tools execute, deduplicating unchanged input within a response.
Early flags survive later reassuring results. At the message boundary, one
reviewer receives the accumulated raw records and decides what/how to inspect.
Findings are delivered to the worker; any already-proposed action batch is
paused once so the worker can reconsider. A flag is not proof of error.

Only workers are monitored. Selectors and reviewers do not recursively trigger
gates. Foreground communication uses a versioned process-local registry because
parent and child extension event buses are distinct.

Runs are capped at 10 worker responses, 20 checkpoints, and three minutes.
Reviewers have four responses and eight read-only tool calls. Exhaustion is
recorded explicitly. This checkout disables Pi retry and automatic compaction
in .pi/settings.json for bounded POC runs.

## Benchmark and accounting

Type 1 evaluates selection only, using 12 development cases and three held-back
cases. Intended labels are independently validated once with DeepSeek-low and
then frozen. No workers, reviewers, or per-iteration judges run in Type 1.
The one-case E2E runner is being prepared separately; E2E execution is not part
of this tuning phase and requires a later explicit run.

Timing includes actual production-Pi child startup and parsing for the control;
common parent startup is recorded separately. Calls run serially, interleaving
arms. Jev tuning uses development cases and a frozen basic control. Reused
control results are marked historical; final comparisons use fresh calls.

Results under benchmarks/results/<iteration-id>/ retain packets, labels,
prompts, hashes, individual outcomes, usage, costs, timing, and tuning notes.
The run ledger reserves estimated bounds before paid calls, retains uncertain
charges for failed attempts, enforces the user-authorized $10 overall ceiling, and reserves $0.20 for final
validation. See [benchmarks/README.md](benchmarks/README.md) for commands.

Shared preparation, A/B gates, live workers/reviewers, and label validation are
separate accounting buckets. Missing usage is null; Type-1 worker/reviewer
usage is known zero. Reasoning tokens are a subset of output, never added twice.
Pi-derived or price-derived costs are estimates when billed cost is unavailable.
OpenRouter calls use a fixed price ceiling without automatic provider fallback.
Estimates use that ceiling without assuming cache discounts, not the
OpenRouter model listing's cheapest available route. The selector has an 8,192
output-token cap including reasoning; label validation has a separate cap.
The delegation DTO omits reasoning counts; native child telemetry supplements
it where available, without treating absent values as measured zeros.

## Checks

```sh
npm run typecheck
npm test
npm run test:pi
npm run test:grail
npm run test:grail:child
```

The scripted Pi checks use localhost model fixtures and consume no paid API
credits. Live scripts (test:grail:live, test:grail:jev, test:reasoning:live,
test:pi:live, jev:test) make paid calls; do not run them as free checks.

Implementation follows the Pi extension skill and the TypeSafe skill's guidance
to ask independent typed questions over shared state. Installed Pi types govern
event semantics. Relevant references: [Pi extensions](https://pi.dev/docs/latest/extensions),
[pi-subagents API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md),
[TypeSafe Choice](https://docs.typesafe.ai/primitives/choice), and
[TypeSafe models/pricing](https://docs.typesafe.ai/models).
