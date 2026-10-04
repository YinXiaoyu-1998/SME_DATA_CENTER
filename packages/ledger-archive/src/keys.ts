import { createHash } from "node:crypto";
import { assertLedgerDate } from "./scope.js";
import type { LedgerPartitionKey } from "./types.js";

export function ledgerStoreNameHash(storeName: string): string {
  return createHash("sha256").update(storeName, "utf8").digest("hex");
}

function pathSegment(value: string): string {
  if (!value || value.trim().length === 0) throw new Error("LEDGER_PARTITION_KEY_INVALID");
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

export function createLedgerPdfObjectKey(key: LedgerPartitionKey, generationId: number): string {
  assertLedgerDate(key.purchaseDate);
  if (!Number.isSafeInteger(generationId) || generationId < 1)
    throw new Error("LEDGER_GENERATION_INVALID");
  return `org/${pathSegment(key.orgId)}/ledger_records/${pathSegment(key.storeName)}/${key.purchaseDate.replaceAll("-", "/")}/台账_${generationId}.pdf`;
}
