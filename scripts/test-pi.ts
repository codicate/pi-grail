import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { productionPi } from "./production-pi.mjs";

const executable = productionPi();
const isolated = process.argv.includes("--isolated");
const apiCalls: string[] = [];
let failInference = false;
const server = createServer(async (req, res) => {
  apiCalls.push(req.url || "");
  for await (const _chunk of req) { /* drain request */ }
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/models") res.end(JSON.stringify([{ name: "jev-fixture", description: "Local transport fixture", release_date: "2026-09-26" }]));
  else if (failInference) { res.writeHead(402); res.end(JSON.stringify({ detail: "Billing failure fixture" })); }
  else res.end(JSON.stringify({ model: "jev-fixture", answers: { ready: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 20, output_tokens: 5 } }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");

let child: ChildProcessWithoutNullStreams | undefined;
try {
  const env = { ...process.env, TYPESAFE_API_KEY: "pi-grail-smoke-fixture", TYPESAFE_BASE_URL: `http://127.0.0.1:${address.port}` };
  const args = ["--mode", "rpc", "--no-session", "--offline", "--approve"];
  if (isolated) {
    Object.assign(env, { PI_CODING_AGENT_DIR: await mkdtemp(join(tmpdir(), "pi-grail-host-")) });
    args.push("--no-extensions", "--extension", process.cwd(), "--no-skills", "--no-context-files");
  }
  child = spawn(executable, args, { cwd: process.cwd(), env, stdio: "pipe" });
  let buffer = "", stderr = "";
  const records: Record<string, any>[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let lf;
    while ((lf = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, lf).replace(/\r$/, "");
      buffer = buffer.slice(lf + 1);
      if (line.trim()) records.push(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  async function until(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
      if (Date.now() > deadline || child?.exitCode !== null) throw new Error(`${label}: ${stderr || "Pi timed out or exited"}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  async function rpc(id: string, type: string, fields: Record<string, unknown> = {}) {
    child!.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    await until(() => records.some((r) => r.type === "response" && r.id === id), id);
    const response = records.find((r) => r.type === "response" && r.id === id)!;
    assert.equal(response.success, true, response.error);
    return response;
  }
  const commands = await rpc("commands", "get_commands");
  assert.ok(commands.data.commands.some((c: { name: string }) => c.name === "jev"));
  assert.equal(apiCalls.length, 0, "loading the extension must not spend Jev requests");
  await rpc("status", "prompt", { message: "/jev status" });
  await rpc("test", "prompt", { message: "/jev test" });
  await rpc("models", "prompt", { message: "/jev models" });
  const messages = await rpc("messages", "get_messages");
  const output = JSON.stringify(messages.data);
  assert.ok(output.includes("jev-fixture"));
  assert.ok(output.includes('"automaticReview": false') || output.includes('\\"automaticReview\\": false'));
  assert.ok(!output.includes("pi-grail-smoke-fixture"));
  assert.deepEqual(apiCalls, ["/v1/systemone", "/v1/models"]);
  if (!isolated) assert.ok(commands.data.commands.some((c: { name: string }) => c.name === "subagents-guide"), "production pi-subagents must coexist with this extension");
  assert.ok(!/Extension error|Failed to load extension/.test(stderr), stderr);
  child.stdin.end();
  await until(() => child?.exitCode !== null, "shutdown");
  assert.equal(child.exitCode, 0);
  if (!isolated) {
    const exec = promisify(execFile);
    const args = ["--import", "tsx", "scripts/test-pi-live.ts"];
    const options = { env, timeout: 30_000 };
    const live = await exec(process.execPath, args, options);
    assert.equal(JSON.parse(live.stdout).passed, true, "live-test runner accepts a valid native response");
    failInference = true;
    await assert.rejects(exec(process.execPath, args, options), (error: any) => error.code === 1 && /HTTP 402/.test(error.stderr));
  }
  console.log(`PASS: production Pi (${executable}) loaded the local extension${isolated ? "" : " alongside pi-subagents"}, exposed /jev, made ${apiCalls.length} fixture API requests, and shut down cleanly.`);
} finally {
  if (child?.exitCode === null) { child.stdin.end(); child.kill("SIGTERM"); }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
