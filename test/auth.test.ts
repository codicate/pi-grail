import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("the key helper hides input, writes owner-only storage, and refuses to overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-grail-auth-"));
  const target = join(dir, "secrets", "key");
  const credential = "auth-helper-fixture-not-a-real-key";
  const env = { ...process.env, PI_GRAIL_API_KEY_FILE: target };
  const run = (input: string) => spawnSync(process.execPath, ["scripts/jev-auth.mjs", "--stdin"], { env, input, encoding: "utf8" });
  const saved = run(credential + "\n");
  assert.equal(saved.status, 0, saved.stderr);
  assert.ok(!(saved.stdout + saved.stderr).includes(credential));
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "secrets")).mode & 0o777, 0o700);
  assert.equal(readFileSync(target, "utf8"), credential + "\n");
  const duplicate = run("replacement-fixture\n");
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /not overwritten/);
  assert.equal(readFileSync(target, "utf8"), credential + "\n");
  const emptyTarget = join(dir, "empty-key");
  const empty = spawnSync(process.execPath, ["scripts/jev-auth.mjs", "--stdin"], {
    env: { ...env, PI_GRAIL_API_KEY_FILE: emptyTarget }, input: "\n", encoding: "utf8",
  });
  assert.equal(empty.status, 1);
  assert.equal(existsSync(emptyTarget), false);
});

test("Pi auth helper persists a fake DeepSeek credential privately and refuses overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-grail-pi-auth-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_AUTH_PROVIDER: "deepseek" };
  const key = "pi-auth-fixture-not-a-real-key";
  const run = (input: string) => spawnSync(process.execPath, ["scripts/pi-auth.mjs", "--stdin"], { env, input, encoding: "utf8" });
  const saved = run(key + "\n");
  assert.equal(saved.status, 0, saved.stderr);
  assert.ok(!(saved.stdout + saved.stderr).includes(key));
  const path = join(dir, "auth.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).deepseek, { type: "api_key", key });
  const original = readFileSync(path, "utf8");
  const duplicate = run("replacement-not-a-key\n");
  assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /not overwritten/);
  assert.equal(readFileSync(path, "utf8"), original);
  const openRouter = spawnSync(process.execPath, ["scripts/pi-auth.mjs", "--stdin"], {
    env: { ...env, PI_AUTH_PROVIDER: "openrouter" }, input: "openrouter-fixture-not-a-real-key\n", encoding: "utf8",
  });
  assert.equal(openRouter.status, 0, openRouter.stderr);
  assert.ok(!(openRouter.stdout + openRouter.stderr).includes("openrouter-fixture-not-a-real-key"));
  const credentials = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(credentials.deepseek, { type: "api_key", key });
  assert.deepEqual(credentials.openrouter, { type: "api_key", key: "openrouter-fixture-not-a-real-key" });
});
