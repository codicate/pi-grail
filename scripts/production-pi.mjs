import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function productionPi() {
  const prefix = execFileSync("npm", ["prefix", "--global"], { encoding: "utf8" }).trim();
  const executable = join(prefix, "bin", "pi");
  if (!existsSync(executable)) throw new Error("Install the production CLI: npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
  return executable;
}
