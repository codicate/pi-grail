# Handoff: selectively invoking Grail

Historical design context. The approved implementation scope and later decisions
(including packet limits, insufficient-input handling, and reviewer targeting)
are recorded in [PLAN.md](PLAN.md), which is the current source of truth.

## Problem

Today, **Grail reviews every worker at completion**. We want **fewer total Grail calls without losing important-error detection**, ideally catching problems early enough to steer workers.

The selector is a **cheap, zero-shot API classifier with ~20k context**, no retrieval or deep reasoning. Inputs must be assembled deterministically from existing records—**no new worker or LLM-generated summaries**. The existing delegation handoff is allowed.

**Moving every review earlier does not save calls.** Early checks, rechecks, audits, and fallbacks all count against the one-review-per-worker baseline.

## Core design

**A visible warning signal determines whether to invoke Grail; the claim or check behind it determines what Grail inspects.**

The classifier does not establish truth. Grail verifies against the source of truth and decides how to investigate.

New reasoning, a major decision, or choosing an approach is **not itself a trigger**—otherwise we effectively review everyone again.

## Signals

The first three share a base packet:

**Existing handoff + authorized instruction updates + latest thinking/action turn.**

1. **Instruction drift:** Intended action conflicts with an assigned objective or constraint. Distinguish exploration from commitment; include legitimate instruction updates.
2. **Acting on an explicitly unverified assumption:** Worker names an unresolved fact, then takes an action depending on it. Mere uncertainty or investigation is insufficient. Unstated assumptions remain invisible.
3. **Explicit evidence-to-conclusion leap:** Both limited evidence and an overly broad conclusion are visible—for example, searching one folder and declaring something unused everywhere. **Missing evidence in the packet does not mean no evidence exists.**

Two additional signals require reliable tool records:

4. **Interpretation conflicts with a tool result:** Package the identifiable operation, result, intervening retries, and worker reaction. Preserve successful retries. Call IDs bind calls to results, **not automatically claims to operations**; ambiguous matching means insufficient input.
5. **A failed check was subsequently changed:** Link a named failure to a change in that same check or its enforcement. Grail determines whether the change preserves the requirement. **Changed does not mean illegitimate**, and time proximity alone is insufficient.

## Guardrails and unresolved limits

- Enforce the 20k budget; missing essential context must not become a clean result.
- Distinguish **FLAG**, **NO VISIBLE SIGNAL**, and **INSUFFICIENT INPUT**. No visible signal is not a correctness guarantee.
- Preserve the flagged claim/check and raw references for Grail. One reassuring signal cannot cancel another concern.
- Hidden assumptions, scattered contradictions, and comprehensive requirement coverage remain unsolved.
- Confidence, change size, risky filenames, and routine recovery problems are not standalone Grail triggers. Fixed action-to-question libraries are excluded.

## Implementation and evidence

**Pi extension + existing `pi-subagents` reviewer; no Pi-core fork required.** Background-worker event routing needs integration; tool-backed coverage depends on actual records.

Definitions were independently challenged, but **no real-trace classifier evaluation or demonstrated savings/detection performance exists yet**. Start with the three base-input signals; measure both **whether review was invoked** and **whether it targeted the right claim**.
