import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { productionPi } from "./production-pi.mjs";

export async function grailPi(selector: string, command = "/grail smoke", extraArgs: string[] = [], env = process.env) {
  const running = promisify(execFile)(productionPi(), [
    "--approve", "--offline", "--no-session", "--mode", "json", "--grail-selector", selector,
    ...extraArgs, "-p", command,
  ], { env, cwd: process.cwd(), timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  running.child.stdin?.end();
  const { stdout } = await running;
  const records = stdout.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  const message = records.find(record => record.type === "message_end" && record.message?.customType === "pi-grail-check");
  if (!message) throw new Error("Production Pi did not emit a Grail harness result.");
  if (message.message.details?.error) throw new Error(message.message.details.error);
  return message.message.details;
}
