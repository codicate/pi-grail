// Let OpenRouter select an available route within a fixed price ceiling.
// A pinned DeepSeek route returned HTTP 404; no automatic provider fallback.
export const RUNTIME_POLICY_VERSION = "bounded-routing-low-v4-throughput";
export const SELECTOR_OUTPUT_TOKENS = 8192;
export const OPENROUTER_PROVIDER_POLICY = {
  allow_fallbacks: false,
  require_parameters: true,
  sort: "throughput",
  max_price: { prompt: 0.3, completion: 1.2 },
};

// Conservative routing ceilings. Do not assume a cache discount across routes.
// Pi's native usage.cost uses its model catalog, not the actual provider bill.
export const DEEPSEEK_ESTIMATE_PRICING = {
  inputUsdPerMillion: 0.3,
  outputUsdPerMillion: 1.2,
  cacheReadUsdPerMillion: 0.3,
};
