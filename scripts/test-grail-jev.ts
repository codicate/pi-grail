import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/jev.js";
import { JEV_MODEL, SIGNAL_IDS, jevRequest, parseOutcome, preparePacket, type Packet, type Outcome } from "../src/selector.js";

// Explicit paid selector smoke; does not invoke a control or reviewer.
const cases: { fixture: string; expected: Record<(typeof SIGNAL_IDS)[number], Outcome> }[] = [
  { fixture: "grail-drift.json", expected: {
    instruction_drift: "FLAG", unverified_assumption: "NO_VISIBLE_SIGNAL", evidence_leap: "NO_VISIBLE_SIGNAL",
  } },
  { fixture: "grail-no-drift.json", expected: {
    instruction_drift: "NO_VISIBLE_SIGNAL", unverified_assumption: "NO_VISIBLE_SIGNAL", evidence_leap: "NO_VISIBLE_SIGNAL",
  } },
];

try {
  const reports = [];
  for (const item of cases) {
    const { packet } = preparePacket(JSON.parse(readFileSync(`test/fixtures/${item.fixture}`, "utf8")) as Packet);
    assert.ok(packet);
    const response = await evaluate(jevRequest(packet));
    assert.equal(response.model, JEV_MODEL);
    assert.deepEqual(Object.keys(response.answers).sort(), [...SIGNAL_IDS].sort());
    const answers = Object.fromEntries(SIGNAL_IDS.map(id => [id, parseOutcome(response.answers[id].choice)])) as Record<(typeof SIGNAL_IDS)[number], Outcome>;
    assert.deepEqual(answers, item.expected);
    reports.push({ fixture: item.fixture, model: response.model, answers: response.answers, usage: response.usage });
  }
  console.log(JSON.stringify({ passed: true, realJev: true, selectorOnly: true, promptVersion: "baseline-v1", reports }, null, 2));
} catch (error) {
  console.error(error instanceof Error && error.name !== "AssertionError" ? error.message : "Jev did not satisfy the three-signal smoke fixture expectations.");
  process.exitCode = 1;
}
