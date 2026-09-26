import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";

export async function hiddenInput(label = "TypeSafe API key") {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Use an interactive terminal, or --stdin with a password-manager pipe.");
  }
  process.stdout.write(`${label} (hidden): `);
  const wasRaw = process.stdin.isRaw;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolveKey, reject) => {
    let key = "";
    function finish(error) {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolveKey(key);
    }
    function onKey(text, press) {
      if (press?.ctrl && press.name === "c") finish(new Error("Cancelled; no key saved."));
      else if (press?.name === "return" || press?.name === "enter") finish();
      else if (press?.name === "backspace") key = key.slice(0, -1);
      else if (text && !press?.ctrl && !press?.meta && !/[\x00-\x1f\x7f]/.test(text)) key += text;
    }
    process.stdin.on("keypress", onKey);
  });
}

export async function readSecret(label) {
  if (process.argv.slice(2).some((arg) => arg !== "--stdin")) throw new Error("Only --stdin is supported; never pass a key as an argument.");
  let key;
  if (process.argv.includes("--stdin")) {
    if (process.stdin.isTTY) throw new Error("--stdin requires a pipe; omit it for hidden terminal input.");
    const parts = [];
    for await (const chunk of process.stdin) parts.push(chunk);
    key = Buffer.concat(parts).toString("utf8");
  } else key = await hiddenInput(label);
  key = key.trim();
  if (!key || /\s/.test(key)) throw new Error("The key must be a nonempty value without whitespace.");
  return key;
}

// Keep importable secret-input helpers separate from this executable's side effects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  if (process.argv.slice(2).some((arg) => arg !== "--stdin")) throw new Error("Only --stdin is supported; never pass a key as an argument.");
  const key = await readSecret("TypeSafe API key");
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const target = resolve(process.env.PI_GRAIL_API_KEY_FILE?.trim() || join(agentDir, "secrets", "typesafe_api_key"));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, key + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Saved to ${target} (owner-only). Run npm run jev:models or npm run jev:test.`);
} catch (error) {
  console.error(error?.code === "EEXIST" ? "A key file already exists; it was not overwritten. Use TYPESAFE_API_KEY to override it." : error instanceof Error ? error.message : "Key setup failed.");
  process.exitCode = 1;
}
