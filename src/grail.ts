import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { SubagentDelegationThinking } from "pi-subagents/delegation";
import type { GrailDelegationResponse } from "./delegation.js";
import type { NativeTelemetry } from "./live.js";
import { evaluate } from "./jev.js";
import {
  CONTROL_SIGNAL_CONTRACT, CONTROL_SYSTEM_PROMPT, SIGNAL_IDS, controlTask, digest, jevPromptContract, jevRequest,
  judgmentContract, parseControl, parseOutcome, preparePacket, rawReferences, reviewerTask, reviewTarget,
  type JevPromptOptions, type Outcome, type Packet, type Selector, type SignalId,
} from "./selector.js";

export interface LeafInput { agent: string; task: string; nodeId: string; selector: boolean }
export interface HarnessDependencies {
  evaluate: typeof evaluate;
  leaf: (input: LeafInput) => Promise<GrailDelegationResponse>;
}
export interface ClassifyOptions extends JevPromptOptions {}
export interface GrailHashes {
  packetHash: string | null;
  judgmentHash: string | null;
  selectorPromptHash: string;
}
export interface SelectorResult {
  source: Selector;
  model?: string;
  usage: unknown | null;
  reasoningTokens?: number | null;
  reasoningUsageNote?: string;
  nativeTelemetry?: NativeTelemetry | null;
  answers?: Partial<Record<SignalId, unknown>>;
  rawOutput?: string;
  terminalStatus?: string;
  runId?: string;
  thinking?: string;
  error?: string;
}
export interface ClassifyResult {
  version: 1;
  runId: string;
  selector: Selector;
  perSignal: Record<SignalId, Outcome>;
  status: Outcome;
  investigate: boolean;
  rawReferences: string[];
  hashes: GrailHashes;
  packetHash: string | null;
  judgmentHash: string | null;
  selectorPromptVersion: string;
  selectorInvocations: number;
  reviewInvocations: 0;
  selectorResult: SelectorResult;
  latencyMs: number;
  reason?: string;
}

const CONTROL_PROMPT_VERSION = "control-v1";
const CONTROL_PROMPT_HASH = digest({ system: CONTROL_SYSTEM_PROMPT, signals: CONTROL_SIGNAL_CONTRACT,
  output: "One strict JSON object with exactly the three signal IDs and one allowed outcome per ID." });
const INSUFFICIENT: Record<SignalId, Outcome> = {
  instruction_drift: "INSUFFICIENT_INPUT",
  unverified_assumption: "INSUFFICIENT_INPUT",
  evidence_leap: "INSUFFICIENT_INPUT",
};

function leafText(response: GrailDelegationResponse) {
  if (response.status !== "completed" || !("result" in response) || response.result?.kind !== "text") {
    throw new Error(`Grail subagent did not complete (${response.status}).`);
  }
  return response.result.text;
}
function leafMeta(response: GrailDelegationResponse): SelectorResult {
  const nativeTelemetry = response.nativeTelemetry ?? null;
  const reasoningUsageNote = nativeTelemetry?.source === "pi_native_normalized"
    ? "Pi-native-normalized reasoning tokens are a subset of outputTokens; they are recorded separately from delegation usage."
    : "Native reasoning usage is unavailable, not zero.";
  if (!("usage" in response)) return { source: "subagent", terminalStatus: response.status, usage: null,
    reasoningTokens: nativeTelemetry?.reasoningTokens ?? null, reasoningUsageNote, nativeTelemetry };
  return { source: "subagent", terminalStatus: response.status, runId: response.runId,
    model: response.model, thinking: response.thinking, usage: response.usage ?? null,
    reasoningTokens: nativeTelemetry?.reasoningTokens ?? null, reasoningUsageNote, nativeTelemetry };
}
function aggregate(perSignal: Record<SignalId, Outcome>): Outcome {
  if (SIGNAL_IDS.some(id => perSignal[id] === "FLAG")) return "FLAG";
  if (SIGNAL_IDS.some(id => perSignal[id] === "INSUFFICIENT_INPUT")) return "INSUFFICIENT_INPUT";
  return "NO_VISIBLE_SIGNAL";
}
function selectorPromptHash(selector: Selector, options: ClassifyOptions) {
  return selector === "jev" ? digest(jevPromptContract(options)) : CONTROL_PROMPT_HASH;
}
function invalidResult(value: unknown, selector: Selector, options: ClassifyOptions, reason: string): ClassifyResult {
  const jev = selector === "jev";
  const selectorPromptVersion = jev ? (options.jevPromptVersion ?? "baseline-v1") : CONTROL_PROMPT_VERSION;
  return {
    version: 1, runId: randomUUID(), selector, perSignal: { ...INSUFFICIENT }, status: "INSUFFICIENT_INPUT",
    investigate: false, rawReferences: [], hashes: { packetHash: null, judgmentHash: null, selectorPromptHash: selectorPromptHash(selector, options) },
    packetHash: null, judgmentHash: null, selectorPromptVersion, selectorInvocations: 0, reviewInvocations: 0,
    selectorResult: { source: selector, usage: null, error: reason }, latencyMs: 0, reason,
  };
}

/** Run exactly one selector request/leaf for the three independent signal judgments; never invoke the reviewer. */
export async function classifyGrail(value: unknown, selector: Selector, deps: HarnessDependencies,
  signal?: AbortSignal, options: ClassifyOptions = {}): Promise<ClassifyResult> {
  const prepared = preparePacket(value);
  if (!prepared.packet) return invalidResult(value, selector, options, prepared.error ?? "Invalid packet.");
  const packet: Packet = prepared.packet;
  const packetHash = digest(packet);
  const judgmentHash = digest(judgmentContract(packet));
  const hashes: GrailHashes = { packetHash, judgmentHash, selectorPromptHash: selectorPromptHash(selector, options) };
  const selectorPromptVersion = selector === "jev" ? (options.jevPromptVersion ?? "baseline-v1") : CONTROL_PROMPT_VERSION;
  const base = {
    version: 1 as const, runId: randomUUID(), selector, rawReferences: rawReferences(packet), hashes,
    packetHash, judgmentHash, selectorPromptVersion,
  };
  let perSignal: Record<SignalId, Outcome>;
  let selectorResult: SelectorResult = { source: selector, usage: null };
  const started = performance.now();
  try {
    if (selector === "jev") {
      const response = await deps.evaluate(jevRequest(packet, options), signal);
      const answers = response.answers as Partial<Record<SignalId, unknown>>;
      perSignal = { ...INSUFFICIENT };
      const invalid: SignalId[] = [];
      for (const id of SIGNAL_IDS) {
        try {
          const answer = answers[id] as { choice?: unknown } | undefined;
          perSignal[id] = parseOutcome(answer?.choice);
        } catch { invalid.push(id); }
      }
      selectorResult = { source: "jev", model: response.model, usage: response.usage, answers,
        reasoningTokens: null, reasoningUsageNote: "TypeSafe usage reports input and output tokens only." };
      if (invalid.length) selectorResult.error = `Invalid or missing answer for: ${invalid.join(", ")}.`;
    } else {
      const response = await deps.leaf({ agent: "grail-selector", task: controlTask(packet), nodeId: "selector", selector: true });
      selectorResult = leafMeta(response);
      const output = leafText(response);
      selectorResult.rawOutput = output;
      perSignal = parseControl(output);
    }
  } catch {
    const latencyMs = Math.max(0, performance.now() - started);
    const reason = "Selector failed, was cancelled, or returned invalid output; no clean judgment is available.";
    selectorResult.error = reason;
    return { ...base, perSignal: { ...INSUFFICIENT }, status: "INSUFFICIENT_INPUT", investigate: false,
      selectorInvocations: 1, reviewInvocations: 0, selectorResult, latencyMs, reason };
  }
  const status = aggregate(perSignal);
  return { ...base, perSignal, status, investigate: status === "FLAG", selectorInvocations: 1,
    reviewInvocations: 0, selectorResult, latencyMs: Math.max(0, performance.now() - started) };
}

export type GrailRunResult = Omit<ClassifyResult, "reviewInvocations"> & {
  reviewInvocations: number;
  target: ReturnType<typeof reviewTarget> | null;
  reviewerTaskHash?: string;
  reviewer?: Record<string, unknown>;
};

/** Run the selector-only gate, then invoke the shared reviewer once if any signal is flagged. */
export async function runGrail(value: unknown, selector: Selector, deps: HarnessDependencies,
  signal?: AbortSignal, options: ClassifyOptions = {}): Promise<GrailRunResult> {
  const result = await classifyGrail(value, selector, deps, signal, options);
  const prepared = result.investigate ? preparePacket(value) : undefined;
  if (!prepared?.packet) return { ...result, target: null };
  const packet = prepared.packet;
  const task = reviewerTask(packet, result.perSignal);
  const target = reviewTarget(packet, result.perSignal);
  let reviewerResult: Record<string, unknown> = { source: "subagent", usage: null, reasoningTokens: null };
  try {
    const response = await deps.leaf({ agent: "grail-reviewer", task, nodeId: "reviewer", selector: false });
    reviewerResult = { ...leafMeta(response) };
    reviewerResult.text = leafText(response);
  } catch {
    reviewerResult.error = "Reviewer failed or was cancelled; the FLAG remains unresolved.";
  }
  return { ...result, reviewInvocations: 1, target, reviewerTaskHash: digest(task), reviewer: reviewerResult };
}

export function selectorMode(value: unknown): Selector {
  if (value !== "jev" && value !== "subagent") throw new Error("--grail-selector must be jev (experiment) or subagent (control).");
  return value;
}
export function thinkingLevel(value: unknown): SubagentDelegationThinking {
  if (typeof value !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new Error("Invalid --grail-thinking level.");
  }
  return value as SubagentDelegationThinking;
}
