import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publicConfig, readConfig } from "../src/config.js";

test("key-file fallback and environment override never expose a credential in public status", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-grail-config-"));
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, "test-file-credential\n", { mode: 0o600 });
  const fromFile = readConfig({ PI_GRAIL_API_KEY_FILE: keyFile });
  assert.equal(fromFile.apiKey, "test-file-credential");
  assert.equal(fromFile.keySource, "file");
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const fromEnv = readConfig({ PI_GRAIL_API_KEY_FILE: keyFile, TYPESAFE_API_KEY: "test-env-credential" });
  assert.equal(fromEnv.keySource, "environment");
  assert.equal(fromEnv.apiKey, "test-env-credential");
  assert.ok(!JSON.stringify(publicConfig(fromFile)).includes("test-file-credential"));
  assert.ok(!JSON.stringify(publicConfig(fromEnv)).includes("test-env-credential"));
});

test("a missing key stays unconfigured, and accidental /v1 endpoint duplication is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-grail-missing-"));
  assert.equal(publicConfig(readConfig({ PI_GRAIL_API_KEY_FILE: join(dir, "absent") })).configured, false);
  assert.throws(() => readConfig({ TYPESAFE_BASE_URL: "https://api.typesafe.ai/v1" }), /omit \/v1/);
  assert.throws(() => readConfig({ TYPESAFE_BASE_URL: "not-a-url" }), /valid HTTP\(S\) API root/);
});
