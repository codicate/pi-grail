import { createHash } from "node:crypto";

export const SIGNAL_IDS = ["instruction_drift", "unverified_assumption", "evidence_leap"] as const;
export const OUTCOMES = ["FLAG", "NO_VISIBLE_SIGNAL", "INSUFFICIENT_INPUT"] as const;
export type SignalId = typeof SIGNAL_IDS[number];
export type Outcome = typeof OUTCOMES[number];
export type Selector = "jev" | "subagent";
export type Packet = {
  version: 1;
  workerId: string;
  contextComplete: true;
  handoff: { ref: string; text: string };
  instructionUpdates: Array<{ ref: string; text: string; authorized: true }>;
  latestTurn: { ref: string; text: string };
};
export type BenchmarkCase = { id: string; focus: SignalId; packet: Packet };
export type GoldLabels = Record<string, Record<SignalId, Outcome>>;

export const PACKING_VERSION = "packet-v1-json-utf8-16k-no-truncate";
export const SCORING_VERSION = "per-signal-exact-and-aggregate-investigate-v1";
export const PRICES = {
  snapshotDate: "2026-09-26",
  selector: "openrouter/deepseek/deepseek-v4.1-flash",
  selectorSource: "OpenRouter model pricing API checked 2026-09-26",
  selectorInputUsdPerMillion: 0.035,
  selectorCachedInputUsdPerMillion: 0.001,
  selectorOutputUsdPerMillion: 0.29,
  jevModel: "jev-1.13.0",
  jevSource: "TypeSafe models API checked 2026-09-26",
  jevInputUsdPerMillion: 0.042,
  jevCachedInputUsdPerMillion: 0.042,
  jevOutputUsdPerMillion: 0,
} as const;

export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + stable(object[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

export function hash(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export type NormalizedUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  reasoningIsOutputSubset: true;
};

export function normalizeUsage(value: unknown): NormalizedUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const promptDetails = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
  const completionDetails = (usage.completion_tokens_details ?? usage.output_tokens_details) as Record<string, unknown> | undefined;
  const providerInput = finiteNumber(usage.prompt_tokens, usage.promptTokens, usage.input_tokens);
  const piInput = finiteNumber(usage.input, usage.inputTokens);
  const outputTokens = finiteNumber(usage.output, usage.outputTokens, usage.completion_tokens, usage.completionTokens, usage.output_tokens);
  const cachedInputTokens = finiteNumber(usage.cacheRead, usage.cachedInputTokens, promptDetails?.cached_tokens, usage.cached_tokens);
  const cacheWriteTokens = finiteNumber(usage.cacheWrite, usage.cacheWriteTokens, promptDetails?.cache_write_tokens);
  const reasoningTokens = finiteNumber(usage.reasoning, usage.reasoningTokens, completionDetails?.reasoning_tokens, usage.reasoning_tokens);
  // OpenRouter prompt_tokens already includes cached tokens. Pi's native input
  // omits cacheRead/cacheWrite, so add both exactly once for canonical input.
  const inputTokens = providerInput ?? (piInput === null ? null : piInput + (cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0));
  const totalTokens = inputTokens !== null && outputTokens !== null
    ? inputTokens + outputTokens : finiteNumber(usage.totalTokens, usage.total_tokens);
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens, totalTokens, reasoningIsOutputSubset: true };
}

export function computedCost(selector: Selector, usage: NormalizedUsage | null): { usd: number | null; provenance: string } {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) {
    return { usd: null, provenance: "unavailable-usage" };
  }
  const jev = selector === "jev";
  const inputRate = jev ? PRICES.jevInputUsdPerMillion : PRICES.selectorInputUsdPerMillion;
  const cachedRate = jev ? PRICES.jevCachedInputUsdPerMillion : PRICES.selectorCachedInputUsdPerMillion;
  const outputRate = jev ? PRICES.jevOutputUsdPerMillion : PRICES.selectorOutputUsdPerMillion;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const nonCached = usage.inputTokens - cached;
  const usd = (nonCached * inputRate + cached * cachedRate + usage.outputTokens * outputRate) / 1_000_000;
  const cacheNote = usage.cachedInputTokens === null ? "; cached-read count unavailable, full input charged at standard input rate" : "";
  return { usd, provenance: "estimated-from-" + PRICES.snapshotDate + "-price-snapshot" + cacheNote };
}

export function reservationUpperBound(selector: Selector, promptUtf8Bytes: number, outputTokenCap: number,
  protocolHeadroomTokens = 8_192): number {
  // One UTF-8 byte per possible input token is conservative for source text. The
  // additional protocol allowance covers fixed system/schema wrappers.
  const jev = selector === "jev";
  const inputRate = jev ? PRICES.jevInputUsdPerMillion : PRICES.selectorInputUsdPerMillion;
  const outputRate = jev ? PRICES.jevOutputUsdPerMillion : PRICES.selectorOutputUsdPerMillion;
  return ((promptUtf8Bytes + protocolHeadroomTokens) * inputRate + outputTokenCap * outputRate) / 1_000_000;
}

function ratio(correct: number, total: number) { return total ? correct / total : null; }
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export type ScoredRow = {
  caseId: string;
  selector: Selector;
  gold: Record<SignalId, Outcome>;
  actual: Record<SignalId, Outcome> | null;
  investigate: boolean | null;
  costUsd: number | null;
  costUpperBoundUsd: number | null;
  latencyMs: number | null;
  failure?: string;
};

export function score(rows: ScoredRow[]) {
  const bySignal = Object.fromEntries(SIGNAL_IDS.map(signal => {
    const valid = rows.filter(row => row.actual !== null);
    const correct = valid.filter(row => row.actual![signal] === row.gold[signal]).length;
    return [signal, { correct, total: rows.length, evaluated: valid.length, accuracy: ratio(correct, rows.length),
      statusCounts: Object.fromEntries(OUTCOMES.map(status => [status, {
        expected: rows.filter(row => row.gold[signal] === status).length,
        actual: valid.filter(row => row.actual![signal] === status).length,
      }])) }];
  })) as Record<SignalId, unknown>;
  const investCorrect = rows.filter(row => row.investigate !== null && row.investigate === Object.values(row.gold).includes("FLAG")).length;
  const investMissed = rows.filter(row => Object.values(row.gold).includes("FLAG") && row.investigate !== true).length;
  const unnecessary = rows.filter(row => !Object.values(row.gold).includes("FLAG") && row.investigate === true).length;
  const exactCosts = rows.map(row => row.costUsd).filter((cost): cost is number => cost !== null);
  const upperBounds = rows.map(row => row.costUpperBoundUsd).filter((cost): cost is number => cost !== null);
  const latencies = rows.map(row => row.latencyMs).filter((latency): latency is number => latency !== null);
  return {
    cases: rows.length,
    investigation: { correct: investCorrect, total: rows.length, accuracy: ratio(investCorrect, rows.length),
      missedInvestigations: investMissed, unnecessaryInvestigations: unnecessary },
    bySignal,
    insufficientSignalCount: rows.reduce((sum, row) => sum + (row.actual ? SIGNAL_IDS.filter(id => row.actual![id] === "INSUFFICIENT_INPUT").length : 0), 0),
    failedCallCount: rows.filter(row => Boolean(row.failure)).length,
    latencyMs: { observed: latencies.length, unknown: rows.length - latencies.length,
      mean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null, median: median(latencies) },
    costUsd: { observed: exactCosts.length, unknown: rows.length - exactCosts.length,
      meanObserved: exactCosts.length ? exactCosts.reduce((a, b) => a + b, 0) / exactCosts.length : null,
      totalObserved: exactCosts.length ? exactCosts.reduce((a, b) => a + b, 0) : null,
      totalUpperBound: upperBounds.length === rows.length ? upperBounds.reduce((a, b) => a + b, 0) : null,
      meanUpperBound: upperBounds.length === rows.length ? upperBounds.reduce((a, b) => a + b, 0) / rows.length : null },
  };
}

export function controlCacheKey(args: {
  dataset: unknown;
  labels: unknown;
  controlPrompt: unknown;
  sharedLogicSourceHash: string;
  runtimeVersions: unknown;
  model: string;
  thinking: string;
  limits: unknown;
}) {
  return hash({ dataset: args.dataset, labels: args.labels, controlPrompt: args.controlPrompt,
    sharedLogicSourceHash: args.sharedLogicSourceHash,
    packing: PACKING_VERSION, scoring: SCORING_VERSION, runtimeVersions: args.runtimeVersions,
    model: args.model, thinking: args.thinking, limits: args.limits });
}
