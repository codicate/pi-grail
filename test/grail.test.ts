import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyGrail, runGrail, selectorMode, type HarnessDependencies, type LeafInput } from "../src/grail.js";
import {
  CONTROL_SYSTEM_PROMPT, DEFAULT_JEV_PROMPT_VERSION, JEV_MODEL, SIGNAL_IDS, controlTask, digest,
  jevPromptContract, jevRequest, judgmentContract, MAX_PACKET_BYTES, preparePacket,
  type Outcome, type Packet, type SignalId,
} from "../src/selector.js";

const drift = JSON.parse(readFileSync("test/fixtures/grail-drift.json", "utf8")) as Packet;
const clean: Record<SignalId, Outcome> = {
  instruction_drift: "NO_VISIBLE_SIGNAL", unverified_assumption: "NO_VISIBLE_SIGNAL", evidence_leap: "NO_VISIBLE_SIGNAL",
};
const flagged: Record<SignalId, Outcome> = {
  instruction_drift: "FLAG", unverified_assumption: "NO_VISIBLE_SIGNAL", evidence_leap: "INSUFFICIENT_INPUT",
};

function fixture(statuses: Record<SignalId, string> = flagged, malformedControl?: string) {
  const leaves: LeafInput[] = [];
  const evaluations: unknown[] = [];
  const deps: HarnessDependencies = {
    evaluate: (async (input: unknown) => {
      evaluations.push(input);
      return { model: JEV_MODEL, answers: Object.fromEntries(SIGNAL_IDS.map(id => [id, {
        type: "choice", choice: statuses[id], probabilities: { [statuses[id]]: 1 }, confidence: 1,
      }])), usage: { input_tokens: 120, output_tokens: 26 } };
    }) as HarnessDependencies["evaluate"],
    leaf: async input => {
      leaves.push(input);
      return { requestId: "fixture", ownerRunId: "fixture", nodeId: input.nodeId, status: "completed", model: "fixture/test",
        result: { kind: "text", text: input.selector ? malformedControl ?? JSON.stringify(statuses) : "Concern reviewed against test/fixtures/grail-requirement.txt:1." },
        usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: input.selector ? 0 : 1, durationMs: 1 },
        nativeTelemetry: { source: "pi_native_normalized", assistantMessages: 1, uncachedInputTokens: 44, outputTokens: 18,
          cacheReadTokens: 6, cacheWriteTokens: 0, reasoningTokens: 4 } };
    },
  };
  return { deps, leaves, evaluations };
}

test("three independent Jev Choice questions share one raw packet and pin jev-1.13.0", () => {
  const request = jevRequest(drift);
  assert.equal(request.model, JEV_MODEL);
  assert.equal(request.model, "jev-1.13.0");
  assert.deepEqual(request.state, drift);
  assert.deepEqual(Object.keys(request.questions).sort(), [...SIGNAL_IDS].sort());
  for (const id of SIGNAL_IDS) {
    assert.ok(request.questions[id].criteria.FLAG);
    assert.ok(request.questions[id].criteria.NO_VISIBLE_SIGNAL);
    assert.ok(request.questions[id].criteria.INSUFFICIENT_INPUT);
  }
  assert.equal(jevPromptContract().model, JEV_MODEL);
  assert.equal(DEFAULT_JEV_PROMPT_VERSION, "baseline-v1");
  assert.deepEqual(JSON.parse(controlTask(drift)).state, drift);
  assert.match(CONTROL_SYSTEM_PROMPT, /exactly these three keys/);
  assert.deepEqual(judgmentContract(drift).signals, jevPromptContract().questions);
});

test("classifyGrail returns all signal outcomes and never invokes a reviewer", async () => {
  const jev = fixture(flagged);
  const a = await classifyGrail(drift, "jev", jev.deps);
  assert.deepEqual(a.perSignal, flagged);
  assert.equal(a.status, "FLAG", "any FLAG dominates insufficient input");
  assert.equal(a.investigate, true);
  assert.deepEqual(a.rawReferences, [drift.handoff.ref, drift.latestTurn.ref]);
  assert.equal(a.selectorInvocations, 1, "the three Jev questions share one API request");
  assert.equal(a.reviewInvocations, 0);
  assert.equal(a.selectorResult.model, JEV_MODEL);
  assert.deepEqual(a.selectorResult.usage, { input_tokens: 120, output_tokens: 26 });
  assert.ok(a.latencyMs >= 0);
  assert.equal(a.hashes.packetHash, digest(drift));
  assert.equal(a.packetHash, a.hashes.packetHash);
  assert.equal(jev.evaluations.length, 1);
  assert.equal(jev.leaves.length, 0);

  const control = fixture(flagged);
  const b = await classifyGrail(drift, "subagent", control.deps);
  assert.deepEqual(b.perSignal, flagged);
  assert.equal(b.status, "FLAG");
  assert.equal(b.reviewInvocations, 0);
  assert.equal(b.selectorInvocations, 1);
  assert.equal(control.evaluations.length, 0);
  assert.equal(control.leaves.length, 1);
  assert.equal(control.leaves[0].agent, "grail-selector");
  assert.deepEqual(b.selectorResult.usage, { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 });
  assert.equal(b.selectorResult.reasoningTokens, 4);
  assert.deepEqual(b.selectorResult.nativeTelemetry, { source: "pi_native_normalized", assistantMessages: 1, uncachedInputTokens: 44,
    outputTokens: 18, cacheReadTokens: 6, cacheWriteTokens: 0, reasoningTokens: 4 });
});

test("runGrail calls the same reviewer exactly once for a flag from either arm", async () => {
  const jev = fixture(flagged), control = fixture(flagged);
  const a = await runGrail(drift, "jev", jev.deps);
  const b = await runGrail(drift, "subagent", control.deps);
  assert.equal(a.status, "FLAG"); assert.equal(b.status, "FLAG");
  assert.equal(a.investigate, true); assert.equal(b.investigate, true);
  assert.equal(a.reviewInvocations, 1); assert.equal(b.reviewInvocations, 1);
  assert.equal(a.hashes.packetHash, b.hashes.packetHash);
  assert.equal(a.hashes.judgmentHash, b.hashes.judgmentHash);
  assert.equal(a.hashes.selectorPromptHash === b.hashes.selectorPromptHash, false);
  assert.equal(a.reviewerTaskHash, b.reviewerTaskHash);
  assert.deepEqual(a.target?.record, drift.latestTurn);
  assert.deepEqual(a.target?.signal, "instruction_drift");
  assert.deepEqual(jev.leaves.filter(input => !input.selector), control.leaves.filter(input => !input.selector));
});

test("no flag means no reviewer; insufficient results remain distinct and do not investigate", async () => {
  for (const selector of ["jev", "subagent"] as const) {
    for (const [status, expectedInvestigate] of [["NO_VISIBLE_SIGNAL", false], ["INSUFFICIENT_INPUT", false]] as const) {
      const statuses = Object.fromEntries(SIGNAL_IDS.map(id => [id, status])) as Record<SignalId, Outcome>;
      const f = fixture(statuses);
      const result = await runGrail(drift, selector, f.deps);
      assert.equal(result.status, status);
      assert.equal(result.investigate, expectedInvestigate);
      assert.equal(result.reviewInvocations, 0);
      assert.equal(f.leaves.filter(input => !input.selector).length, 0);
    }
  }
  const f = fixture({ instruction_drift: "NO_VISIBLE_SIGNAL", unverified_assumption: "INSUFFICIENT_INPUT", evidence_leap: "NO_VISIBLE_SIGNAL" });
  const result = await classifyGrail(drift, "jev", f.deps);
  assert.equal(result.status, "INSUFFICIENT_INPUT");
  assert.equal(result.investigate, false);
});

test("invalid packets and malformed selector output fail closed without fallback", async () => {
  for (const packet of [{ ...drift, contextComplete: false }, { ...drift, instructionUpdates: undefined },
    { ...drift, instructionUpdates: [{ ref: "update", text: "Edit it", authorized: false }] },
    { ...drift, latestTurn: { ref: "big", text: "🙂".repeat(MAX_PACKET_BYTES) } }]) {
    assert.ok(preparePacket(packet).error);
    for (const selector of ["jev", "subagent"] as const) {
      const f = fixture();
      const result = await classifyGrail(packet, selector, f.deps);
      assert.equal(result.status, "INSUFFICIENT_INPUT");
      assert.equal(result.selectorInvocations, 0);
      assert.equal(result.reviewInvocations, 0);
      assert.equal(f.evaluations.length, 0); assert.equal(f.leaves.length, 0);
    }
  }
  const malformedJev = fixture({ instruction_drift: "bad", unverified_assumption: "NO_VISIBLE_SIGNAL", evidence_leap: "NO_VISIBLE_SIGNAL" });
  const oneBadSignal = await classifyGrail(drift, "jev", malformedJev.deps);
  assert.deepEqual(oneBadSignal.perSignal, { instruction_drift: "INSUFFICIENT_INPUT", unverified_assumption: "NO_VISIBLE_SIGNAL", evidence_leap: "NO_VISIBLE_SIGNAL" });
  assert.equal(oneBadSignal.status, "INSUFFICIENT_INPUT");

  const malformedControl = fixture(flagged, '{"instruction_drift":"FLAG","unverified_assumption":"NO_VISIBLE_SIGNAL"}');
  const failed = await classifyGrail(drift, "subagent", malformedControl.deps);
  assert.equal(failed.status, "INSUFFICIENT_INPUT");
  assert.deepEqual(failed.perSignal, { instruction_drift: "INSUFFICIENT_INPUT", unverified_assumption: "INSUFFICIENT_INPUT", evidence_leap: "INSUFFICIENT_INPUT" });
  assert.equal(failed.selectorInvocations, 1);
  assert.equal(failed.reviewInvocations, 0);
  assert.throws(() => selectorMode("typo"));
});

test("Jev tuning options change the Jev request and hash but leave the control frozen", async () => {
  const options = { jevPromptVersion: "candidate-2", jevInstructionsBySignal: { evidence_leap: "Candidate evidence-leap wording." } };
  const tunedJev = fixture(clean);
  const a = await classifyGrail(drift, "jev", tunedJev.deps, undefined, options);
  const request = tunedJev.evaluations[0] as ReturnType<typeof jevRequest>;
  assert.equal(request.questions.evidence_leap.instructions, "Candidate evidence-leap wording.");
  assert.equal(a.selectorPromptVersion, "candidate-2");
  assert.notEqual(a.hashes.selectorPromptHash, (await classifyGrail(drift, "jev", fixture(clean).deps)).hashes.selectorPromptHash);

  const tunedControl = fixture(clean);
  const b = await classifyGrail(drift, "subagent", tunedControl.deps, undefined, options);
  assert.equal(b.selectorPromptVersion, "control-v1");
  assert.equal(tunedControl.leaves[0].task, controlTask(drift));
  assert.equal(b.hashes.selectorPromptHash, (await classifyGrail(drift, "subagent", fixture(clean).deps, undefined, options)).hashes.selectorPromptHash);
});

test("reviewer failure preserves the flag and any returned native usage metadata", async () => {
  const f = fixture(flagged);
  f.deps.leaf = async input => {
    if (input.selector) return { requestId: "selector", ownerRunId: "fixture", nodeId: input.nodeId, status: "completed",
      result: { kind: "text", text: JSON.stringify(flagged) }, usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 } };
    return { requestId: "reviewer", ownerRunId: "fixture", nodeId: input.nodeId, status: "tool_budget_exhausted", model: "fixture/reviewer",
      usage: { input: 14, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 8, durationMs: 1 },
      nativeTelemetry: { source: "pi_native_normalized", assistantMessages: 1, uncachedInputTokens: 12, outputTokens: 5,
        cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 2 } };
  };
  const result = await runGrail(drift, "jev", f.deps);
  assert.equal(result.status, "FLAG"); assert.equal(result.investigate, true);
  assert.equal(result.reviewInvocations, 1);
  assert.equal(result.reviewer?.terminalStatus, "tool_budget_exhausted");
  assert.deepEqual(result.reviewer?.usage, { input: 14, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 8, durationMs: 1 });
  assert.equal(result.reviewer?.reasoningTokens, 2);
  assert.deepEqual(result.reviewer?.nativeTelemetry, { source: "pi_native_normalized", assistantMessages: 1, uncachedInputTokens: 12,
    outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 2 });
  assert.ok("error" in result.reviewer!);
});
