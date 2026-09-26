import assert from "node:assert/strict";
import { grailPi } from "./grail-pi.js";

// Explicit paid smoke only: two tiny packets per arm, NOT a benchmark.
try {
  const args = process.argv.slice(2);
  const selector = args[0] ?? "both";
  if (!["both", "jev", "subagent"].includes(selector)) throw new Error("Use: npm run test:grail:live -- [both|jev|subagent] [Pi flags]");
  const arms = selector === "both" ? ["jev", "subagent"] : [selector];
  const reports = [];
  for (const arm of arms) {
    const report = await grailPi(arm, "/grail smoke", args.slice(1));
    const [flag, noFlag] = report.results;
    assert.equal(flag.status, "FLAG"); assert.equal(flag.selectorInvocations, 1); assert.equal(flag.reviewInvocations, 1);
    assert.equal(flag.target.record.ref, "smoke-trace/worker-turn-1");
    assert.equal(flag.reviewer?.terminalStatus, "completed");
    assert.ok(flag.reviewer.text.trim());
    assert.ok(flag.reviewer.usage?.toolCalls >= 1, "reviewer should inspect the actual source fixture");
    assert.equal(noFlag.status, "NO_VISIBLE_SIGNAL"); assert.equal(noFlag.selectorInvocations, 1); assert.equal(noFlag.reviewInvocations, 0);
    reports.push({ selector: arm, results: report.results });
  }
  if (reports.length === 2) {
    for (let i = 0; i < 2; i++) {
      assert.equal(reports[0].results[i].packetHash, reports[1].results[i].packetHash);
      assert.equal(reports[0].results[i].judgmentHash, reports[1].results[i].judgmentHash);
    }
    assert.equal(reports[0].results[0].reviewerTaskHash, reports[1].results[0].reviewerTaskHash);
  }
  console.log(JSON.stringify({ passed: true, fixtureOnly: true, reports }, null, 2));
} catch (error) {
  const message = error instanceof Error && error.name !== "AssertionError" && !("cmd" in error)
    ? error.message : "Grail smoke did not satisfy the selector/reviewer/parity checks.";
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}
