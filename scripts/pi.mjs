import { spawnSync } from "node:child_process";
import { productionPi } from "./production-pi.mjs";

const result = spawnSync(productionPi(), process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
