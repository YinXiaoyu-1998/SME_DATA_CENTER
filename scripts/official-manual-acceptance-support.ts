import { parse as parseCsv } from "csv-parse/sync";
import { COST_CARD_UPLOAD_SCHEMA } from "@smedc/domain";
import { createHash } from "node:crypto";

import { isStagingRuntimeDatabaseUrl } from "./staging-runtime-targets.js";

export {
  STAGING_RDS_DATABASE,
  STAGING_RDS_HOST,
  STAGING_RDS_USER
} from "./staging-runtime-targets.js";

export interface StructuredWindow {
  dates: [string, string, string];
  startDate: string;
  endDate: string;
  invalidDate: string;
  startCompact: string;
  endCompact: string;
  invalidCompact: string;
  monthLabel: string;
  weekLabel: string;
}

export interface CleanupCounts {
  documents: number;
  importBatches: number;
  partitionImportJobs: number;
  structuredPartitions: number;
  costCards: number;
  costCardResources: number;
  costCardSourceResources: number;
  costCardResourceScopes: number;
  storageGarbage: number;
  vipRows: number;
  dishCatalogRows: number;
  deliveryLedgerRows: number;
  supplierCatalogRows: number;
  quarantineCertificates: number;
  windowClaims: number;
  qdrantPoints: number;
  storageObjects: number;
}

export interface StructuredImportPollResult {
  importBatch: {
    importBatchId: string;
    status: string;
  };
}

export interface CurrentEnterpriseHubUserResult {
  user: {
    displayName: string;
    email: string;
    role: string;
    clearance: number;
  };
}

export interface AcceptanceScope {
  reuseSession?: string | undefined;
  documentIds: string[];
  partitionJobIds: string[];
  ledgerRequestIds?: string[];
}

export function validateAcceptanceScope(scope: AcceptanceScope): void {
  if (scope.reuseSession && !/^[A-Za-z0-9._+@-]+$/.test(scope.reuseSession))
    throw new Error("Existing-session email contains unsupported characters.");
  const ids = [...scope.documentIds, ...scope.partitionJobIds, ...(scope.ledgerRequestIds ?? [])];
  if (ids.length && !scope.reuseSession)
    throw new Error("Explicit cleanup IDs require --reuse-session=<expected-email>.");
  if (ids.length > 200 || ids.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id)))
    throw new Error("Invalid acceptance cleanup IDs.");
}

export function isReusedAcceptanceAccount(
  result: CurrentEnterpriseHubUserResult,
  expectedEmail: string
): boolean {
  return (
    result.user.email === expectedEmail &&
    result.user.role === "admin" &&
    result.user.displayName.trim().length > 0 &&
    Number.isInteger(result.user.clearance) &&
    result.user.clearance >= 0 &&
    result.user.clearance <= 3
  );
}

const STRUCTURED_IMPORT_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

export type AcceptanceAccount = "employee-low" | "employee-high" | "admin";

export function acceptanceAccountEmails(runId: string): string[] {
  return [
    `manual-full-flow-low-${runId}@example.invalid`,
    `manual-full-flow-high-${runId}@example.invalid`,
    `manual-acceptance-admin-${runId}@example.invalid`,
    // Retain cleanup ownership of older, interrupted runs.
    `manual-full-flow-${runId}@example.invalid`,
    `manual-acceptance-${runId}@example.invalid`
  ];
}

export function isAcceptanceAccount(
  result: CurrentEnterpriseHubUserResult,
  runId: string,
  account: AcceptanceAccount
): boolean {
  const index = account === "employee-low" ? 0 : account === "employee-high" ? 1 : 2;
  return (
    result.user.email === acceptanceAccountEmails(runId)[index] &&
    result.user.displayName.trim().length > 0 &&
    result.user.role === (account === "admin" ? "admin" : "employee") &&
    result.user.clearance === (account === "employee-high" ? 3 : 0)
  );
}

export async function pollStructuredImportStatus<T extends StructuredImportPollResult>(input: {
  importBatchId: string;
  getStatus: () => Promise<T>;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}): Promise<T> {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + STRUCTURED_IMPORT_POLL_TIMEOUT_MS;
  let delayMs = 2_000;

  while (now() < deadline) {
    await sleep(Math.min(delayMs, deadline - now()));
    const status = await input.getStatus();

    if (status.importBatch.importBatchId !== input.importBatchId) {
      throw new Error("Structured import status returned an unexpected import batch.");
    }

    if (["applied", "rejected", "failed"].includes(status.importBatch.status)) {
      return status;
    }

    delayMs = delayMs === 2_000 ? 5_000 : delayMs === 5_000 ? 10_000 : 15_000;
  }

  throw new Error("Structured import is still processing after 10 minutes.");
}

export function assertStagingRuntimeDatabaseTarget(databaseUrl: string): void {
  if (!isStagingRuntimeDatabaseUrl(databaseUrl)) {
    throw new Error(
      "Official manual controller cleanup must run inside staging against the private RDS endpoint."
    );
  }
}

export function isLowClearanceAcceptanceEmployee(
  result: CurrentEnterpriseHubUserResult,
  expectedEmails: ReadonlySet<string>
): boolean {
  const user = result.user;
  return (
    expectedEmails.has(user.email) &&
    user.displayName.trim().length > 0 &&
    user.role === "employee" &&
    user.clearance === 0
  );
}

export function createStructuredWindow(runId: string, attempt: number): StructuredWindow {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("Structured-window attempt must be a non-negative integer.");
  }
  const digest = createHash("sha256").update(`${runId}:${attempt}`).digest();
  const year = 2040 + (digest.readUInt16BE(0) % 40);
  const monthIndex = digest[2]! % 12;
  const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1));
  const firstDay = firstOfMonth.getUTCDay() || 7;
  const firstMondayOffset = (8 - firstDay) % 7;
  const start = addUtcDays(firstOfMonth, firstMondayOffset + (digest[3]! % 4) * 7);
  const dates = [0, 1, 2].map((dayOffset) => isoDate(addUtcDays(start, dayOffset))) as [
    string,
    string,
    string
  ];
  const invalidDate = isoDate(addUtcDays(start, 3));
  const month = String(start.getUTCMonth() + 1).padStart(2, "0");

  return {
    dates,
    startDate: dates[0],
    endDate: dates[2],
    invalidDate,
    startCompact: compactDate(dates[0]),
    endCompact: compactDate(dates[2]),
    invalidCompact: compactDate(invalidDate),
    monthLabel: `${year}/${month}`,
    weekLabel: `${year}第${String(isoWeek(start)).padStart(2, "0")}周`
  };
}

export function rewriteKnownValuesFixture(source: string, window: StructuredWindow): string {
  return source
    .replaceAll("2026-07-01", window.dates[0])
    .replaceAll("2026-07-02", window.dates[1])
    .replaceAll("2026-07-03", window.dates[2])
    .replaceAll("2026/07", window.monthLabel)
    .replaceAll("2026第27周", window.weekLabel);
}

export async function deleteStorageObjects(
  storage: { deleteObject(key: string): Promise<void> },
  keys: string[]
): Promise<void> {
  for (const key of keys) {
    await storage.deleteObject(key);
  }
}

export function assertCleanupCountsAreZero(counts: CleanupCounts): void {
  const residue = Object.entries(counts).filter(([, count]) => count !== 0);
  if (residue.length > 0) {
    throw new Error(
      `Official manual acceptance cleanup left residue: ${residue
        .map(([name, count]) => `${name}=${count}`)
        .join(", ")}`
    );
  }
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function isoWeek(date: Date): number {
  const thursday = new Date(date);
  const day = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Local changed-workflow oracle; never uploads data or invokes the official suite. */
export function readCostCardAcceptanceCsv(
  content: string,
  identity: { spuId: string; skuId: string }
): Record<string, string>[] {
  const expectedHeaders = [
    ...COST_CARD_UPLOAD_SCHEMA.map((field) => field.sourceColumn),
    "source_sheet_index",
    "source_sheet_name",
    "source_row_number"
  ];
  const records: string[][] = parseCsv(content, { skip_empty_lines: true });
  const headers = records.shift();
  if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders) || !records.length)
    throw new Error("Expected a complete 38-column cost-card CSV.");
  return records.map((values) => {
    if (values.length !== expectedHeaders.length) throw new Error("Incomplete cost-card CSV row.");
    const row = Object.fromEntries(expectedHeaders.map((name, index) => [name, values[index]!]));
    if (row["菜品SPU编码"] !== identity.spuId || row["菜品SKU编码"] !== identity.skuId)
      throw new Error("Cost-card CSV identity mismatch.");
    if (
      !/^\d+$/.test(row["source_sheet_index"]!) ||
      !row["source_sheet_name"] ||
      !/^[1-9]\d*$/.test(row["source_row_number"]!)
    )
      throw new Error("Cost-card CSV lacks source locations.");
    return row;
  });
}
