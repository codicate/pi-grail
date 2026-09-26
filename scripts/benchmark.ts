import { execFile as execCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { CONTROL_SIGNAL_CONTRACT, CONTROL_SYSTEM_PROMPT, DEFAULT_JEV_PROMPTS, DEFAULT_JEV_PROMPT_VERSION,
  JEV_MODEL, controlTask, judgmentContract, parseControl, preparePacket } from "../src/selector.js";
import { productionPi } from "./production-pi.mjs";
import { OUTCOMES, PRICES, SCORING_VERSION, SIGNAL_IDS, computedCost, controlCacheKey, hash,
  normalizeUsage, reservationUpperBound, score, type BenchmarkCase, type GoldLabels,
  type NormalizedUsage, type Outcome, type Selector, type SignalId } from "../benchmarks/core.js";
import { LEDGER_PATH, reserveCalls, settleCall, settleRemaining, snapshot as ledgerSnapshot,
  writeRunLedgerSnapshot, type LedgerCall } from "../benchmarks/ledger.js";

const execFile = promisify(execCallback);
const ROOT = process.cwd();
const BENCH = join(ROOT, "benchmarks");
const RESULTS = join(BENCH, "results");
const STATE = join(BENCH, "state");
const CACHE = join(BENCH, "cache", "controls");
const MAX_OUTPUT_TOKENS = 512;
const BATCH_TIMEOUT_MS = 900_000;

type Dataset = { datasetId: string; heldBackUntilFinal?: boolean; cases: BenchmarkCase[] };
type LabelFile = { datasetId: string; labelStatus: string; authorship: string; cases: GoldLabels; validation?: Record<string, unknown> };
type Prompt = { version: string; instructionsBySignal?: Partial<Record<SignalId, string>>;
  criteriaBySignal?: Partial<Record<SignalId, Partial<Record<Outcome, string>>>>; notes?: string };
type GateResult = { perSignal?: Partial<Record<SignalId, Outcome>>; status?: Outcome; investigate?: boolean;
  rawReferences?: string[]; hashes?: Record<string, unknown>; selectorPromptVersion?: string;
  selectorInvocations?: number; reviewInvocations?: number;
  selectorResult?: { model?: string; usage?: unknown; error?: string; [key: string]: unknown };
  latencyMs?: number; reason?: string };
type BatchRow = { id: string; selector: Selector; result: GateResult; wallMs?: number };
type OutputRow = Record<string, unknown>;

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
function writeNew(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
function writeMutable(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
function writeTextNew(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}
function relative(path: string) { return path.startsWith(ROOT + "/") ? path.slice(ROOT.length + 1) : path; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run"; }
function makeRunDir(label: string) {
  mkdirSync(RESULTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(RESULTS, stamp + "-" + slug(label) + "-" + randomUUID().slice(0, 8));
  mkdirSync(path);
  return path;
}
function statePath(name: string) { return join(STATE, name + ".json"); }
function writeState(name: string, data: unknown) { writeNew(statePath(name), data); }
function assertNoState(name: string) { if (existsSync(statePath(name))) throw new Error(name + " already attempted; no automatic retries."); }
function assertTuningOpen() {
  if (existsSync(statePath("heldback-opened"))) throw new Error("Held-back validation/evaluation has begun; development tuning is closed.");
}

function loadDataset(kind: "development" | "heldback"): Dataset {
  const filename = kind === "development" ? "cases.development.v1.json" : "cases.heldback.v1.json";
  const dataset = readJson<Dataset>(join(BENCH, filename));
  if (!Array.isArray(dataset.cases) || dataset.cases.length !== (kind === "development" ? 12 : 3)) {
    throw new Error("Dataset case count is invalid.");
  }
  const seen = new Set<string>();
  for (const item of dataset.cases) {
    if (!item.id || seen.has(item.id) || !SIGNAL_IDS.includes(item.focus)) throw new Error("Dataset contains an invalid or duplicate case.");
    seen.add(item.id);
    const prepared = preparePacket(item.packet);
    if (!prepared.packet) throw new Error("Case " + item.id + " is not a valid packet: " + prepared.error);
  }
  if (kind === "heldback" && dataset.heldBackUntilFinal !== true) throw new Error("Held-back dataset lacks the final-only marker.");
  return dataset;
}

function frozenPath(kind: "development" | "heldback") { return join(BENCH, "labels." + kind + ".frozen.json"); }
function loadFrozen(kind: "development" | "heldback") {
  const dataset = loadDataset(kind);
  const document = readJson<LabelFile>(frozenPath(kind));
  if (document.labelStatus !== "frozen" || document.datasetId !== dataset.datasetId) throw new Error(kind + " labels are not frozen for this dataset.");
  if (kind === "heldback") {
    const selected = readJson<{ selectedVersion?: string; promptHash?: string }>(statePath("heldback-opened"));
    const validation = document.validation?.finalSelection as { selectedVersion?: string; promptHash?: string } | undefined;
    if (!selected.selectedVersion || !selected.promptHash || validation?.selectedVersion !== selected.selectedVersion
      || validation.promptHash !== selected.promptHash) {
      throw new Error("Frozen held-back labels were not validated for the final prompt currently selected.");
    }
  }
  const ids = Object.keys(document.cases).sort();
  const expected = dataset.cases.map(item => item.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error("Frozen labels do not match the case IDs.");
  for (const id of expected) {
    const row = document.cases[id]!;
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...SIGNAL_IDS].sort())) throw new Error("Frozen labels for " + id + " are incomplete.");
    for (const signal of SIGNAL_IDS) if (!(OUTCOMES as readonly string[]).includes(row[signal])) throw new Error("Invalid frozen label at " + id + "/" + signal + ".");
  }
  return { dataset, labels: document.cases, document };
}

function promptInfo(prompt: Prompt | null) {
  const version = prompt?.version ?? DEFAULT_JEV_PROMPT_VERSION;
  const options = prompt ? { jevPromptVersion: version, jevInstructionsBySignal: prompt.instructionsBySignal ?? {},
    jevCriteriaBySignal: prompt.criteriaBySignal ?? {} } : {};
  const questions = Object.fromEntries(SIGNAL_IDS.map(signal => [signal, {
    instructions: options.jevInstructionsBySignal?.[signal] ?? DEFAULT_JEV_PROMPTS[signal].instructions,
    criteria: { ...DEFAULT_JEV_PROMPTS[signal].criteria, ...options.jevCriteriaBySignal?.[signal] },
  }]));
  return { version, options, contract: { model: JEV_MODEL, questions } };
}
function readPrompt(path: string): Prompt {
  const prompt = readJson<Prompt>(resolve(ROOT, path));
  if (!prompt || typeof prompt.version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(prompt.version)) {
    throw new Error("Prompt file needs a short version string.");
  }
  for (const [signal, instruction] of Object.entries(prompt.instructionsBySignal ?? {})) {
    if (!SIGNAL_IDS.includes(signal as SignalId) || typeof instruction !== "string") throw new Error("Invalid signal instruction in prompt file.");
  }
  for (const [signal, criteria] of Object.entries(prompt.criteriaBySignal ?? {})) {
    if (!SIGNAL_IDS.includes(signal as SignalId)) throw new Error("Invalid signal criteria in prompt file.");
    for (const [outcome, text] of Object.entries(criteria ?? {})) {
      if (!OUTCOMES.includes(outcome as Outcome) || typeof text !== "string") throw new Error("Invalid outcome criteria in prompt file.");
    }
  }
  return prompt;
}

function controlPrompt() {
  return { system: CONTROL_SYSTEM_PROMPT, signals: CONTROL_SIGNAL_CONTRACT,
    output: "one strict JSON object with exactly three signal IDs and allowed outcome strings" };
}
function sharedSourceHash() {
  return hash({ packetPreparation: String(preparePacket), judgmentContract: String(judgmentContract),
    controlTask: String(controlTask), parseControl: String(parseControl), scoring: String(score),
    usageNormalization: String(normalizeUsage), costAccounting: String(computedCost),
    gateAdapter: readFileSync(join(ROOT, "src/grail.ts"), "utf8"),
    benchmarkScoringAndAccounting: readFileSync(join(ROOT, "benchmarks/core.ts"), "utf8"),
    packingVersion: "packet-v1-json-utf8-16k-no-truncate", scoringVersion: SCORING_VERSION });
}
function runtime() {
  let pi = "unavailable";
  try { pi = execFileSync(productionPi(), ["--version"], { cwd: ROOT, encoding: "utf8", timeout: 10000 }).trim(); }
  catch { /* keep unavailable explicit */ }
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(ROOT, "package.json"));
  return { node: process.version, productionPi: pi, piSubagents: pkg.devDependencies?.["pi-subagents"] ?? null,
    typesafeSdk: pkg.dependencies?.["@typesafe-ai/sdk"] ?? null };
}
function frozenControlKey(dataset: Dataset, labels: GoldLabels, versions: unknown) {
  return controlCacheKey({ dataset, labels, controlPrompt: controlPrompt(), sharedLogicSourceHash: sharedSourceHash(),
    runtimeVersions: versions, model: PRICES.selector, thinking: "low",
    limits: { packetUtf8Bytes: 16_000, outputTokens: MAX_OUTPUT_TOKENS, callsPerCase: 1, reviewers: 0 } });
}
function tokenReservation(selector: Selector, item: BenchmarkCase, prompt: ReturnType<typeof promptInfo>) {
  const source = selector === "jev" ? prompt.contract : controlPrompt();
  const inputBytes = Buffer.byteLength(JSON.stringify({ packet: item.packet, contract: source }), "utf8");
  return reservationUpperBound(selector, inputBytes, MAX_OUTPUT_TOKENS);
}

function makeBatch(cases: BenchmarkCase[], selectors: Selector[], prompt: Prompt | null) {
  const info = promptInfo(prompt);
  const items = [];
  for (const item of cases) for (const selector of selectors) {
    items.push({ id: selector + ":" + item.id, selector, packet: item.packet,
      ...(selector === "jev" && prompt ? { options: info.options } : {}) });
  }
  return { items, prompt: info };
}
function jsonl(stdout: string): unknown[] {
  const result: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) if (line.trim()) {
    try { result.push(JSON.parse(line)); } catch { /* Pi can write progress that is not JSON. */ }
  }
  return result;
}
function extractRows(records: unknown[]): BatchRow[] {
  const details: unknown[] = [];
  for (const value of records) {
    if (!value || typeof value !== "object") continue;
    const obj = value as Record<string, unknown>;
    const message = obj.message && typeof obj.message === "object" ? obj.message as Record<string, unknown> : {};
    const detail = message.details ?? obj.details;
    if (detail && typeof detail === "object") details.push(detail);
  }
  for (const value of details.reverse()) {
    const obj = value as Record<string, unknown>;
    const rows = obj.results ?? obj.rows;
    if (Array.isArray(rows)) return rows.filter(row => row && typeof row === "object") as BatchRow[];
  }
  return [];
}
function batchMetadata(records: unknown[]) {
  for (const value of records) {
    if (!value || typeof value !== "object") continue;
    const obj = value as Record<string, unknown>;
    const message = obj.message && typeof obj.message === "object" ? obj.message as Record<string, unknown> : {};
    const detail = message.details ?? obj.details;
    if (detail && typeof detail === "object" && (detail as Record<string, unknown>).batch === true) {
      const fields = detail as Record<string, unknown>;
      return { parentElapsedMs: typeof fields.parentElapsedMs === "number" ? fields.parentElapsedMs : null,
        parentStartupMs: typeof fields.parentStartupMs === "number" ? fields.parentStartupMs : null };
    }
  }
  return { parentElapsedMs: null, parentStartupMs: null };
}
async function launchBatch(directory: string, items: ReturnType<typeof makeBatch>["items"]) {
  const batch = { version: 1, serial: true, items };
  writeNew(join(directory, "batch-input.json"), batch);
  const dir = directory.split(/[\\/]/).at(-1)!;
  const args = ["--approve", "--offline", "--no-session", "--mode", "json", "--grail-selector", "jev",
    "--grail-model", PRICES.selector, "--grail-thinking", "low", "-p",
    "/grail classify-batch benchmarks/results/" + dir + "/batch-input.json"];
  const env = { ...process.env, PI_GRAIL_JEV_MODEL: JEV_MODEL };
  const start = performance.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = 0;
  let failure: string | null = null;
  try {
    const execution = execFile(productionPi(), args, { cwd: ROOT, env, timeout: BATCH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }) as ReturnType<typeof execFile> & { child?: { stdin?: { end(): void } } };
    execution.child?.stdin?.end();
    const result = await execution;
    stdout = String(result.stdout); stderr = String(result.stderr);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
    stdout = typeof e.stdout === "string" ? e.stdout : "";
    stderr = typeof e.stderr === "string" ? e.stderr : "";
    exitCode = typeof e.code === "number" ? e.code : null;
    failure = e.killed || e.signal === "SIGTERM" ? "Production Pi batch timed out." :
      "Production Pi batch failed" + (exitCode === null ? "." : " with exit code " + exitCode + ".");
  }
  const processWallMs = Math.max(0, performance.now() - start);
  const records = jsonl(stdout);
  const timing = { results: extractRows(records), ...batchMetadata(records), processWallMs, exitCode, failure, jsonRecordCount: records.length,
    stderrBytes: Buffer.byteLength(stderr, "utf8"), parentStartupIncludedInProcessWallMs: true,
    parentStartupIncludedInGateLatency: false };
  writeNew(join(directory, "production-pi-run.json"), timing);
  return timing;
}

function cost(selector: Selector, raw: unknown) {
  const usage = normalizeUsage(raw);
  if (raw && typeof raw === "object") {
    const fields = raw as Record<string, unknown>;
    const reported = fields.costUsd ?? fields.totalCostUsd ?? fields.totalCost;
    if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
      return { usage, usd: reported, provenance: "Pi-runtime-reported-cost-field" };
    }
  }
  const estimate = computedCost(selector, usage);
  return { usage, usd: estimate.usd, provenance: estimate.provenance };
}
function toOutput(item: BenchmarkCase, selector: Selector, gold: GoldLabels[string], result: GateResult | undefined,
  reserve: LedgerCall, prompt: ReturnType<typeof promptInfo>, runId: string, parentWall: number | null): OutputRow {
  const usage = cost(selector, result?.selectorResult?.usage);
  const failure = result?.reason ?? result?.selectorResult?.error ??
    (result && result.reviewInvocations !== 0 ? "Selector-only classification invoked a reviewer." : null);
  const native = result?.selectorResult?.nativeTelemetry as {
    source?: string; assistantMessages?: number; reasoningTokens?: number | null;
  } | undefined;
  const failedZeroIsUnknown = selector === "subagent" && Boolean(failure)
    && usage.usage?.inputTokens === 0 && usage.usage.outputTokens === 0
    && (native?.source === "unavailable" || native?.assistantMessages === 0 || !native);
  const safeUsage = failedZeroIsUnknown ? null : usage.usage;
  const safeCost = failedZeroIsUnknown ? null : usage.usd;
  const perSignal = result?.perSignal && SIGNAL_IDS.every(id => (OUTCOMES as readonly string[]).includes(result.perSignal?.[id] as string))
    ? result.perSignal as Record<SignalId, Outcome> : null;
  return { iterationId: runId, caseId: item.id, focus: item.focus, selector, source: "fresh",
    inputHash: result?.hashes?.packetHash ?? hash(item.packet), judgmentHash: result?.hashes?.judgmentHash ?? null,
    promptHash: result?.hashes?.selectorPromptHash ?? (selector === "jev" ? hash(prompt.contract) : hash(controlPrompt())),
    promptVersion: result?.selectorPromptVersion ?? (selector === "jev" ? prompt.version : "control-v1"),
    model: result?.selectorResult?.model ?? (selector === "jev" ? JEV_MODEL : PRICES.selector),
    effort: selector === "jev" ? "native-choice" : "low", labels: gold,
    decisions: { perSignal, status: result?.status ?? null, investigate: result?.investigate ?? null,
      selectorInvocations: result?.selectorInvocations ?? null, reviewInvocations: result?.reviewInvocations ?? null },
    rawReferences: result?.rawReferences ?? [], hashes: result?.hashes ?? null,
    usage: safeUsage, reasoningTokens: result?.selectorResult?.reasoningTokens ?? native?.reasoningTokens ?? usage.usage?.reasoningTokens ?? null,
    reasoningTokensAreOutputSubset: true, costUsd: safeCost,
    costProvenance: failedZeroIsUnknown ? "failed-control-zero-usage-untrusted" : usage.provenance,
    costUpperBoundUsd: reserve.reservedUsd, reservationId: reserve.id,
    latencyMs: typeof result?.latencyMs === "number" ? result.latencyMs : null, parentProcessWallMs: parentWall,
    failure };
}
function scoreRows(rows: OutputRow[]) {
  const inputs = rows.map(row => {
    const d = row.decisions as { perSignal?: Record<SignalId, Outcome> | null; investigate?: boolean | null };
    return { caseId: String(row.caseId), selector: row.selector as Selector, gold: row.labels as Record<SignalId, Outcome>,
      actual: row.failure ? null : d?.perSignal ?? null, investigate: row.failure ? null : d?.investigate ?? null,
      costUsd: row.costUsd as number | null, costUpperBoundUsd: row.costUpperBoundUsd as number | null,
      latencyMs: row.latencyMs as number | null, failure: typeof row.failure === "string" ? row.failure : undefined };
  });
  return Object.fromEntries((["jev", "subagent"] as const).map(selector =>
    [selector, score(inputs.filter(row => row.selector === selector))]));
}
function usageBucket(rows: OutputRow[]) {
  const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"] as const;
  const usages = rows.map(row => row.usage && typeof row.usage === "object" ? row.usage as Record<string, number | null> : null);
  return Object.fromEntries(fields.map(field => {
    const known = usages.map(usage => usage?.[field]).filter((value): value is number => typeof value === "number");
    return [field, { sumKnown: known.length ? known.reduce((a, b) => a + b, 0) : null,
      knownCalls: known.length, unknownCalls: rows.length - known.length }];
  }));
}
function costBucket(rows: OutputRow[]) {
  const observed = rows.map(row => row.costUsd).filter((value): value is number => typeof value === "number");
  const bounds = rows.map(row => row.costUpperBoundUsd).filter((value): value is number => typeof value === "number");
  return { observedCalls: observed.length, unknownCostCalls: rows.length - observed.length,
    observedEstimatedTotalUsd: observed.length ? observed.reduce((a, b) => a + b, 0) : null,
    meanObservedEstimatedUsd: observed.length ? observed.reduce((a, b) => a + b, 0) / observed.length : null,
    reservedUpperBoundUsd: bounds.length === rows.length ? bounds.reduce((a, b) => a + b, 0) : null };
}
function fixtureValidationBucket() {
  const ledger = ledgerSnapshot(LEDGER_PATH);
  const calls = ledger.calls.filter(call => call.kind === "fixture-label-validation");
  const observed = calls.map(call => call.settledUsd).filter((value): value is number => typeof value === "number");
  return { source: relative(LEDGER_PATH), separateFromGateRows: true, calls: calls.length,
    unknownCostCalls: calls.length - observed.length,
    observedEstimatedTotalUsd: observed.length ? observed.reduce((a, b) => a + b, 0) : null,
    reservedUpperBoundUsd: calls.length ? calls.reduce((sum, call) => sum + call.reservedUsd, 0) : null,
    provenance: "cumulative fixture validation expense from the ledger; distinct from per-gate estimates" };
}

function writeCache(path: string, cacheKey: string, rows: OutputRow[]) {
  mkdirSync(dirname(path), { recursive: true });
  const controls = rows.filter(row => row.selector === "subagent");
  if (controls.length !== 12) throw new Error("Cannot freeze a control cache without all 12 fresh baseline control rows.");
  const content = [{ cache: { cacheKey, createdAt: new Date().toISOString(), source: "baseline pass 1" } }, ...controls];
  writeFileSync(path, content.map(row => JSON.stringify(row)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
}
function readCache(path: string, cacheKey: string, dataset: Dataset, labels: GoldLabels, runId: string) {
  const fileRows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as OutputRow);
  if ((fileRows[0] as { cache?: { cacheKey?: string } }).cache?.cacheKey !== cacheKey) throw new Error("Control cache key mismatch.");
  const byCase = new Map(fileRows.slice(1).map(row => [String(row.caseId), row]));
  return dataset.cases.map(item => {
    const row = byCase.get(item.id);
    if (!row) throw new Error("Control cache is missing " + item.id + ".");
    return { ...row, iterationId: runId, source: "historical-control-cache", labels: labels[item.id],
      reusedFromIterationId: row.iterationId };
  });
}

async function run(kind: "baseline" | "candidate" | "final", datasetKind: "development" | "heldback",
  prompt: Prompt | null, pass?: string) {
  const frozen = loadFrozen(datasetKind);
  const { dataset, labels, document } = frozen;
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + slug(kind + "-" + (prompt?.version ?? pass ?? "")) + "-" + randomUUID().slice(0, 8);
  const directory = join(RESULTS, runId);
  mkdirSync(directory);
  const prompts = promptInfo(prompt);
  const selectors: Selector[] = kind === "candidate" ? ["jev"] : ["jev", "subagent"];
  const versions = runtime();
  const cacheKey = frozenControlKey(dataset, labels, versions);
  const cachePath = join(CACHE, cacheKey + ".jsonl");
  let output: OutputRow[] = [];
  if (kind === "candidate") {
    if (!existsSync(statePath("baseline-pass-1")) || !existsSync(statePath("baseline-pass-2"))) {
      throw new Error("Run both interleaved baseline passes before candidates.");
    }
    if (!existsSync(cachePath)) throw new Error("No exact matching frozen control cache from baseline pass 1.");
    output = readCache(cachePath, cacheKey, dataset, labels, runId);
  }
  const batch = makeBatch(dataset.cases, selectors, prompt);
  const budgetPhase = kind === "final" ? "final" as const : "development" as const;
  const reservationPlan = [];
  for (const item of dataset.cases) for (const selector of selectors) reservationPlan.push({
    kind: kind + "-selector", selector, caseId: item.id,
    promptHash: selector === "jev" ? hash(prompts.contract) : hash(controlPrompt()),
    phase: budgetPhase,
    reservedUsd: tokenReservation(selector, item, prompts) });
  const reserves = reserveCalls(reservationPlan, budgetPhase);
  writeNew(join(directory, "cases.json"), { datasetId: dataset.datasetId, cases: dataset.cases });
  writeNew(join(directory, "labels.json"), { cases: labels, labelHash: hash(labels), validation: document.validation });
  writeNew(join(directory, "prompts.json"), { jev: prompts, control: controlPrompt() });
  writeNew(join(directory, "reservation-plan.json"), reserves);
  writeNew(join(directory, "cache-provenance.json"), { key: cacheKey,
    cacheFile: kind === "candidate" ? relative(cachePath) : null, historicalControlReuse: kind === "candidate",
    sharedSourceHash: sharedSourceHash(), runtime: versions });
  const manifest: Record<string, unknown> = { version: 1, iterationId: runId, kind, datasetKind,
    datasetId: dataset.datasetId, createdAt: new Date().toISOString(), caseCount: dataset.cases.length,
    promptVersion: prompts.version, promptHash: hash(prompts.contract), controlPromptHash: hash(controlPrompt()),
    models: { jev: JEV_MODEL, control: PRICES.selector }, effort: { jev: "native-choice", control: "low" },
    maxPacketBytes: 16_000, outputTokenCap: MAX_OUTPUT_TOKENS,
    reviewerCalls: 0, reviewerTokens: 0, workerCalls: 0, workerTokens: 0, retries: 0,
    selectorOrder: "serial; Jev then control for each case, identical packet; timing runs are not parallel",
    controlCacheKey: cacheKey, runtime: versions, prices: PRICES, labelHash: hash(labels),
    timing: "classifyGrail latencyMs excludes common parent startup; parent process wall is recorded separately" };
  let processResult: Awaited<ReturnType<typeof launchBatch>> | null = null;
  try {
    processResult = await launchBatch(directory, batch.items);
    const byId = new Map(processResult.results.map(row => [row.id, row]));
    const fresh: OutputRow[] = [];
    let idx = 0;
    for (const item of dataset.cases) for (const selector of selectors) {
      const reserve = reserves[idx++]!;
      const raw = byId.get(selector + ":" + item.id);
      const record = toOutput(item, selector, labels[item.id]!, raw?.result, reserve, prompts, runId, processResult.processWallMs);
      if (!raw?.result) record.failure = processResult.failure ?? "Pi batch output omitted this case.";
      fresh.push(record);
      const usage = cost(selector, raw?.result?.selectorResult?.usage);
      const failed = !raw?.result || Boolean(record.failure);
      const noCall = raw?.result?.selectorInvocations === 0;
      const native = raw?.result?.selectorResult?.nativeTelemetry as { source?: string; assistantMessages?: number } | undefined;
      const failedZeroIsUnknown = selector === "subagent" && failed && usage.usage?.inputTokens === 0
        && usage.usage.outputTokens === 0 && (native?.source === "unavailable" || native?.assistantMessages === 0 || !native);
      settleCall(reserve.id, { success: !failed, settledUsd: noCall ? 0 : failedZeroIsUnknown ? null : usage.usd,
        costProvenance: noCall ? "no-selector-call-zero-inference" :
          failedZeroIsUnknown ? "failed-control-zero-usage-untrusted" :
          failed && usage.usd === null ? "failed-attempt-charged-reserved-upper-bound" : usage.provenance,
        error: typeof record.failure === "string" ? record.failure : (!raw ? processResult.failure ?? "Pi batch omitted the case." : undefined) }, LEDGER_PATH);
    }
    output = [...output, ...fresh];
    if (kind === "baseline" && pass === "1" && !existsSync(cachePath)) writeCache(cachePath, cacheKey, output);
    manifest.parentProcessWallMs = processResult.processWallMs;
    manifest.parentElapsedMs = processResult.parentElapsedMs;
    manifest.parentStartupMs = processResult.parentStartupMs;
    manifest.parentStartupIncludedInWallMs = true;
    manifest.parentStartupIncludedInGateLatency = false;
    manifest.exitCode = processResult.exitCode;
    manifest.batchFailure = processResult.failure;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Production Pi batch failed.";
    settleRemaining(reserves, message);
    manifest.batchFailure = message;
    const existingFresh = new Set(output.filter(row => row.source === "fresh").map(row => String(row.selector) + ":" + String(row.caseId)));
    const missing = dataset.cases.flatMap(item => selectors.filter(selector => !existingFresh.has(selector + ":" + item.id)).map(selector => {
      const reserve = reserves.find(call => call.caseId === item.id && call.selector === selector);
      return { iterationId: runId, caseId: item.id, focus: item.focus, selector, source: "fresh",
        inputHash: hash(item.packet), judgmentHash: null, promptHash: selector === "jev" ? hash(prompts.contract) : hash(controlPrompt()),
        promptVersion: prompts.version, model: selector === "jev" ? JEV_MODEL : PRICES.selector, effort: "low", labels: labels[item.id],
        decisions: { perSignal: null, status: null, investigate: null, selectorInvocations: null, reviewInvocations: null },
        rawReferences: [], hashes: null, usage: null, costUsd: null, costProvenance: "unavailable-usage",
        costUpperBoundUsd: reserve?.reservedUsd ?? null, reservationId: reserve?.id ?? null,
        latencyMs: null, parentProcessWallMs: null, failure: message };
    }));
    output = [...output, ...missing];
  }
  if (selectors.length === 2) {
    const paired = new Map<string, OutputRow[]>();
    for (const row of output.filter(item => item.source === "fresh")) {
      const group = paired.get(String(row.caseId)) ?? [];
      group.push(row);
      paired.set(String(row.caseId), group);
    }
    for (const [caseId, group] of paired) {
      if (group.length === 2 && (group[0]!.inputHash !== group[1]!.inputHash || group[0]!.judgmentHash !== group[1]!.judgmentHash)) {
        for (const row of group) row.failure = "Arm packet/judgment hash parity failed for " + caseId + ".";
      }
    }
  }
  const metrics = { byArm: scoreRows(output), rows: output.length,
    accountingBuckets: {
      sharedSetup: { parentStartupMs: processResult?.parentStartupMs ?? null,
        parentProcessWallMs: processResult?.processWallMs ?? null, parentElapsedMs: processResult?.parentElapsedMs ?? null,
        contextPackingMs: null, providerUsage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        costUsd: 0, provenance: "known zero provider calls for local parent setup; packing time was not separately measured" },
      mainWorker: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0,
        provenance: "known zero in selector-only Type 1" },
      selectorGate: Object.fromEntries((["jev", "subagent"] as const).map(arm => {
        const armRows = output.filter(row => row.selector === arm);
        return [arm, { calls: armRows.length, usage: usageBucket(armRows), cost: costBucket(armRows) }];
      })),
      reviewer: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0,
        provenance: "known zero in selector-only Type 1" },
      fixtureValidation: fixtureValidationBucket(),
    },
    freshRows: output.filter(row => row.source === "fresh").length,
    historicalControlRows: output.filter(row => row.source === "historical-control-cache").length,
    parentProcessWallMs: processResult?.processWallMs ?? null };
  writeNew(join(directory, "manifest.json"), { ...manifest, completedAt: new Date().toISOString() });
  writeTextNew(join(directory, "per-case.jsonl"), output.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeNew(join(directory, "metrics.json"), metrics);
  writeTextNew(join(directory, "tuning-notes.md"), [
    "# " + kind + " results", "",
    "Type 1 performs selector-only classification and invokes zero reviewers.",
    "Gate latency uses classifyGrail latencyMs; parent process wall includes common Pi startup and batch overhead.",
    "Unknown token usage and cost remain null; all outgoing calls were reserved before launch.",
    "", JSON.stringify(metrics, null, 2), "",
  ].join("\n"));
  writeRunLedgerSnapshot(directory);
  return { runId, directory, metrics };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const getFlag = (name: string) => {
    const index = args.indexOf("--" + name);
    if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Missing --" + name + ".");
    return args[index + 1]!;
  };
  if (!command || command === "help") {
    console.log("Commands: baseline --pass 1|2; candidate --prompt <json>; final --prompt <selected-json>. Label validation/freeze is in scripts/benchmark-labels.ts.");
    return;
  }
  if (command === "baseline") {
    assertTuningOpen();
    const pass = getFlag("pass");
    if (pass !== "1" && pass !== "2") throw new Error("Use --pass 1 or --pass 2.");
    assertNoState("baseline-pass-" + pass);
    if (pass === "2" && !existsSync(statePath("baseline-pass-1"))) throw new Error("Baseline pass 1 must run first.");
    const result = await run("baseline", "development", null, pass);
    writeState("baseline-pass-" + pass, { iterationId: result.runId, directory: relative(result.directory), metrics: result.metrics });
    console.log(JSON.stringify({ pass, ...result, directory: relative(result.directory) }, null, 2));
    return;
  }
  if (command === "candidate") {
    assertTuningOpen();
    if (!existsSync(statePath("baseline-pass-1")) || !existsSync(statePath("baseline-pass-2"))) throw new Error("Run both baselines before tuning.");
    const prompt = readPrompt(getFlag("prompt"));
    const attemptsPath = statePath("candidate-attempts");
    const attempts = existsSync(attemptsPath) ? readJson<{ versions: string[] }>(attemptsPath) : { versions: [] };
    if (attempts.versions.length >= 5) throw new Error("Five candidate versions is the maximum.");
    if (attempts.versions.includes(prompt.version)) throw new Error("This prompt version was already attempted; no retries.");
    writeMutable(attemptsPath, { versions: [...attempts.versions, prompt.version], attemptedAt: new Date().toISOString() });
    const result = await run("candidate", "development", prompt);
    console.log(JSON.stringify({ version: prompt.version, ...result, directory: relative(result.directory) }, null, 2));
    return;
  }
  if (command === "final") {
    const prompt = readPrompt(getFlag("prompt"));
    if (!existsSync(statePath("baseline-pass-1")) || !existsSync(statePath("baseline-pass-2"))) throw new Error("Both baselines must finish before final evaluation.");
    if (!existsSync(statePath("heldback-opened"))) writeState("heldback-opened", {
      openedAt: new Date().toISOString(), selectedVersion: prompt.version, promptHash: hash(promptInfo(prompt).contract) });
    const selected = readJson<{ selectedVersion: string; promptHash: string }>(statePath("heldback-opened"));
    if (selected.selectedVersion !== prompt.version || selected.promptHash !== hash(promptInfo(prompt).contract)) {
      throw new Error("Final prompt must match the version frozen when the held-back suite was opened.");
    }
    if (existsSync(statePath("final-evaluation"))) throw new Error("Final evaluation was already attempted; no retries.");
    if (!existsSync(frozenPath("heldback"))) throw new Error("Validate/freeze held-back labels after selecting this prompt, then rerun final.");
    const result = await run("final", "heldback", prompt);
    writeState("final-evaluation", { runId: result.runId, directory: relative(result.directory), metrics: result.metrics, selectedVersion: prompt.version });
    console.log(JSON.stringify({ selectedVersion: prompt.version, ...result, directory: relative(result.directory) }, null, 2));
    return;
  }
  throw new Error("Unknown command " + command + "; use benchmark help.");
}

main().catch(error => {
  console.error("Benchmark failed: " + (error instanceof Error ? error.message : "unexpected error"));
  process.exitCode = 1;
});
