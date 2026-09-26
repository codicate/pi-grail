import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { grailPi } from "./grail-pi.js";

const apiCalls: { kind: string; body: any }[] = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/systemone") {
    apiCalls.push({ kind: "jev", body });
    const choice = body.state.latestTurn.text.includes("now edit") ? "FLAG" : "NO_VISIBLE_SIGNAL";
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => {
      const status = id === "instruction_drift" ? choice : "NO_VISIBLE_SIGNAL";
      return [id, { type: "choice", choice: status, confidence: 1,
        probabilities: { FLAG: status === "FLAG" ? 1 : 0, NO_VISIBLE_SIGNAL: status === "NO_VISIBLE_SIGNAL" ? 1 : 0, INSUFFICIENT_INPUT: 0 } }];
    }));
    res.end(JSON.stringify({ model: "jev-localhost-fixture", answers,
      usage: { input_tokens: 100, output_tokens: 20 } }));
    return;
  }
  if (req.url !== "/chat/completions") { res.writeHead(404); res.end("{}"); return; }
  const selector = JSON.stringify(body.messages).includes("zero-shot selector for whether a read-only reviewer");
  const kind = selector ? "control" : "reviewer";
  apiCalls.push({ kind, body });
  let delta: any, finishReason: string;
  if (selector) {
    assert.ok(!body.tools?.length, "control selector cannot retrieve or verify");
    const choice = JSON.stringify(body.messages).includes("now edit") ? "FLAG" : "NO_VISIBLE_SIGNAL";
    delta = { content: JSON.stringify({ instruction_drift: choice,
      unverified_assumption: "NO_VISIBLE_SIGNAL", evidence_leap: "NO_VISIBLE_SIGNAL" }) }; finishReason = "stop";
  } else if (!body.messages.some((m: any) => m.role === "tool")) {
    assert.deepEqual(body.tools.map((t: any) => t.function.name).sort(), ["find", "grep", "ls", "read"]);
    delta = { tool_calls: [{ index: 0, id: "fixture-read", type: "function", function: { name: "read",
      arguments: JSON.stringify({ path: "test/fixtures/grail-requirement.txt" }) } }] };
    finishReason = "tool_calls";
  } else {
    assert.ok(JSON.stringify(body.messages).includes("must not edit it"), "real reviewer tool result must contain source requirement");
    delta = { content: "Verified conflict: the committed edit violates the source requirement in test/fixtures/grail-requirement.txt:1. Do not edit the fixture." };
    finishReason = "stop";
  }
  res.setHeader("content-type", "text/event-stream");
  const event = { id: "localhost-fixture", object: "chat.completion.chunk", created: 1, model: "test" };
  res.write(`data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const sourceBefore = readFileSync("test/fixtures/grail-requirement.txt", "utf8");
try {
  const env = { ...process.env, GRAIL_FIXTURE_URL: `http://127.0.0.1:${address.port}`,
    TYPESAFE_BASE_URL: `http://127.0.0.1:${address.port}`, TYPESAFE_API_KEY: "localhost-jev-not-a-key" };
  const args = ["--extension", resolve("test/support/grail-provider.ts"), "--grail-model", "grail-fixture/test"];
  const status = await grailPi("jev", "/grail status", args, env);
  assert.equal(status.personasRegistered, true); assert.equal(status.modelAuthenticated, true);
  assert.equal(apiCalls.length, 0, "status/startup must not infer");
  const reports = [];
  for (const arm of ["jev", "subagent"]) {
    const report = await grailPi(arm, "/grail smoke", args, env);
    if (report.error) throw new Error(report.error);
    const [flag, clean] = report.results;
    assert.equal(flag.status, "FLAG", JSON.stringify(flag));
    assert.equal(flag.reviewInvocations, 1); assert.equal(flag.reviewer?.terminalStatus, "completed", JSON.stringify(flag));
    assert.match(flag.reviewer.text, /Verified conflict/);
    assert.equal(flag.reviewer.usage.toolCalls, 1);
    assert.equal(flag.reviewer.usage.turns, 2);
    assert.equal(flag.reviewer.usage.input, 200);
    assert.equal(flag.reviewer.usage.output, 40);
    assert.equal(flag.reviewer.reasoningTokens, 6, "native child usage must retain reasoning as an output subset");
    if (arm === "subagent") {
      assert.equal(flag.selectorResult.usage.turns, 1);
      assert.equal(flag.selectorResult.usage.input, 100);
      assert.equal(flag.selectorResult.usage.output, 20);
      assert.equal(flag.selectorResult.reasoningTokens, 3);
    }
    assert.equal(clean.status, "NO_VISIBLE_SIGNAL"); assert.equal(clean.reviewInvocations, 0);
    reports.push(report);
  }
  for (let i = 0; i < 2; i++) {
    assert.equal(reports[0].results[i].packetHash, reports[1].results[i].packetHash);
    assert.equal(reports[0].results[i].judgmentHash, reports[1].results[i].judgmentHash);
  }
  assert.equal(reports[0].results[0].reviewerTaskHash, reports[1].results[0].reviewerTaskHash);
  const batchPath = resolve(mkdtempSync(resolve(tmpdir(), "grail-batch-smoke-")), "batch.json");
  const items = ["grail-drift.json", "grail-no-drift.json"].flatMap(name => {
    const packet = JSON.parse(readFileSync(resolve("test/fixtures", name), "utf8"));
    return ["jev", "subagent"].map(selector => ({ id: `${name}:${selector}`, selector, packet }));
  });
  writeFileSync(batchPath, JSON.stringify({ items }));
  const batch = await grailPi("jev", `/grail classify-batch ${batchPath}`, args, env);
  assert.equal(batch.results.length, 4);
  for (const row of batch.results) assert.equal(row.result.reviewInvocations, 0, "Type-1 production path must never review");
  for (const offset of [0, 2]) assert.equal(batch.results[offset].result.packetHash, batch.results[offset + 1].result.packetHash);
  assert.equal(apiCalls.filter(c => c.kind === "jev").length, 4);
  assert.equal(apiCalls.filter(c => c.kind === "control").length, 4);
  assert.equal(apiCalls.filter(c => c.kind === "reviewer").length, 4);
  assert.equal(readFileSync("test/fixtures/grail-requirement.txt", "utf8"), sourceBefore);
  console.log(JSON.stringify({ passed: true, productionPiAndSubagents: true, localhostModelFixtures: true,
    paidInference: false, selectorArms: ["jev", "subagent"], casesPerArm: 2, reviewerCallsPerArm: 1,
    identicalPacketJudgmentAndReviewer: true, actualReadToolUsed: true, selectorOnlyBatchHasZeroReviewers: true }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
