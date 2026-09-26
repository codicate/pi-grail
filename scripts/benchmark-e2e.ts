import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { computedCost, normalizeUsage } from "../benchmarks/core.js";
import { DEEPSEEK_ESTIMATE_PRICING, OPENROUTER_PROVIDER_POLICY, RUNTIME_POLICY_VERSION } from "../src/runtime-policy.js";
import { productionPi } from "./production-pi.mjs";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = join(ROOT, "benchmarks/e2e/xs-evolve-lease");
const FIXTURE = join(DEMO, "fixture");
const PROJECT = join(FIXTURE, "project");
const ORACLE = join(DEMO, "oracle/upstream-driver.py");
const EXTENSION = join(ROOT, "extensions/index.ts");
const MODEL = "openrouter/deepseek/deepseek-v4.1-flash";
const THINKING = "low";
const ARMS = ["jev", "subagent"] as const;
const ARM_TIMEOUT_MS = 5 * 60 * 1_000;

type Obj = Record<string, any>;
const readJson = (path: string): Obj => JSON.parse(readFileSync(path, "utf8")) as Obj;
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function writePrivate(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}
function writeJson(path: string, value: unknown) { writePrivate(path, JSON.stringify(value, null, 2) + "\n"); }

function treeHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[name] = sha(readFileSync(path));
    }
  };
  walk(root);
  return out;
}

function validateFixture() {
  const manifest = readJson(join(DEMO, "fixture-manifest.json"));
  if (manifest.version !== 1 || manifest.upstream?.license !== "Apache-2.0") throw new Error("Unknown fixture manifest/license.");
  for (const [relativePath, expected] of Object.entries(manifest.files as Record<string, string>)) {
    const path = join(DEMO, relativePath);
    if (!existsSync(path) || sha(readFileSync(path)) !== expected) throw new Error(`Fixture hash mismatch: ${relativePath}`);
  }
  const settings = readJson(join(PROJECT, ".pi/settings.json"));
  if (settings.retry?.enabled !== false || settings.retry?.maxRetries !== 0 || settings.compaction?.enabled !== false) {
    throw new Error("Fixture Pi settings must keep retries and compaction disabled.");
  }
  return { manifest, projectHashes: treeHashes(PROJECT) };
}

function parseEvents(stdout: string) {
  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* ignore non-JSON CLI progress lines */ }
  }
  let commandResult: Obj | null = null;
  for (const event of [...events].reverse()) {
    if (!event || typeof event !== "object") continue;
    const record = event as Obj;
    const message = record.message && typeof record.message === "object" ? record.message as Obj : {};
    if (message.customType !== "pi-grail-check") continue;
    const details = message.details ?? record.details;
    if (details && typeof details === "object" && (details as Obj).worker === true) {
      commandResult = details as Obj;
      break;
    }
  }
  return { events, commandResult };
}

function runPatch(base: string, final: string) {
  try {
    const output = execFileSync("diff", ["-u", base, final], { encoding: "utf8" });
    return output.replace(/^--- .*$/m, "--- a/worker.py").replace(/^\+\+\+ .*$/m, "+++ b/worker.py");
  } catch (error) {
    const result = error as { status?: number; stdout?: string | Buffer };
    if (result.status === 1) return String(result.stdout ?? "").replace(/^--- .*$/m, "--- a/worker.py").replace(/^\+\+\+ .*$/m, "+++ b/worker.py");
    throw error;
  }
}

async function checkFinal(workerPath: string, leasePath: string) {
  const directory = mkdtempSync(join(tmpdir(), "grail-evolve-lease-check-"));
  try {
    copyFileSync(workerPath, join(directory, "worker.py"));
    copyFileSync(leasePath, join(directory, "lease.py"));
    copyFileSync(ORACLE, join(directory, "driver.py"));
    const started = performance.now();
    const output = await execFile("python3", ["driver.py"], { cwd: directory, timeout: 15_000, encoding: "utf8", maxBuffer: 1024 * 1024 });
    const line = String(output.stdout).split(/\r?\n/).find(value => value.startsWith("VERDICT ")) ?? "VERDICT MISSING";
    const verdict = line.slice("VERDICT ".length);
    const staleDate: Record<string, string> = { "90": "2026-04-12", "45": "2026-06-02" };
    const reason = verdict === "OK" ? "renews every 20 seconds, current user-set interval"
      : verdict.startsWith("INTERVAL_IS:") ? `renews every ${verdict.slice("INTERVAL_IS:".length)} seconds${staleDate[verdict.slice("INTERVAL_IS:".length)] ? `, superseded on ${staleDate[verdict.slice("INTERVAL_IS:".length)]}` : ", not the current interval"}`
        : verdict === "NO_HEARTBEAT" ? "worker.py does not define heartbeat()" : `upstream oracle returned ${verdict}`;
    return { ok: verdict === "OK", verdict, reason, wallMs: performance.now() - started, stdout: String(output.stdout), stderr: String(output.stderr) };
  } catch (error) {
    const value = error as { message?: string; stdout?: string; stderr?: string };
    return { ok: false, verdict: "CHECKER_ERROR", reason: value.message ?? "checker failed", wallMs: null,
      stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function nativeCost(value: Obj | null | undefined, attemptedCalls: unknown, responseCount: unknown) {
  if (attemptedCalls === 0) return { estimatedUsd: 0, provenance: "no_provider_requests" };
  const fields = value && [value.uncachedInputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens];
  if (!value || value.source === "unavailable" || typeof attemptedCalls !== "number" || !Number.isFinite(attemptedCalls)
    || typeof responseCount !== "number" || responseCount !== attemptedCalls
    || !fields?.every(field => typeof field === "number" && Number.isFinite(field) && field >= 0)) {
    return { estimatedUsd: null, provenance: "unknown_native_usage_or_missing_price" };
  }
  const totalInput = value.uncachedInputTokens + value.cacheReadTokens + value.cacheWriteTokens;
  const estimatedUsd = (totalInput * DEEPSEEK_ESTIMATE_PRICING.inputUsdPerMillion
    + value.outputTokens * DEEPSEEK_ESTIMATE_PRICING.outputUsdPerMillion) / 1_000_000;
  return { estimatedUsd, provenance: "conservative_shared_route_price_ceiling; not_billed_cost" };
}

function runSummary(workerResult: Obj | null) {
  const result = workerResult?.result as Obj | undefined;
  const live = result?.liveTelemetry as Obj | undefined;
  const worker = live?.worker as Obj | undefined;
  const children = Array.isArray(live?.selectorAndReviewerChildren) ? live!.selectorAndReviewerChildren as Obj[] : [];
  const usages = [
    { role: "worker", attemptedCalls: worker?.providerRequests, responseCount: worker?.nativeAssistantMessages,
      telemetry: result?.nativeTelemetry as Obj | undefined },
    ...children.map(child => ({ role: child.role, launchId: child.launchId,
      attemptedCalls: child.providerRequests, responseCount: child.nativeAssistantMessages,
      telemetry: child.nativeAssistantMessages > 0 ? {
        source: child.reasoningUsageProvenance === "unavailable" ? "unavailable" : "pi_native_normalized",
        assistantMessages: child.nativeAssistantMessages, uncachedInputTokens: child.uncachedInputTokens,
        outputTokens: child.outputTokens, cacheReadTokens: child.cacheReadTokens,
        cacheWriteTokens: child.cacheWriteTokens, reasoningTokens: child.reasoningTokens,
      } : null })),
  ].map(item => ({ ...item, cost: nativeCost(item.telemetry, item.attemptedCalls, item.responseCount) }));
  const costsKnown = usages.every(item => item.cost.estimatedUsd !== null);
  const deepseekEstimate = costsKnown ? usages.reduce((sum, item) => sum + (item.cost.estimatedUsd ?? 0), 0) : null;
  const gateResults = Array.isArray(worker?.gateResults) ? worker!.gateResults as Obj[] : [];
  const jevCalls = gateResults.flatMap((gate, index) => {
    if (gate.selector !== "jev") return [];
    const invocationCount = typeof gate.selectorInvocations === "number" && Number.isFinite(gate.selectorInvocations)
      ? Math.max(0, Math.floor(gate.selectorInvocations)) : 0;
    if (invocationCount === 0) return [];
    const selectorResult = gate.selectorResult as Obj | undefined;
    const normalizedUsage = normalizeUsage(selectorResult?.usage);
    const cost = computedCost("jev", normalizedUsage);
    return [{ checkpoint: index + 1, invocationCount, usage: selectorResult?.usage ?? null,
      normalizedUsage, estimatedUsd: cost.usd, provenance: cost.provenance }];
  });
  const jevCostsKnown = jevCalls.every(call => call.estimatedUsd !== null);
  const jevEstimate = jevCostsKnown ? jevCalls.reduce((sum, call) => sum + (call.estimatedUsd ?? 0), 0) : null;
  const unknownNativeCostCalls = usages.reduce((count, item) => count + (item.cost.estimatedUsd === null
    ? typeof item.attemptedCalls === "number" && Number.isFinite(item.attemptedCalls) ? item.attemptedCalls : 1 : 0), 0);
  const unknownJevCostCalls = jevCalls.reduce((count, call) => count + (call.estimatedUsd === null ? call.invocationCount : 0), 0);
  const totalEstimate = deepseekEstimate !== null && jevEstimate !== null ? deepseekEstimate + jevEstimate : null;
  const checkpoints = gateResults.map((gate, index) => ({ index: index + 1, selector: gate.selector,
    status: gate.status, perSignal: gate.perSignal, rawReferences: gate.rawReferences,
    selectorInvocations: gate.selectorInvocations, latencyMs: gate.latencyMs,
    selectorUsage: (gate.selectorResult as Obj | undefined)?.usage ?? null,
    selectorNativeTelemetry: (gate.selectorResult as Obj | undefined)?.nativeTelemetry ?? null }));
  const usage = (result?.nativeTelemetry as Obj | undefined)?.source === "unavailable";
  return {
    workerStatus: result?.status ?? null,
    delegationStatus: result?.delegationStatus ?? null,
    stopReason: result?.stopReason ?? null,
    taskResult: result?.taskResult ?? null,
    calls: { workerProviderRequests: worker?.providerRequests ?? null,
      workerResponses: worker?.assistantResponses ?? null, workerToolCalls: worker?.toolCalls ?? null,
      workerFlaggedToolCallsBlocked: worker?.flaggedToolCallsBlocked ?? null,
      checkpoints: worker?.checkpoints ?? null, responseBoundaryReviews: live?.responseBoundaryReviewCount ?? null,
      childLaunches: children.map(child => ({ role: child.role, status: child.status,
        providerRequests: child.providerRequests, blockedProviderRequests: child.blockedProviderRequests,
        assistantResponses: child.assistantResponses, toolCalls: child.toolCalls,
        checkpoints: child.checkpoints, reviewerCalls: child.reviewerCalls })) },
    checkpointVisibility: { checkpoints, selectorAndReviewerChildren: children.map(child => ({ role: child.role,
      refs: child.checkpointDecisions?.map((decision: Obj) => decision.ref) ?? [] })),
      archivalMemoryIsInjectedAsAuthorizedUpdate: false,
      note: "Gate rawReferences are reported verbatim; retrieved memory files are not automatically added to the classifier packet." },
    reviewerFeedback: worker?.reviewerFeedback ?? [],
      usage: { native: usages, deepseekEstimateUsd: deepseekEstimate,
      jevGateCalls: jevCalls, jevEstimateUsd: jevEstimate, totalEstimatedUsd: totalEstimate,
      unknownCostCallCount: unknownNativeCostCalls + unknownJevCostCalls,
      unknownCostCalls: { nativePiChildren: unknownNativeCostCalls, jevGateInvocations: unknownJevCostCalls },
      actualBilledUsd: null,
      source: "Pi-native tokens × shared conservative route ceiling plus Jev provider usage × listed Jev rate; estimates only",
      externalJevUsageRetainedInCheckpoint: true, reasoningIsAlreadyIncludedInOutputTokens: true,
      nativeUsageUnavailable: usage },
  };
}

async function runArm(arm: typeof ARMS[number], runRoot: string, baselineHashes: Record<string, string>, commonStartHash: string) {
  const armStarted = performance.now();
  const outputDir = join(runRoot, arm);
  const workspace = join(outputDir, "workspace");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  cpSync(PROJECT, workspace, { recursive: true, force: false, errorOnExist: true });
  const beforeHashes = treeHashes(workspace);
  const sameStartingFiles = sha(JSON.stringify(beforeHashes)) === commonStartHash;
  const args = ["--approve", "--no-session", "--mode", "json", "--extension", EXTENSION,
    "--grail-selector", arm, "--grail-model", MODEL, "--grail-thinking", THINKING,
    "-p", "/grail worker task.json"];
  const started = performance.now();
  let stdout = "", stderr = "", exitCode: number | null = 0, timedOut = false, error: string | null = null;
  try {
    const running = execFile(productionPi(), args, { cwd: workspace, env: { ...process.env, PI_GRAIL_JEV_MODEL: "jev-1.13.0" },
      timeout: ARM_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }) as ReturnType<typeof execFile> & { child?: { stdin?: { end(): void } } };
    running.child?.stdin?.end();
    const result = await running;
    stdout = String(result.stdout); stderr = String(result.stderr);
  } catch (cause) {
    const value = cause as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number; killed?: boolean; signal?: string; message?: string };
    stdout = String(value.stdout ?? ""); stderr = String(value.stderr ?? "");
    exitCode = typeof value.code === "number" ? value.code : null;
    timedOut = Boolean(value.killed || value.signal === "SIGTERM");
    error = timedOut ? "five_minute_process_timeout" : value.message ?? "production_pi_failed";
  }
  const processWallMs = performance.now() - started;
  const parsed = parseEvents(stdout);
  writePrivate(join(outputDir, "pi-events.jsonl"), stdout);
  writePrivate(join(outputDir, "pi-stderr.txt"), stderr);
  if (parsed.commandResult) writeJson(join(outputDir, "worker-result.json"), parsed.commandResult);
  const finalWorker = join(workspace, "worker.py");
  const patch = existsSync(finalWorker) ? runPatch(join(PROJECT, "worker.py"), finalWorker) : "";
  writePrivate(join(outputDir, "worker.patch"), patch);
  const afterHashes = treeHashes(workspace);
  const changedFiles = [...new Set([...Object.keys(beforeHashes), ...Object.keys(afterHashes)])]
    .filter(path => beforeHashes[path] !== afterHashes[path]).sort();
  const memoryChanges = changedFiles.filter(path => path.startsWith("memory/sessions/"));
  const checker = existsSync(finalWorker) ? await checkFinal(finalWorker, join(workspace, "lease.py"))
    : { ok: false, verdict: "NO_WORKER_FILE", reason: "worker.py missing", wallMs: null, stdout: "", stderr: "" };
  writeJson(join(outputDir, "checker-result.json"), checker);
  const telemetry = runSummary(parsed.commandResult);
  const armWallMs = performance.now() - armStarted;
  const record = { arm, model: MODEL, thinking: THINKING, selector: arm, routePolicyVersion: RUNTIME_POLICY_VERSION,
    routePolicy: OPENROUTER_PROVIDER_POLICY, timeoutMs: ARM_TIMEOUT_MS, processWallMs, armWallMs, exitCode, timedOut, error,
    sameStartingFiles, initialProjectHashes: beforeHashes, sourceProjectHashes: baselineHashes,
    changedFiles, memoryChangedFiles: memoryChanges, checker, finalPatchPath: "worker.patch",
    telemetry, jsonEventCount: parsed.events.length, savedRawEventsPath: "pi-events.jsonl" };
  writeJson(join(outputDir, "run.json"), record);
  return { arm, passedChecker: checker.ok, status: telemetry.workerStatus, processWallMs, armWallMs,
    checkpoints: (telemetry.checkpointVisibility.checkpoints as unknown[]).length,
    changedFiles, memoryChangedFiles: memoryChanges, outputDir };
}

async function main() {
  if (!process.argv.includes("--run-live")) {
    console.log("No Pi/provider calls were made. Review the task and run with --run-live to launch the two live arms.");
    return;
  }
  const totalStarted = performance.now();
  const fixture = validateFixture();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runRoot = join(DEMO, "results", `${stamp}-${randomUUID().slice(0, 8)}`);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const commonStartHash = sha(JSON.stringify(fixture.projectHashes));
  const runs = [];
  for (const arm of ARMS) runs.push(await runArm(arm, runRoot, fixture.projectHashes, commonStartHash));
  const summary = { demo: "xs-evolve-lease", runRoot, startedAt: stamp, sourceCommit: fixture.manifest.upstream.commit,
    arms: runs, checkerContract: "upstream fake-clock callback checker; not a live lease safety test",
    totalWallMs: performance.now() - totalStarted,
    costAccounting: "conservative DeepSeek route-ceiling estimates plus Jev listed-rate estimates where usage is known; actual billed cost unknown" };
  writeJson(join(runRoot, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
