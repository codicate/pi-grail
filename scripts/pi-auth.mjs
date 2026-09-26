import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readSecret } from "./jev-auth.mjs";

try {
  const provider = process.env.PI_AUTH_PROVIDER?.trim() || "openrouter";
  if (!["openrouter", "deepseek"].includes(provider)) throw new Error("PI_AUTH_PROVIDER must be openrouter or deepseek.");
  const label = provider === "openrouter" ? "OpenRouter" : "DeepSeek";
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const authPath = join(agentDir, "auth.json");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const auth = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const alreadyConfigured = async () => (await auth.listCredentials()).some(c => c.providerId === provider);
  if (await alreadyConfigured()) throw new Error(`${label} credentials already exist; they were not overwritten.`);
  const key = await readSecret(`${label} API key`);
  await auth.login(provider, "api_key", {
    prompt: async () => {
      if (await alreadyConfigured()) throw new Error(`${label} credentials already exist; they were not overwritten.`);
      return key;
    },
    notify: () => {},
  });
  await chmod(authPath, 0o600);
  console.log(`Saved ${label} credentials to Pi's owner-only auth store. Run npm run grail:status, then npm run test:grail:live.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Pi auth setup failed.");
  process.exitCode = 1;
}
