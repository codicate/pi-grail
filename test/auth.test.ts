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
