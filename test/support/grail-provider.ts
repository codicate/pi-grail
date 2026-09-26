import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Only loaded explicitly by the localhost smoke runner; never a production arm.
export default function (pi: ExtensionAPI) {
  const baseUrl = process.env.GRAIL_FIXTURE_URL;
  if (!baseUrl?.startsWith("http://127.0.0.1:")) throw new Error("Fixture provider requires localhost.");
  pi.registerProvider("grail-fixture", {
    baseUrl, api: "openai-completions", apiKey: "localhost-fixture-not-a-key",
    models: [{ id: "test", name: "Local smoke fixture", reasoning: false, input: ["text"],
      contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
