import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { productionPi } from "./production-pi.mjs";

// Explicit, billable connectivity check. No mock API or generative model call.
try {
  const running = promisify(execFile)(productionPi(), [
    "--approve", "--offline", "--no-session", "--mode", "json", "-p", "/jev test",
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  // Pi reads piped stdin before processing print-mode prompts; signal no input.
  running.child.stdin?.end();
  const { stdout } = await running;
  const records = stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const message = records.find((record) => record.type === "message_end"
    && record.message?.customType === "pi-grail-jev");
  if (!message) throw new Error("Pi did not return a Jev result message.");
  const result = message.message.details;
  if (result.error) throw new Error(result.error);
  assert.equal(typeof result.model, "string");
  assert.equal(result.answers?.ready?.type, "noul");
  const value = result.answers.ready.noul;
  assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
  assert.ok(Number.isInteger(result.usage?.input_tokens) && result.usage.input_tokens >= 0);
  assert.ok(Number.isInteger(result.usage?.output_tokens) && result.usage.output_tokens >= 0);
  console.log(JSON.stringify({ passed: true, model: result.model, answer: result.answers.ready, usage: result.usage }, null, 2));
} catch (error) {
  // Child-process errors may contain captured output; do not dump that object.
  const message = error instanceof Error && !["SyntaxError", "AssertionError"].includes(error.name)
    && !("cmd" in error) ? error.message : "Pi did not return a valid Jev inference response.";
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}
