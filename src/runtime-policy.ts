// Let OpenRouter select an available route for the requested model. Fallbacks are
// OpenRouter-managed routes under the same account/key; this is not a new provider
// integration. Cost remains telemetry only and does not constrain routing.
export const RUNTIME_POLICY_VERSION = "openrouter-routing-low-v5-fallbacks";
export const SELECTOR_OUTPUT_TOKENS = 8192;
export const OPENROUTER_PROVIDER_POLICY = {
  allow_fallbacks: true,
  require_parameters: true,
};

// Conservative routing ceilings. Do not assume a cache discount across routes.
// Pi's native usage.cost uses its model catalog, not the actual provider bill.
export const DEEPSEEK_ESTIMATE_PRICING = {
  inputUsdPerMillion: 0.3,
  outputUsdPerMillion: 1.2,
  cacheReadUsdPerMillion: 0.3,
};
