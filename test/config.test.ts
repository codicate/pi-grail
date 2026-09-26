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

test("the package .env is refreshed on each read, with environment precedence and secret-free status", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-grail-dotenv-"));
  const envFile = join(dir, ".env");
  const saved = process.env.TYPESAFE_API_KEY;
  try {
    delete process.env.TYPESAFE_API_KEY;
    writeFileSync(envFile, 'TYPESAFE_API_KEY="dotenv-fixture-key"\nPI_GRAIL_JEV_MODEL=jev-latest\n', { mode: 0o600 });
    const first = readConfig(undefined, envFile);
    assert.equal(first.apiKey, "dotenv-fixture-key");
    assert.equal(first.keySource, "dotenv");
    assert.ok(!JSON.stringify(publicConfig(first)).includes("dotenv-fixture-key"));
    writeFileSync(envFile, "TYPESAFE_API_KEY=rotated-fixture-key\n");
    assert.equal(readConfig(undefined, envFile).apiKey, "rotated-fixture-key");
    process.env.TYPESAFE_API_KEY = "environment-fixture-key";
    assert.equal(readConfig(undefined, envFile).keySource, "environment");
    assert.equal(readConfig(undefined, envFile).apiKey, "environment-fixture-key");
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  }
});
