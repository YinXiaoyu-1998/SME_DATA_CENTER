import type { LedgerScope } from "./types.js";

export const LEDGER_SCOPE_MAX_STORES = 50;
export const LEDGER_SCOPE_MAX_DATES = 366;
export const LEDGER_SCOPE_MAX_PARTITIONS = 5_000;
export const LEDGER_PAGE_SIZE = 200;

export function assertLedgerDate(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("LEDGER_SCOPE_INVALID");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    value < "1000-01-01" ||
    value > "9999-12-31" ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("LEDGER_SCOPE_INVALID");
  }
}

export function parseLedgerScope(input: unknown): LedgerScope {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("LEDGER_SCOPE_INVALID");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["storeNames", "dates", "startDate", "endDate"].includes(key))
  )
    throw new Error("LEDGER_SCOPE_INVALID");
  if (
    !Array.isArray(value.storeNames) ||
    value.storeNames.length === 0 ||
    value.storeNames.some(
      (name) =>
        typeof name !== "string" ||
        name.length === 0 ||
        name.length > 512 ||
        name.trim().length === 0
    )
  )
    throw new Error("LEDGER_SCOPE_INVALID");
  const storeNames = [...new Set(value.storeNames as string[])].sort();
  if (storeNames.length > LEDGER_SCOPE_MAX_STORES) throw new Error("LEDGER_SCOPE_LIMIT_EXCEEDED");
  if (value.dates !== undefined) {
    if (
      value.startDate !== undefined ||
      value.endDate !== undefined ||
      !Array.isArray(value.dates) ||
      value.dates.length === 0
    )
      throw new Error("LEDGER_SCOPE_INVALID");
    value.dates.forEach(assertLedgerDate);
    const dates = [...new Set(value.dates as string[])].sort();
    if (dates.length > LEDGER_SCOPE_MAX_DATES) throw new Error("LEDGER_SCOPE_LIMIT_EXCEEDED");
    return { storeNames, dates };
  }
  assertLedgerDate(value.startDate);
  assertLedgerDate(value.endDate);
  if (value.startDate > value.endDate) throw new Error("LEDGER_SCOPE_INVALID");
  const days = (Date.parse(value.endDate) - Date.parse(value.startDate)) / 86_400_000 + 1;
  if (days > LEDGER_SCOPE_MAX_DATES) throw new Error("LEDGER_SCOPE_LIMIT_EXCEEDED");
  return { storeNames, startDate: value.startDate, endDate: value.endDate };
}

/** Canonical dates also make a discrete scope and equivalent inclusive range idempotent. */
export function ledgerScopeDates(scope: LedgerScope): string[] {
  if (scope.dates) return scope.dates;
  const dates: string[] = [];
  for (
    let timestamp = Date.parse(scope.startDate);
    timestamp <= Date.parse(scope.endDate);
    timestamp += 86_400_000
  ) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
}
