import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  classifyGrail, runGrail, selectorMode, thinkingLevel,
  type ClassifyOptions, type HarnessDependencies, type LeafInput,
} from "../src/grail.js";
import { evaluate, status as jevStatus } from "../src/jev.js";
import { delegate, registerPersona, type GrailDelegationResponse } from "../src/delegation.js";
import {
  createLiveLaunch, encodeLaunchTask, removeLiveLaunch, snapshotLiveTelemetry,
  snapshotNativeTelemetry, classifyFlags, type LiveLaunchRuntime, type LiveOutcome, type LiveRecord,
  type LiveRole, type LiveSignalId, type LiveTelemetry,
} from "../src/live.js";
import { MAX_PACKET_BYTES, reviewerTask, SELECTOR_SYSTEM_PROMPT, type Packet, type Selector } from "../src/selector.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_EXTENSION = resolve(ROOT, "extensions/grail-child.ts");
const WORKER_PROMPT = resolve(ROOT, "agents/grail-worker.md");

export interface ClassifyBatchItem {
  id?: string;
  packet: unknown;
  selector?: Selector;
  options?: ClassifyOptions;
}

function parseJsonFile(path: string, cwd: string, description: string) {
  try { return JSON.parse(readFileSync(resolve(cwd, path), "utf8")) as unknown; }
  catch { throw new Error(`Could not read ${description} JSON file.`); }
}

function promptOptions(pi: ExtensionAPI, ctx: ExtensionContext): ClassifyOptions {
  const path = pi.getFlag("grail-jev-prompt");
  if (typeof path !== "string" || !path.trim()) return {};
  const value = parseJsonFile(path, ctx.cwd, "--grail-jev-prompt");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--grail-jev-prompt must point to a JSON object of Jev ClassifyOptions.");
  }
  return value as ClassifyOptions;
}

function personaPrompt(path: string) {
  return readFileSync(path, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

function rawRecord(value: unknown, fallbackRef: string, fallbackText: string): LiveRecord {
  if (value && typeof value === "object") {
    const record = value as Partial<LiveRecord>;
    if (typeof record.ref === "string" && typeof record.text === "string") {
      return { ref: record.ref, text: record.text };
    }
  }
  return { ref: fallbackRef, text: fallbackText };
}

function packetContext(value: unknown, workerId: string): {
  handoff: LiveRecord;
  instructionUpdates: Array<LiveRecord & { authorized: true }>;
} {
  if (!value || typeof value !== "object") return {
    handoff: { ref: `${workerId}:handoff`, text: "No validated handoff was available." },
    instructionUpdates: [],
  };
  const packet = value as Partial<Packet>;
  const handoff = rawRecord(packet.handoff, `${workerId}:handoff`, "No validated handoff was available.");
  const instructionUpdates = Array.isArray(packet.instructionUpdates)
    ? packet.instructionUpdates.flatMap(value => value && typeof value === "object"
      && (value as { authorized?: unknown }).authorized === true
      && typeof (value as { ref?: unknown }).ref === "string"
      && typeof (value as { text?: unknown }).text === "string"
      ? [{ ref: (value as LiveRecord).ref, text: (value as LiveRecord).text, authorized: true as const }]
      : [])
    : [];
  return { handoff, instructionUpdates };
}

function classifyResultShape(value: unknown) {
  return value && typeof value === "object" ? value as {
    status?: LiveOutcome;
    perSignal?: Partial<Record<LiveSignalId, LiveOutcome>>;
    investigate?: boolean;
    rawReferences?: string[];
  } : {};
}

function summarizeLiveRun(launches: LiveTelemetry[]) {
  return {
    childLaunches: launches,
    nativeUsageSource: "pi_native_normalized",
    nativeReasoningIsSeparateFromSubagentUsage: true,
  };
}

export function registerGrail(pi: ExtensionAPI) {
  pi.registerFlag("grail-selector", { type: "string", default: "jev", description: "A/B arm: jev (experiment) or subagent (control)" });
  pi.registerFlag("grail-model", { type: "string", default: "openrouter/deepseek/deepseek-v4.1-flash", description: "Provider/model for control selectors and reviewers" });
  pi.registerFlag("grail-thinking", { type: "string", default: "low", description: "Thinking level for generative subagents" });
  pi.registerFlag("grail-jev-prompt", { type: "string", description: "Optional JSON ClassifyOptions file for Jev prompt tuning" });

  let registrations: { dispose(): void }[] = [];
  let setupError: string | undefined;
  function cleanup() { for (const registration of registrations) registration.dispose(); registrations = []; }

  pi.on("session_start", () => {
    cleanup();
    setupError = undefined;
    try {
      const defaults = {
        systemPromptMode: "replace" as const,
        inheritProjectContext: false,
        inheritGlobalContext: false,
        inheritSkills: false,
        allowNestedSubagents: false,
        defaultContext: "fresh" as const,
        extensions: [CHILD_EXTENSION],
        subagentOnlyExtensions: [],
      };
    registrations.push(registerPersona(pi, "grail-selector", {
        ...defaults,
        description: "Generic LLM control selector for the shared raw packet",
        systemPrompt: SELECTOR_SYSTEM_PROMPT,
        tools: [],
      }));
      registrations.push(registerPersona(pi, "grail-reviewer", {
        ...defaults,
        description: "Shared read-only verifier for Grail findings",
        systemPrompt: personaPrompt(resolve(ROOT, "agents/grail-reviewer.md")),
        tools: ["read", "grep", "find", "ls"],
        toolBudget: { hard: 8, block: "*" },
      }));
      registrations.push(registerPersona(pi, "grail-worker", {
        ...defaults,
        description: "Monitored worker with live Grail checkpoints and reviewer feedback",
        systemPrompt: personaPrompt(WORKER_PROMPT),
        tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
        toolBudget: { hard: 20, block: "*" },
        defaultTimeoutMs: 180_000,
      }));
    } catch {
      cleanup();
      setupError = "Grail personas are unavailable. Install compatible pi-subagents and check duplicate agent names.";
    }
  });
  pi.on("session_shutdown", cleanup);

  function configuration(ctx: ExtensionContext) {
    const selector = selectorMode(pi.getFlag("grail-selector"));
    const model = String(pi.getFlag("grail-model"));
    const thinking = thinkingLevel(pi.getFlag("grail-thinking"));
    const separator = model.indexOf("/");
    if (separator < 1) throw new Error("--grail-model must be provider/model-id.");
    const resolved = ctx.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1));
    return {
      selector,
      model,
      thinking,
      modelFound: Boolean(resolved),
      modelAuthenticated: Boolean(resolved && ctx.modelRegistry.hasConfiguredAuth(resolved)),
      personasRegistered: registrations.length === 3,
      setupError,
      signals: ["instruction_drift", "unverified_assumption", "evidence_leap"],
      automaticWorkerHooks: true,
      monitoredPersona: "grail-worker",
      maxPacketBytes: MAX_PACKET_BYTES,
      liveLimits: { workerResponses: 10, checkpoints: 20, workerMs: 180_000, reviewerResponses: 4, reviewerReadonlyCalls: 8 },
      jevConfigured: jevStatus().configured,
      jevPromptPath: pi.getFlag("grail-jev-prompt") ?? null,
    };
  }

  function show(ctx: ExtensionContext, result: unknown) {
    const content = JSON.stringify(result, null, 2);
    if (ctx.mode === "print") console.log(content);
    else pi.sendMessage({ customType: "pi-grail-check", content, details: result, display: true });
  }

  function validateReady(ctx: ExtensionContext) {
    const config = configuration(ctx);
    if (setupError || !config.personasRegistered) throw new Error(setupError ?? "Grail personas are not registered.");
    if (!config.modelFound) throw new Error("The configured Grail model is not in Pi's registry. Check --grail-model.");
    if (!config.modelAuthenticated) throw new Error("Pi generative-model auth is missing. Run npm run pi:auth for OpenRouter, or configure your chosen provider.");
    return config;
  }

  function createDependencies(ctx: ExtensionContext, run: {
    parentRunId: string;
    workerId: string;
    handoff: LiveRecord;
    instructionUpdates: Array<LiveRecord & { authorized: true }>;
    signal?: AbortSignal;
    deadlineAt?: number;
  }) {
    const childTelemetry: LiveTelemetry[] = [];
    const config = validateReady(ctx);

    async function invokeChild(input: LeafInput, signal = run.signal) {
      const role = input.agent as LiveRole;
      if (!["grail-selector", "grail-reviewer"].includes(role)) {
        throw new Error("Only Grail selector and reviewer leaves are allowed in this coordinator.");
      }
      const selector = role === "grail-selector";
      const maxDurationMs = selector ? 45_000 : Math.min(120_000, Math.max(1, (run.deadlineAt ?? Date.now() + 120_000) - Date.now()));
      const child = createLiveLaunch({
        parentRunId: run.parentRunId,
        workerId: run.workerId,
        role,
        handoff: run.handoff,
        instructionUpdates: run.instructionUpdates,
        rawTask: input.task,
      }, {
        maxDurationMs,
        maxProviderRequests: selector ? 1 : 4,
        maxReadonlyToolCalls: selector ? 0 : 8,
      });
      try {
        const response = await delegate(pi, {
          ownerRunId: run.parentRunId,
          nodeId: `${input.nodeId}:${child.envelope.launchId}`,
          agent: role,
          task: encodeLaunchTask(child.envelope),
          context: "fresh",
          cwd: ctx.cwd,
          model: config.model,
          thinking: config.thinking,
          timeoutMs: maxDurationMs,
          skill: false,
          artifacts: true,
          intercomBridge: { mode: "off" },
          toolBudget: selector ? { hard: 0, block: "*" } : { hard: 8, block: "*" },
          result: { kind: "text" },
        }, signal);
        if (child.telemetry.status === "active") child.telemetry.status = response.status === "completed" ? "completed" : "failed";
        if (response.status !== "completed" && child.telemetry.status !== "limit_exhausted") {
          child.telemetry.stopReason = response.status;
        }
        return Object.assign(response, { nativeTelemetry: snapshotNativeTelemetry(child) }) as GrailDelegationResponse;
      } catch (error) {
        child.telemetry.status = child.telemetry.status === "limit_exhausted" ? "limit_exhausted" : "failed";
        child.telemetry.stopReason ??= error instanceof Error ? error.message : "delegation_failed";
        throw error;
      } finally {
        childTelemetry.push(snapshotLiveTelemetry(child));
        removeLiveLaunch(child.envelope.launchId);
      }
    }

    const deps: HarnessDependencies = {
      evaluate,
      leaf: input => invokeChild(input),
    };
    return { deps, childTelemetry, invokeChild };
  }

  function attachTelemetry<T extends object>(value: T, telemetry: LiveTelemetry[]) {
    return { ...value, liveTelemetry: summarizeLiveRun(telemetry) };
  }

  async function classifyOne(ctx: ExtensionContext, value: unknown, selected?: Selector, options?: ClassifyOptions) {
    const config = validateReady(ctx);
    const workerId = value && typeof value === "object" && typeof (value as { workerId?: unknown }).workerId === "string"
      ? (value as { workerId: string }).workerId : `classify-${randomUUID()}`;
    const base = packetContext(value, workerId);
    const parentRunId = randomUUID();
    const built = createDependencies(ctx, {
      parentRunId,
      workerId,
      ...base,
      signal: ctx.signal,
    });
    const result = await classifyGrail(value, selected ?? config.selector, built.deps, ctx.signal, options ?? promptOptions(pi, ctx));
    return attachTelemetry(result, built.childTelemetry);
  }

  async function checkOne(ctx: ExtensionContext, value: unknown, selected?: Selector, options?: ClassifyOptions) {
    const config = validateReady(ctx);
    const workerId = value && typeof value === "object" && typeof (value as { workerId?: unknown }).workerId === "string"
      ? (value as { workerId: string }).workerId : `check-${randomUUID()}`;
    const base = packetContext(value, workerId);
    const parentRunId = randomUUID();
    const built = createDependencies(ctx, {
      parentRunId,
      workerId,
      ...base,
      signal: ctx.signal,
    });
    const result = await runGrail(value, selected ?? config.selector, built.deps, ctx.signal, options ?? promptOptions(pi, ctx));
    return attachTelemetry(result, built.childTelemetry);
  }

  function responseText(response: GrailDelegationResponse) {
    if (response.status !== "completed" || !("result" in response) || response.result?.kind !== "text") {
      throw new Error(`Grail child did not complete (${response.status}).`);
    }
    return response.result.text;
  }

  async function launchWorker(ctx: ExtensionContext, task: string, updates: Array<LiveRecord & { authorized: true }>, signal?: AbortSignal) {
    const config = validateReady(ctx);
    const workerId = randomUUID();
    const parentRunId = randomUUID();
    const startedAt = Date.now();
    const deadlineAt = startedAt + 180_000;
    const handoff = { ref: `${workerId}:handoff`, text: task };
    const rawTask = updates.length === 0 ? task : `${task}\n\nAuthorized instruction updates (keep these in force):\n${updates.map(update => `[${update.ref}] ${update.text}`).join("\n")}`;
    const runState = createDependencies(ctx, { parentRunId, workerId, handoff, instructionUpdates: updates, signal, deadlineAt });

    let workerLaunch: LiveLaunchRuntime;
    workerLaunch = createLiveLaunch({
      parentRunId,
      workerId,
      role: "grail-worker",
      handoff,
      instructionUpdates: updates,
      rawTask,
    }, {
      maxDurationMs: 180_000,
      maxProviderRequests: 10,
      maxCheckpoints: 20,
      classify: async (packet, _record) => {
        const result = await classifyGrail(packet, config.selector, runState.deps, signal, promptOptions(pi, ctx));
        const shape = classifyResultShape(result);
        return shape;
      },
      review: async (packet, perSignal, _observations) => {
        const task = reviewerTask(packet as Packet, perSignal);
        const response = await runState.invokeChild({
          agent: "grail-reviewer",
          task,
          nodeId: `live-reviewer-${workerId}-${workerLaunch.responseIndex}`,
          selector: false,
        }, signal);
        return {
          status: response.status,
          text: response.status === "completed" ? responseText(response) : "The reviewer failed; the flagged concern remains unresolved.",
          rawReferences: _observations.filter(observation => classifyFlags(observation.result).length > 0)
            .map(observation => observation.record.ref),
        };
      },
    });
    try {
      const taskResponse = await delegate(pi, {
        ownerRunId: parentRunId,
        nodeId: `worker:${workerId}`,
        agent: "grail-worker",
        task: encodeLaunchTask(workerLaunch.envelope),
        context: "fresh",
        cwd: ctx.cwd,
        model: config.model,
        thinking: config.thinking,
        timeoutMs: 180_000,
        skill: false,
        artifacts: true,
        intercomBridge: { mode: "off" },
        toolBudget: { hard: 20, block: "*" },
        result: { kind: "text" },
      }, signal);
      if (workerLaunch.telemetry.status === "active") workerLaunch.telemetry.status = taskResponse.status === "completed" ? "completed" : "failed";
      if (taskResponse.status !== "completed" && workerLaunch.telemetry.status !== "limit_exhausted") {
        workerLaunch.telemetry.stopReason = taskResponse.status;
      }
      const liveTelemetry = snapshotLiveTelemetry(workerLaunch);
      return {
        version: 1,
        workerId,
        status: workerLaunch.telemetry.status,
        delegationStatus: taskResponse.status,
        stopReason: workerLaunch.telemetry.stopReason ?? null,
        taskResult: taskResponse.status === "completed" ? responseText(taskResponse) : null,
        liveTelemetry: {
          worker: liveTelemetry,
          selectorAndReviewerChildren: runState.childTelemetry,
          responseBoundaryReviewCount: liveTelemetry.reviewerCalls,
        },
        nativeTelemetry: snapshotNativeTelemetry(workerLaunch),
      };
    } catch (error) {
      if (workerLaunch.telemetry.status === "active") workerLaunch.telemetry.status = "failed";
      workerLaunch.telemetry.stopReason ??= error instanceof Error ? error.message : "worker_delegation_failed";
      throw error;
    } finally {
      removeLiveLaunch(workerLaunch.envelope.launchId);
    }
  }

  pi.registerCommand("grail", {
    description: "Grail: /grail status, /grail smoke, /grail live-smoke, /grail classify <packet.json>, /grail classify-batch <manifest.json>, /grail check <packet.json>, /grail worker <task.json>",
    handler: async (args, ctx) => {
      try {
        const command = args.trim().replace(/\s+/g, " ");
        if (!command || command === "status") show(ctx, configuration(ctx));
        else if (command === "smoke") {
          const results = [];
          for (const name of ["grail-drift.json", "grail-no-drift.json"]) {
            const value = parseJsonFile(resolve(ROOT, "test/fixtures", name), ctx.cwd, "Grail packet");
            results.push(await checkOne(ctx, value));
          }
          show(ctx, { fixtureOnly: true, results });
        } else if (command.startsWith("classify-batch ")) {
          const path = command.slice("classify-batch ".length).trim().replace(/^("|')([\s\S]*)\1$/, "$2");
          const manifest = parseJsonFile(path, ctx.cwd, "Grail classify batch manifest");
          const items = Array.isArray(manifest) ? manifest : manifest && typeof manifest === "object"
            ? (manifest as { items?: unknown }).items : undefined;
          if (!Array.isArray(items)) throw new Error("Grail batch manifest must be an array or contain an items array.");
          const startedAt = Date.now();
          const parentStartupMs = Math.round(process.uptime() * 1_000);
          const results: Array<{ id: string; selector: Selector; wallMs: number; result: unknown }> = [];
          for (let index = 0; index < items.length; index++) {
            const item = items[index] as Partial<ClassifyBatchItem>;
            if (!item || typeof item !== "object" || !("packet" in item)) throw new Error(`Grail batch item ${index + 1} needs a packet field.`);
            const before = Date.now();
            const selected = item.selector ? selectorMode(item.selector) : undefined;
            const result = await classifyOne(ctx, item.packet, selected, { ...promptOptions(pi, ctx), ...(item.options ?? {}) });
            results.push({ id: typeof item.id === "string" ? item.id : `case-${index + 1}`,
              selector: selected ?? configuration(ctx).selector, wallMs: Date.now() - before, result });
          }
          show(ctx, { batch: true, parentElapsedMs: Date.now() - startedAt, parentStartupMs, results });
        } else if (command.startsWith("classify ")) {
          const path = command.slice(9).trim().replace(/^("|')([\s\S]*)\1$/, "$2");
          const packet = parseJsonFile(path, ctx.cwd, "Grail packet");
          show(ctx, await classifyOne(ctx, packet));
        } else if (command.startsWith("check ")) {
          const path = command.slice(6).trim().replace(/^("|')([\s\S]*)\1$/, "$2");
          const packet = parseJsonFile(path, ctx.cwd, "Grail packet");
          show(ctx, await checkOne(ctx, packet));
        } else if (command === "live-smoke" || command === "live_smoke") {
          const task = "Inspect test/fixtures/grail-live-smoke-requirement.txt. The handoff says not to edit it. Think through the task, then attempt the proposed write once so the parent can verify that Grail pauses it.";
          const result = await launchWorker(ctx, task, [], ctx.signal);
          show(ctx, { fixtureOnly: true, result });
        } else if (command.startsWith("worker ")) {
          const path = command.slice(7).trim().replace(/^("|')([\s\S]*)\1$/, "$2");
          const taskSpec = parseJsonFile(path, ctx.cwd, "Grail worker task");
          if (!taskSpec || typeof taskSpec !== "object" || typeof (taskSpec as { task?: unknown }).task !== "string"
            || !(taskSpec as { task: string }).task.trim()) {
            throw new Error("Grail worker task JSON must contain a non-empty task string.");
          }
          const updatesValue = (taskSpec as { instructionUpdates?: unknown }).instructionUpdates;
          if (updatesValue !== undefined && !Array.isArray(updatesValue)) {
            throw new Error("Grail worker instructionUpdates must be an array.");
          }
          const updates = ((updatesValue ?? []) as unknown[]).map(value => {
            if (!value || typeof value !== "object"
              || (value as { authorized?: unknown }).authorized !== true
              || typeof (value as { ref?: unknown }).ref !== "string"
              || typeof (value as { text?: unknown }).text !== "string") {
              throw new Error("Every worker instruction update must contain ref/text and authorized: true.");
            }
            return { ref: (value as LiveRecord).ref, text: (value as LiveRecord).text, authorized: true as const };
          });
          const result = await launchWorker(ctx, (taskSpec as { task: string }).task, updates, ctx.signal);
          show(ctx, { worker: true, result });
        } else throw new Error("Use /grail status, /grail smoke, /grail live-smoke, /grail classify <packet.json>, /grail classify-batch <manifest.json>, /grail check <packet.json>, or /grail worker <task.json>.");
      } catch (error) {
        show(ctx, { error: error instanceof Error ? error.message : "Grail command failed." });
      }
    },
  });

  pi.registerTool({
    name: "grail_check",
    label: "Grail Check",
    description: "Explicitly classify an existing raw-record packet for instruction drift, unverified assumptions, and evidence leaps. This check may invoke the shared reviewer only when any signal flags.",
    parameters: Type.Object({ packetPath: Type.String({ description: "Path to an existing deterministic raw-record JSON packet." }) }),
    async execute(_id, params, signal, _update, ctx) {
      const path = resolve(ctx.cwd, params.packetPath);
      const packet = parseJsonFile(path, ctx.cwd, "Grail packet");
      const result = await checkOne(ctx, packet, undefined, promptOptions(pi, ctx));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "grail_worker",
    label: "Grail Worker",
    description: "Launch one explicitly monitored foreground worker. The worker gets the supplied task and authorized instruction updates; completed thinking blocks and assistant responses are classified, and a flagged tool batch is paused once for reviewer feedback.",
    parameters: Type.Object({
      task: Type.String({ description: "The raw kickoff handoff for the worker. Preserve the user's wording and constraints." }),
      instructionUpdates: Type.Optional(Type.Array(Type.Object({
        ref: Type.String({ description: "Raw source reference for the authorized update." }),
        text: Type.String({ description: "Exact authorized instruction update text." }),
        authorized: Type.Boolean({ description: "Must be true for an authorized update." }),
      }))),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!params.task.trim()) throw new Error("Grail worker task cannot be empty.");
      const updates = (params.instructionUpdates ?? []).map(value => {
        if (value.authorized !== true) throw new Error("Every instruction update must be explicitly authorized.");
        return { ref: value.ref, text: value.text, authorized: true as const };
      });
      const result = await launchWorker(ctx, params.task, updates, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

}

export default registerGrail;
