import { listModels, smoke, status } from "../src/jev.js";

try {
  const command = process.argv[2] || "status";
  let data: unknown;
  if (command === "status") data = status();
  else if (command === "models") data = await listModels();
  else if (command === "test") data = await smoke();
  else throw new Error("Use status, models, or test.");
  console.log(JSON.stringify(data, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Jev request failed.");
  process.exitCode = 1;
}
