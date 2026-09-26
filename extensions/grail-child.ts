import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPENROUTER_PROVIDER_POLICY, SELECTOR_OUTPUT_TOKENS } from "../src/runtime-policy.js";
import {
  addNativeUsage, clampProviderPayload, classifyFlags, decodeLaunchTask, getLiveLaunch,
  isLiveWorkerRole, isReadonlyReviewTool, semanticCheckpointFingerprint, signalStatus, snapshotLiveTelemetry,
  type LiveLaunchRuntime, type LiveOutcome, type LiveRecord, type LiveSignalId,
} from "../src/live.js";

const READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

function contentThrough(message: unknown, index: number) {
  if (!message || typeof message !== "object") return "";
  const parts = (message as { content?: unknown }).content;
  if (!Array.isArray(parts)) return "";
  const rendered: string[] = [];
  parts.slice(0, index + 1).forEach((part: any) => {
    if (!part || typeof part !== "object") return;
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
      rendered.push(`[thinking]\n${part.thinking.trim()}`);
    } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      rendered.push(`[text]\n${part.text.trim()}`);
    } else if (part.type === "toolCall" && typeof part.name === "string") {
      rendered.push(`[proposed tool call]\n${part.name} ${JSON.stringify(part.arguments ?? {})}`);
    }
  });
  return rendered.join("\n\n");
}

function allMessageContent(message: unknown) {
  if (!message || typeof message !== "object") return "";
  const parts = (message as { content?: unknown }).content;
  if (!Array.isArray(parts)) return "";
  return contentThrough({ content: parts }, parts.length - 1);
}

function packetFor(runtime: LiveLaunchRuntime, latestTurn: LiveRecord) {
  return {
    version: 1,
    workerId: runtime.envelope.workerId,
    contextComplete: true,
    handoff: runtime.envelope.handoff,
    instructionUpdates: runtime.envelope.instructionUpdates,
    latestTurn,
  };
}

function setLimit(runtime: LiveLaunchRuntime, reason: string, ctx: { abort(): void }) {
  runtime.telemetry.status = "limit_exhausted";
  runtime.telemetry.stopReason = reason;
  ctx.abort();
}

function maxTokens(runtime: LiveLaunchRuntime) {
  switch (runtime.envelope.role) {
    case "grail-selector": return SELECTOR_OUTPUT_TOKENS;
    case "grail-reviewer": return 4096;
    case "grail-worker": return 8192;
  }
}

function providerLimit(runtime: LiveLaunchRuntime) {
  switch (runtime.envelope.role) {
    case "grail-selector": return 1;
    case "grail-reviewer": return 4;
    case "grail-worker": return 10;
  }
}

export function isLiveRoleMonitoredForClassification(role: string) {
  return isLiveWorkerRole(role);
}

async function checkpoint(runtime: LiveLaunchRuntime, record: LiveRecord, ctx: {
  abort(): void;
  signal: AbortSignal | undefined;
}) {
  if (!runtime.classify || !isLiveWorkerRole(runtime.envelope.role)) return;
  if (Date.now() - runtime.startedAt >= runtime.maxDurationMs) {
    setLimit(runtime, "worker_duration_limit", ctx);
    return;
  }
  const packet = packetFor(runtime, record);
  // Refs name transport checkpoints; semantic duplicates compare the actual raw text and context.
  const packetHash = semanticCheckpointFingerprint(runtime.envelope.handoff,
    runtime.envelope.instructionUpdates, record);
  if (runtime.responseCheckpointHashes.has(packetHash)) return;
  runtime.responseCheckpointHashes.add(packetHash);
  if (runtime.telemetry.checkpoints >= runtime.maxCheckpoints) {
    setLimit(runtime, "checkpoint_limit", ctx);
    return;
  }
  runtime.telemetry.checkpoints += 1;
  try {
    const result = await runtime.classify(packet, record);
    const observation = { packet, record, result };
    runtime.responseRecords.push(observation);
    runtime.telemetry.gateResults.push(result);
    for (const signal of classifyFlags(result)) runtime.responseFlags.add(signal);
    runtime.telemetry.checkpointDecisions.push({
      ref: record.ref,
      status: signalStatus(result),
      perSignal: { ...(result.perSignal ?? {}) },
      rawReferences: Array.isArray(result.rawReferences)
        ? result.rawReferences.filter((value): value is string => typeof value === "string") : [record.ref],
      selectorInvocations: result.selectorInvocations ?? 1,
      latencyMs: typeof result.latencyMs === "number" ? result.latencyMs : null,
      selectorResult: result.selectorResult ?? null,
    });
  } catch {
    runtime.telemetry.status = "failed";
    runtime.telemetry.stopReason = "classifier_failed";
  }
}

function aggregatePacket(runtime: LiveLaunchRuntime) {
  const records = runtime.responseRecords.map(value => value.record);
  const unique = records.filter((record, index) => records.findIndex(other => other.ref === record.ref) === index);
  return packetFor(runtime, {
    ref: unique.map(value => value.ref).join(", "),
    text: unique.map(value => `[${value.ref}]\n${value.text}`).join("\n\n"),
  });
}

function aggregateSignals(runtime: LiveLaunchRuntime): Partial<Record<LiveSignalId, LiveOutcome>> {
  const merged: Partial<Record<LiveSignalId, LiveOutcome>> = {};
  for (const observation of runtime.responseRecords) {
    for (const [signal, status] of Object.entries(observation.result.perSignal ?? {})) {
      if (status === "FLAG" || merged[signal as LiveSignalId] !== "FLAG") {
        merged[signal as LiveSignalId] = status as LiveOutcome;
      }
    }
  }
  for (const signal of runtime.responseFlags) merged[signal] = "FLAG";
  return merged;
}

function proposedToolIds(message: unknown) {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: any) => part?.type === "toolCall" && typeof part.id === "string" ? [part.id] : []);
}

function feedbackText(flags: LiveSignalId[], review: { status: string; text: string; rawReferences?: string[] }) {
  const finding = review.text.trim() || "The reviewer could not verify the flagged concern.";
  return [
    "Grail review for the immediately preceding assistant response:",
    `Flagged signals: ${flags.join(", ")}.`,
    `Reviewer status: ${review.status}.`,
    finding,
    "Treat these findings as evidence to assess against the original handoff and authorized updates. Reconsider the proposed action and continue only after addressing the concern.",
  ].join("\n\n");
}

export default function registerGrailChild(pi: ExtensionAPI) {
  let runtime: LiveLaunchRuntime | undefined;

  pi.on("input", (event, ctx) => {
    // pi-subagents' foreground executor wraps the task with this fixed protocol label.
    // Strip only that known wrapper before decoding Grail's own transport envelope.
    const taskText = event.text.startsWith("Task: ") ? event.text.slice("Task: ".length) : event.text;
    const envelope = decodeLaunchTask(taskText);
    if (!envelope) {
      ctx.abort();
      return { action: "handled" as const };
    }
    const found = getLiveLaunch(envelope.launchId);
    if (!found || found.envelope.workerId !== envelope.workerId
      || found.envelope.parentRunId !== envelope.parentRunId
      || found.envelope.role !== envelope.role) {
      ctx.abort();
      return { action: "handled" as const };
    }
    runtime = found;
    return { action: "transform" as const, text: envelope.rawTask };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const active = runtime;
    if (!active) return;
    if (Date.now() - active.startedAt >= active.maxDurationMs) {
      active.telemetry.blockedProviderRequests += 1;
      setLimit(active, "worker_duration_limit", ctx);
      return event.payload;
    }
    const next = active.telemetry.providerRequests + 1;
    if (next > Math.min(active.maxProviderRequests, providerLimit(active))) {
      active.telemetry.blockedProviderRequests += 1;
      setLimit(active, `${active.envelope.role}_response_limit`, ctx);
      return event.payload;
    }
    active.telemetry.providerRequests = next;
    const payload = clampProviderPayload(event.payload, maxTokens(active));
    return payload && typeof payload === "object"
      ? { ...payload, provider: OPENROUTER_PROVIDER_POLICY } : payload;
  });

  pi.on("message_start", event => {
    if (!runtime || event.message.role !== "assistant") return;
    runtime.responseIndex += 1;
    runtime.telemetry.assistantResponses += 1;
    runtime.responseRecords = [];
    runtime.responseFlags.clear();
    runtime.responseCheckpointHashes.clear();
  });

  pi.on("message_update", async (event, ctx) => {
    const active = runtime;
    if (!active || !isLiveWorkerRole(active.envelope.role)
      || event.assistantMessageEvent.type !== "thinking_end") return;
    const latest = contentThrough(event.message, event.assistantMessageEvent.contentIndex);
    if (!latest.trim()) return;
    const record: LiveRecord = {
      ref: `${active.envelope.workerId}:response-${active.responseIndex}:thinking-${event.assistantMessageEvent.contentIndex}`,
      text: latest,
    };
    await checkpoint(active, record, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const active = runtime;
    if (!active || event.message.role !== "assistant") return;
    addNativeUsage(active, event.message);
    const providerStopped = event.message.stopReason === "error" || event.message.stopReason === "aborted";
    if (providerStopped && active.telemetry.status !== "limit_exhausted") {
      active.telemetry.status = "failed";
      active.telemetry.stopReason = event.message.errorMessage ?? event.message.stopReason;
    }
    if (!isLiveWorkerRole(active.envelope.role) || !active.classify) return;
    const latest = allMessageContent(event.message);
    if (!providerStopped && latest.trim()) {
      await checkpoint(active, {
        ref: `${active.envelope.workerId}:response-${active.responseIndex}:final`,
        text: latest,
      }, ctx);
    }
    if (active.responseFlags.size === 0 || !active.review) return;

    const flags = [...active.responseFlags];
    const reviewPacket = aggregatePacket(active);
    const perSignal = aggregateSignals(active);
    let review: { status: string; text: string; rawReferences?: string[] };
    try {
      active.telemetry.reviewerCalls += 1;
      review = await active.review(reviewPacket, perSignal, active.responseRecords);
    } catch {
      review = { status: "failed", text: "The reviewer failed; the flagged concern remains unresolved." };
    }
    active.telemetry.reviewerFeedback.push({
      status: review.status,
      text: review.text,
      rawReferences: review.rawReferences ?? [],
    });
    active.blockedToolCalls = new Set(proposedToolIds(event.message));
    pi.sendMessage({
      customType: "pi-grail-live-feedback",
      content: feedbackText(flags, review),
      display: true,
      details: { workerId: active.envelope.workerId, flags, status: review.status, rawReferences: review.rawReferences ?? [] },
    }, { deliverAs: "steer" });
  });

  pi.on("tool_call", (event, ctx) => {
    const active = runtime;
    if (!active) return;
    active.telemetry.toolCalls += 1;
    if (active.envelope.role === "grail-selector") {
      return { block: true, reason: "Grail selector personas are tool-free." };
    }
    if (active.envelope.role === "grail-reviewer") {
      if (!isReadonlyReviewTool(event.toolName)) {
        return { block: true, reason: "Grail reviewer tools are read-only." };
      }
      const limit = active.maxReadonlyToolCalls || 8;
      if (active.telemetry.toolCalls > limit) {
        setLimit(active, "grail-reviewer_readonly_tool_limit", ctx);
        return { block: true, reason: "Grail reviewer reached its eight read-only tool-call limit." };
      }
      return;
    }
    if (active.blockedToolCalls.has(event.toolCallId)) {
      active.blockedToolCalls.delete(event.toolCallId);
      active.telemetry.flaggedToolCallsBlocked += 1;
      return { block: true, reason: "This complete tool batch was paused after a Grail flag so the worker can reconsider it with reviewer feedback." };
    }
  });

  pi.on("agent_end", () => {
    if (!runtime) return;
    if (runtime.telemetry.status === "active") runtime.telemetry.status = "completed";
  });

  pi.on("session_shutdown", () => {
    if (!runtime) return;
    if (runtime.telemetry.status === "active") runtime.telemetry.status = "completed";
    // Keep the shared record available until its parent delegation has returned.
    snapshotLiveTelemetry(runtime);
  });
}
