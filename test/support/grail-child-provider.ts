import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The child smoke server is strictly local and records every outgoing model request.
export default function (pi: ExtensionAPI) {
  const baseUrl = process.env.GRAIL_FIXTURE_URL;
  if (!baseUrl?.startsWith("http://127.0.0.1:")) throw new Error("Child fixture provider requires localhost.");
  pi.registerProvider("grail-child-fixture", {
    baseUrl, api: "openai-completions", apiKey: "localhost-fixture-not-a-key",
    models: [{ id: "test", name: "Local child smoke fixture", reasoning: true, input: ["text"],
      contextWindow: 32768, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
