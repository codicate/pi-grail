import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { productionPi } from "./production-pi.mjs";

// Explicit paid smoke: one bounded raw API call, one ephemeral production Pi call.
// Report availability/counts only; never print credentials or raw reasoning.
try {
  const model = "deepseek/deepseek-v4.1-flash";
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const credentials = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
  const apiKey = process.env.OPENROUTER_API_KEY || credentials.openrouter?.key;
  if (!apiKey) throw new Error("OpenRouter credentials are missing.");
  const prompt = "Compute 23 * 19. Return only the integer in your final answer.";
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "pi-grail-smoke" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }],
      reasoning: { effort: "low", exclude: false }, max_tokens: 512,
      provider: { require_parameters: true } }),
  });
  if (!response.ok) throw new Error(`OpenRouter smoke failed (HTTP ${response.status}); response body withheld.`);
  const raw = await response.json();
  const message = raw.choices?.[0]?.message;
  assert.equal(message?.content?.trim(), "437", "raw API final answer");
  const reasoning = message.reasoning || message.reasoning_content ||
    (message.reasoning_details ?? []).filter((item: { type: string }) => item.type === "reasoning.text")
      .map((item: { text?: string }) => item.text ?? "").join("");
  assert.ok(reasoning.length > 0, "raw API must expose reasoning text");
  const reasoningTokens = raw.usage?.completion_tokens_details?.reasoning_tokens;
  assert.ok(Number.isInteger(reasoningTokens) && reasoningTokens > 0, "provider must report reasoning tokens; missing is not zero");
  console.log(JSON.stringify({ phase: "openrouter", passed: true, model: raw.model, requestedEffort: "low",
    reasoningAvailable: true, reasoningCharacters: reasoning.length,
    usage: { input: raw.usage.prompt_tokens, output: raw.usage.completion_tokens, reasoning: reasoningTokens, cost: raw.usage.cost ?? null } }));

  const running = promisify(execFile)(productionPi(), ["--approve", "--offline", "--no-session", "--mode", "json",
    "--no-tools", "--no-skills", "--no-context-files", "--model", `openrouter/${model}`, "--thinking", "low",
    "--system-prompt", "You are a calculator. Keep the final answer to the requested integer.", "-p", prompt],
  { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  running.child.stdin?.end();
  const { stdout } = await running;
  const records = stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  const assistant = records.filter(record => record.type === "message_end" && record.message?.role === "assistant").at(-1)?.message;
  assert.ok(assistant && assistant.stopReason === "stop", "production Pi completion");
  const final = assistant.content.filter((item: { type: string }) => item.type === "text")
    .map((item: { text: string }) => item.text).join("").trim();
  assert.equal(final, "437", "production Pi final answer");
  const blocks = assistant.content.filter((item: { type: string }) => item.type === "thinking");
  const characters = blocks.reduce((sum: number, item: { thinking?: string }) => sum + (item.thinking?.length ?? 0), 0);
  assert.ok(characters > 0, "production Pi must retain native thinking content");
  assert.ok(assistant.usage?.reasoning > 0, "production Pi reasoning usage");
  console.log(JSON.stringify({ phase: "production-pi", passed: true, provider: assistant.provider, model: assistant.model,
    requestedEffort: "low", reasoningAvailable: true, reasoningCharacters: characters,
    usage: assistant.usage, ephemeral: true, toolsDisabled: true }));
} catch (error) {
  // execFile errors contain captured output. Never print them or API response bodies.
  const message = error instanceof Error && error.name !== "AssertionError" && !("cmd" in error)
    ? error.message : "Reasoning smoke did not satisfy the native API/Pi checks; raw output withheld.";
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}
