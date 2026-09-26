import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { smoke } from "../src/jev.js";

test("the real SDK uses /v1/systemone, bearer auth, native answer fields, and a sanitized failure", async () => {
  const saved = { ...process.env };
  const calls: { path?: string; auth?: string; body: unknown }[] = [];
  let unauthorized = false;
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(parts).toString("utf8")) });
    res.setHeader("content-type", "application/json");
    if (unauthorized) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Do not expose test-api-credential" }));
    } else res.end(JSON.stringify({ model: "jev-fixture", answers: { ready: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 20, output_tokens: 5 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.TYPESAFE_API_KEY = "test-api-credential";
    const response = await smoke();
    assert.equal(response.answers.ready.noul, 0.99);
    assert.equal(response.usage.input_tokens, 20);
    assert.equal(calls[0].path, "/v1/systemone");
    assert.equal(calls[0].auth, "Bearer test-api-credential");
    unauthorized = true;
    await assert.rejects(smoke(), { message: "TypeSafe request failed (HTTP 401)." });
    assert.equal(calls.length, 2, "no unrequested retries");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(smoke(controller.signal), /cancelled/);
  } finally {
    process.env = saved;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
