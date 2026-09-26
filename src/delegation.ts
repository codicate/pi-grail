import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeAgentDefinition, RuntimeAgentRegistrationRequest } from "pi-subagents/agents";
import type { SubagentDelegationRequest, SubagentDelegationResponse } from "pi-subagents/delegation";
import type { NativeTelemetry } from "./live.js";

// Type-only imports: production's separately installed owner handles these events.
const REQUEST = "prompt-template:subagent:request";
const RESPONSE = "prompt-template:subagent:response";
const CANCEL = "prompt-template:subagent:cancel";

export type GrailDelegationResponse = SubagentDelegationResponse & { nativeTelemetry?: NativeTelemetry };

export function registerPersona(pi: ExtensionAPI, name: string, definition: RuntimeAgentDefinition) {
  const request: RuntimeAgentRegistrationRequest = { version: 1, name, definition };
  pi.events.emit("pi-subagents:runtime-agent-register:v1", request);
  if (!request.result) throw new Error("Compatible production pi-subagents is not installed or ready.");
  if (!request.result.ok) throw new Error("Could not register the Grail persona; check pi-subagents agent name collisions.");
  return request.result.registration;
}

export function delegate(
  pi: ExtensionAPI, input: Omit<SubagentDelegationRequest, "requestId">, signal?: AbortSignal,
): Promise<GrailDelegationResponse> {
  const request = { ...input, requestId: randomUUID() };
  return new Promise<GrailDelegationResponse>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Grail call was cancelled.")); return; }
    let settled = false;
    const finish = (error?: Error, response?: SubagentDelegationResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(response! as GrailDelegationResponse);
    };
    const abort = () => {
      pi.events.emit(CANCEL, { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId });
      finish(new Error("Grail call was cancelled."));
    };
    const unsubscribe = pi.events.on(RESPONSE, (payload: unknown) => {
      const response = payload as SubagentDelegationResponse;
      if (response?.requestId !== request.requestId || response.ownerRunId !== request.ownerRunId
        || response.nodeId !== request.nodeId) return;
      finish(undefined, response);
    });
    // Owner also enforces the launch timeout. This bounds a missing/broken owner.
    const timer = setTimeout(() => {
      pi.events.emit(CANCEL, { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId });
      finish(new Error("Grail delegation timed out or no pi-subagents owner responded."));
    }, (input.timeoutMs ?? 120_000) + 5_000);
    signal?.addEventListener("abort", abort, { once: true });
    try { pi.events.emit(REQUEST, request); }
    catch { finish(new Error("Could not dispatch Grail delegation.")); }
  });
}
