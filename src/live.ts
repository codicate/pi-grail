import { createHash, randomUUID } from "node:crypto";

export type LiveRole = "grail-worker" | "grail-selector" | "grail-reviewer";
export type LiveSignalId = "instruction_drift" | "unverified_assumption" | "evidence_leap";
export type LiveOutcome = "FLAG" | "NO_VISIBLE_SIGNAL" | "INSUFFICIENT_INPUT";
export type LiveRecord = { ref: string; text: string };
export type LiveUpdate = LiveRecord & { authorized: true };

export interface NativeTelemetry {
  source: "pi_native_normalized" | "unavailable";
  assistantMessages: number;
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export interface LiveLaunchEnvelope {
  version: 1;
  launchId: string;
  parentRunId: string;
  workerId: string;
  role: LiveRole;
  handoff: LiveRecord;
  instructionUpdates: LiveUpdate[];
  rawTask: string;
}

export interface LiveClassification {
  status?: LiveOutcome;
  investigate?: boolean;
  perSignal?: Partial<Record<LiveSignalId, LiveOutcome>>;
  rawReferences?: string[];
  selectorInvocations?: number;
  latencyMs?: number;
  selectorResult?: unknown;
  [key: string]: unknown;
}

export interface LiveObservation {
  packet: unknown;
  record: LiveRecord;
  result: LiveClassification;
}

export interface LiveTelemetry {
  role: LiveRole;
  launchId: string;
  workerId: string;
  status: "active" | "completed" | "failed" | "limit_exhausted";
  stopReason?: string;
  providerRequests: number;
  blockedProviderRequests: number;
  assistantResponses: number;
  checkpoints: number;
  toolCalls: number;
  flaggedToolCallsBlocked: number;
  reviewerCalls: number;
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  reasoningUsageAvailable: boolean;
  reasoningUsageProvenance: "pi_native_normalized" | "unavailable";
  nativeAssistantMessages: number;
  checkpointDecisions: Array<{
    ref: string;
    status: LiveOutcome;
    perSignal: Partial<Record<LiveSignalId, LiveOutcome>>;
    rawReferences: string[];
    selectorInvocations: number;
    latencyMs: number | null;
    selectorResult: unknown | null;
  }>;
  /** Full selector results (including provider-native Jev usage) for each checkpoint. */
  gateResults: LiveClassification[];
  reviewerFeedback: Array<{ status: string; text: string; rawReferences: string[] }>;
}

export interface LiveLaunchRuntime {
  envelope: LiveLaunchEnvelope;
  startedAt: number;
  maxDurationMs: number;
  maxProviderRequests: number;
  maxCheckpoints: number;
  maxReadonlyToolCalls: number;
  classify?: (packet: unknown, record: LiveRecord) => Promise<LiveClassification>;
  review?: (
    packet: unknown,
    perSignal: Partial<Record<LiveSignalId, LiveOutcome>>,
    observations: LiveObservation[],
  ) => Promise<{ status: string; text: string; rawReferences?: string[] }>;
  telemetry: LiveTelemetry;
  nativeUsageKnown: { input: boolean; output: boolean; cacheRead: boolean; cacheWrite: boolean; reasoning: boolean };
  nativeUsageSums: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  responseRecords: LiveObservation[];
  responseFlags: Set<LiveSignalId>;
  responseCheckpointHashes: Set<string>;
  blockedToolCalls: Set<string>;
  responseIndex: number;
}

interface LiveRegistry {
  version: 1;
  launches: Map<string, LiveLaunchRuntime>;
}

const REGISTRY_SYMBOL = Symbol.for("pi-grail.live-registry.v1");
const ENVELOPE_PREFIX = "[[PI_GRAIL_CHILD_V1:";
const ENVELOPE_SUFFIX = "]]";

function processRegistry(): LiveRegistry {
  const global = globalThis as unknown as Record<PropertyKey, unknown>;
  let value = global[REGISTRY_SYMBOL] as LiveRegistry | undefined;
  if (!value || value.version !== 1 || !(value.launches instanceof Map)) {
    value = { version: 1, launches: new Map() };
    global[REGISTRY_SYMBOL] = value;
  }
  return value;
}

export function createLiveLaunch(input: Omit<LiveLaunchEnvelope, "version" | "launchId"> & { launchId?: string }, limits: {
  maxDurationMs: number;
  maxProviderRequests: number;
  maxCheckpoints?: number;
  maxReadonlyToolCalls?: number;
  classify?: LiveLaunchRuntime["classify"];
  review?: LiveLaunchRuntime["review"];
}): LiveLaunchRuntime {
  const launchId = input.launchId ?? randomUUID();
  const envelope: LiveLaunchEnvelope = { version: 1, launchId, ...input };
  const runtime: LiveLaunchRuntime = {
    envelope,
    startedAt: Date.now(),
    maxDurationMs: limits.maxDurationMs,
    maxProviderRequests: limits.maxProviderRequests,
    maxCheckpoints: limits.maxCheckpoints ?? 0,
    maxReadonlyToolCalls: limits.maxReadonlyToolCalls ?? 0,
    classify: limits.classify,
    review: limits.review,
    telemetry: {
      role: envelope.role,
      launchId,
      workerId: envelope.workerId,
      status: "active",
      providerRequests: 0,
      blockedProviderRequests: 0,
      assistantResponses: 0,
      checkpoints: 0,
      toolCalls: 0,
      flaggedToolCallsBlocked: 0,
      reviewerCalls: 0,
      uncachedInputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      reasoningUsageAvailable: false,
      reasoningUsageProvenance: "unavailable",
      nativeAssistantMessages: 0,
      checkpointDecisions: [],
      gateResults: [],
      reviewerFeedback: [],
    },
    nativeUsageKnown: { input: true, output: true, cacheRead: true, cacheWrite: true, reasoning: true },
    nativeUsageSums: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    responseRecords: [],
    responseFlags: new Set(),
    responseCheckpointHashes: new Set(),
    blockedToolCalls: new Set(),
    responseIndex: 0,
  };
  processRegistry().launches.set(launchId, runtime);
  return runtime;
}

export function getLiveLaunch(launchId: string): LiveLaunchRuntime | undefined {
  return processRegistry().launches.get(launchId);
}

export function removeLiveLaunch(launchId: string) {
  processRegistry().launches.delete(launchId);
}

export function snapshotLiveTelemetry(runtime: LiveLaunchRuntime): LiveTelemetry {
  const telemetry = runtime.telemetry;
  const hasUsage = telemetry.nativeAssistantMessages > 0;
  return {
    ...telemetry,
    uncachedInputTokens: hasUsage && runtime.nativeUsageKnown.input ? runtime.nativeUsageSums.input : null,
    outputTokens: hasUsage && runtime.nativeUsageKnown.output ? runtime.nativeUsageSums.output : null,
    cacheReadTokens: hasUsage && runtime.nativeUsageKnown.cacheRead ? runtime.nativeUsageSums.cacheRead : null,
    cacheWriteTokens: hasUsage && runtime.nativeUsageKnown.cacheWrite ? runtime.nativeUsageSums.cacheWrite : null,
    reasoningTokens: hasUsage && runtime.nativeUsageKnown.reasoning ? runtime.nativeUsageSums.reasoning : null,
    reasoningUsageAvailable: hasUsage && runtime.nativeUsageKnown.reasoning,
    reasoningUsageProvenance: hasUsage && runtime.nativeUsageKnown.reasoning ? "pi_native_normalized" : "unavailable",
    checkpointDecisions: telemetry.checkpointDecisions.map(value => ({ ...value,
      perSignal: { ...value.perSignal }, rawReferences: [...value.rawReferences] })),
    gateResults: telemetry.gateResults.map(value => ({ ...value,
      perSignal: value.perSignal ? { ...value.perSignal } : undefined,
      rawReferences: value.rawReferences ? [...value.rawReferences] : undefined })),
    reviewerFeedback: telemetry.reviewerFeedback.map(value => ({ ...value, rawReferences: [...value.rawReferences] })),
  };
}

export function snapshotNativeTelemetry(runtime: LiveLaunchRuntime): NativeTelemetry {
  const hasUsage = runtime.telemetry.nativeAssistantMessages > 0;
  return {
    source: hasUsage ? "pi_native_normalized" : "unavailable",
    assistantMessages: runtime.telemetry.nativeAssistantMessages,
    uncachedInputTokens: hasUsage && runtime.nativeUsageKnown.input ? runtime.nativeUsageSums.input : null,
    outputTokens: hasUsage && runtime.nativeUsageKnown.output ? runtime.nativeUsageSums.output : null,
    cacheReadTokens: hasUsage && runtime.nativeUsageKnown.cacheRead ? runtime.nativeUsageSums.cacheRead : null,
    cacheWriteTokens: hasUsage && runtime.nativeUsageKnown.cacheWrite ? runtime.nativeUsageSums.cacheWrite : null,
    reasoningTokens: hasUsage && runtime.nativeUsageKnown.reasoning ? runtime.nativeUsageSums.reasoning : null,
  };
}

export function encodeLaunchTask(envelope: LiveLaunchEnvelope): string {
  const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return `${ENVELOPE_PREFIX}${encoded}${ENVELOPE_SUFFIX}`;
}

export function decodeLaunchTask(text: string): LiveLaunchEnvelope | undefined {
  if (!text.startsWith(ENVELOPE_PREFIX)) return undefined;
  const end = text.indexOf(ENVELOPE_SUFFIX, ENVELOPE_PREFIX.length);
  if (end < 0 || end + ENVELOPE_SUFFIX.length !== text.length) return undefined;
  try {
    const decoded = Buffer.from(text.slice(ENVELOPE_PREFIX.length, end), "base64url").toString("utf8");
    const value = JSON.parse(decoded) as Partial<LiveLaunchEnvelope>;
    if (value.version !== 1 || typeof value.launchId !== "string" || typeof value.parentRunId !== "string"
      || typeof value.workerId !== "string" || typeof value.rawTask !== "string"
      || !["grail-worker", "grail-selector", "grail-reviewer"].includes(value.role ?? "")
      || !value.handoff || typeof value.handoff.ref !== "string" || typeof value.handoff.text !== "string"
      || !Array.isArray(value.instructionUpdates)
      || value.instructionUpdates.some(update => !update || update.authorized !== true
        || typeof update.ref !== "string" || typeof update.text !== "string")) return undefined;
    return value as LiveLaunchEnvelope;
  } catch {
    return undefined;
  }
}

export function isLiveWorkerRole(role: string): role is "grail-worker" {
  return role === "grail-worker";
}

/** Identify repeated semantic checkpoint input independent of its transport ref. */
export function semanticCheckpointFingerprint(handoff: LiveRecord, updates: LiveUpdate[], record: LiveRecord) {
  return createHash("sha256").update(JSON.stringify({ handoff, instructionUpdates: updates, latestTurnText: record.text })).digest("hex");
}

export function isReadonlyReviewTool(toolName: string) {
  return toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls";
}

export function clampProviderPayload(payload: unknown, cap: number): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const request = { ...(payload as Record<string, unknown>) };
  const key = typeof request.max_completion_tokens === "number" || "max_completion_tokens" in request
    ? "max_completion_tokens" : "max_tokens";
  const current = request[key];
  request[key] = typeof current === "number" && Number.isFinite(current) && current > 0
    ? Math.min(current, cap) : cap;
  return request;
}

export function addNativeUsage(runtime: LiveLaunchRuntime, message: unknown) {
  const value = message && typeof message === "object" ? message as { role?: unknown; usage?: unknown } : undefined;
  if (value?.role !== "assistant") return;
  runtime.telemetry.nativeAssistantMessages += 1;
  const usage = value.usage && typeof value.usage === "object" ? value.usage as Record<string, unknown> : {};
  const numeric = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && (usage[key] as number) >= 0
    ? usage[key] as number : undefined;
  const input = numeric("input"), output = numeric("output"), reasoning = numeric("reasoning");
  const cacheRead = numeric("cacheRead"), cacheWrite = numeric("cacheWrite");
  if (input === undefined) runtime.nativeUsageKnown.input = false;
  else runtime.nativeUsageSums.input += input;
  if (output === undefined) runtime.nativeUsageKnown.output = false;
  else runtime.nativeUsageSums.output += output;
  if (cacheRead === undefined) runtime.nativeUsageKnown.cacheRead = false;
  else runtime.nativeUsageSums.cacheRead += cacheRead;
  if (cacheWrite === undefined) runtime.nativeUsageKnown.cacheWrite = false;
  else runtime.nativeUsageSums.cacheWrite += cacheWrite;
  if (reasoning === undefined) runtime.nativeUsageKnown.reasoning = false;
  else runtime.nativeUsageSums.reasoning += reasoning;
}

export function classifyFlags(value: LiveClassification): LiveSignalId[] {
  return Object.entries(value.perSignal ?? {}).flatMap(([signal, status]) =>
    status === "FLAG" && ["instruction_drift", "unverified_assumption", "evidence_leap"].includes(signal)
      ? [signal as LiveSignalId] : []);
}

export function signalStatus(value: LiveClassification): LiveOutcome {
  if (value.status === "FLAG" || value.investigate === true || classifyFlags(value).length > 0) return "FLAG";
  if (value.status === "INSUFFICIENT_INPUT") return "INSUFFICIENT_INPUT";
  return "NO_VISIBLE_SIGNAL";
}
