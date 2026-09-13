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
  dishRows: number;
  businessRows: number;
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

const STRUCTURED_IMPORT_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

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
