import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const LEDGER_PATH = join(process.cwd(), "benchmarks/state/spend-ledger.json");
export const TOTAL_LIMIT_USD = 10;
export const FINAL_RESERVE_USD = 0.2;

export type BudgetPhase = "development" | "final";
export type LedgerCall = {
  id: string;
  kind: string;
  selector: string;
  caseId?: string;
  promptHash?: string;
  reservedUsd: number;
  phase: BudgetPhase;
  status: "reserved" | "completed" | "failed";
  committedUsd?: number;
  settledUsd?: number | null;
  costProvenance?: string;
  startedAt?: string;
  settledAt?: string;
  error?: string;
};
export type SpendLedger = {
  version: 1;
  ceilingUsd: number;
  finalReserveUsd: number;
  openedAt: string;
  calls: LedgerCall[];
};

function initial(): SpendLedger {
  return { version: 1, ceilingUsd: TOTAL_LIMIT_USD, finalReserveUsd: FINAL_RESERVE_USD,
    openedAt: new Date().toISOString(), calls: [] };
}

function readLedger(path = LEDGER_PATH): SpendLedger {
  if (!existsSync(path)) return initial();
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object") throw new Error("Spend ledger is invalid.");
  const ledger = value as SpendLedger;
  if (ledger.version !== 1 || ledger.ceilingUsd !== TOTAL_LIMIT_USD || ledger.finalReserveUsd !== FINAL_RESERVE_USD
    || !Array.isArray(ledger.calls)) throw new Error("Spend ledger version or limits do not match the approved $10 budget.");
  return ledger;
}

function atomicWrite(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}

function withLedgerLock<T>(path: string, action: (ledger: SpendLedger) => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = path + ".lock";
  let lockFd: number;
  try { lockFd = openSync(lockPath, "wx", 0o600); }
  catch { throw new Error("Spend ledger is locked by another benchmark process; do not launch a second paid run."); }
  try {
    const ledger = readLedger(path);
    const result = action(ledger);
    atomicWrite(path, ledger);
    return result;
  } finally {
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

function availableUse(ledger: SpendLedger) {
  return ledger.calls.reduce((sum, call) => {
    if (call.status === "reserved") return sum + call.reservedUsd;
    return sum + (call.committedUsd ?? 0);
  }, 0);
}

export function snapshot(path = LEDGER_PATH) {
  const ledger = readLedger(path);
  const spentOrReservedUsd = availableUse(ledger);
  return { ...ledger, spentOrReservedUsd,
    developmentAvailableUsd: Math.max(0, ledger.ceilingUsd - ledger.finalReserveUsd - spentOrReservedUsd),
    totalAvailableUsd: Math.max(0, ledger.ceilingUsd - spentOrReservedUsd) };
}

export function reserveCalls(calls: Array<Omit<LedgerCall, "id" | "status" | "startedAt">>,
  phase: BudgetPhase, path = LEDGER_PATH): LedgerCall[] {
  return withLedgerLock(path, ledger => {
    const requested = calls.reduce((sum, call) => sum + call.reservedUsd, 0);
    if (!Number.isFinite(requested) || calls.some(call => !Number.isFinite(call.reservedUsd) || call.reservedUsd < 0)) {
      throw new Error("Invalid call-cost reservation.");
    }
    const cap = phase === "development" ? ledger.ceilingUsd - ledger.finalReserveUsd : ledger.ceilingUsd;
    const committedOrReserved = availableUse(ledger);
    if (committedOrReserved + requested > cap + 1e-12) {
      throw new Error("Benchmark call reservation exceeds the " + (phase === "development" ? "$0.80 development cap (including the $0.20 final reserve)" : "$1.00 total ceiling") + ". No call was launched.");
    }
    const entries: LedgerCall[] = calls.map(call => ({ ...call, phase, id: randomUUID(),
      status: "reserved", startedAt: new Date().toISOString() }));
    ledger.calls.push(...entries);
    return entries;
  });
}

export function settleCall(id: string, args: {
  success: boolean;
  settledUsd: number | null;
  costProvenance: string;
  error?: string;
}, path = LEDGER_PATH): LedgerCall {
  return withLedgerLock(path, ledger => {
    const entry = ledger.calls.find(call => call.id === id);
    if (!entry) throw new Error("Spend ledger reservation was not found.");
    if (entry.status !== "reserved") throw new Error("Spend ledger reservation has already been settled.");
    const reported = args.settledUsd;
    const committedUsd = reported === null ? entry.reservedUsd : reported;
    entry.status = args.success ? "completed" : "failed";
    entry.settledUsd = reported;
    entry.committedUsd = committedUsd;
    entry.costProvenance = args.costProvenance;
    entry.settledAt = new Date().toISOString();
    if (args.error) entry.error = args.error;
    return entry;
  });
}

export function settleRemaining(reservations: LedgerCall[], error: string, path = LEDGER_PATH) {
  for (const reservation of reservations) {
    const latest = readLedger(path).calls.find(call => call.id === reservation.id);
    if (!latest || latest.status !== "reserved") continue;
    settleCall(reservation.id, { success: false, settledUsd: null,
      costProvenance: "failed-attempt-charged-reserved-upper-bound", error }, path);
  }
}

export function writeRunLedgerSnapshot(directory: string, path = LEDGER_PATH) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "spend-ledger.json"), JSON.stringify(snapshot(path), null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
