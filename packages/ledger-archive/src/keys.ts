import { createHash } from "node:crypto";
import { assertLedgerDate } from "./scope.js";
import type { LedgerPartitionKey } from "./types.js";

export const LEDGER_OSS_MAX_OBJECT_KEY_BYTES = 1_023;
// Reserve the widest possible filename for the schema's unsigned generation counter.
export const LEDGER_PDF_MAX_GENERATION = 4_294_967_295;

export function ledgerStoreNameHash(storeName: string): string {
  return createHash("sha256").update(storeName, "utf8").digest("hex");
}

function assertUtf8String(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new Error("LEDGER_PARTITION_KEY_INVALID");
  }
}

function pathSegment(value: string): string {
  if (!value || value.trim().length === 0) throw new Error("LEDGER_PARTITION_KEY_INVALID");
  assertUtf8String(value);
  if (value === "." || value === "..") return value.replaceAll(".", "%2E");
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return character === "%" ||
        character === "/" ||
        character === "\\" ||
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
        ? encodeURIComponent(character)
        : character;
    })
    .join("");
}

/** Mirrors the OSS adapter's slash normalization; configuration is trusted, never request input. */
export function normalizeLedgerObjectKeyPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  assertUtf8String(normalized);
  if (
    normalized &&
    (normalized.includes("\\") ||
      normalized.split("/").some((segment) => !segment || segment === "." || segment === ".."))
  ) {
    throw new Error("LEDGER_OBJECT_KEY_PREFIX_INVALID");
  }
  return normalized;
}

export function assertLedgerObjectKeyByteLength(objectKey: string, objectKeyPrefix = ""): void {
  assertUtf8String(objectKey);
  const prefix = normalizeLedgerObjectKeyPrefix(objectKeyPrefix);
  const physicalKey = prefix ? `${prefix}/${objectKey}` : objectKey;
  if (!physicalKey) throw new Error("LEDGER_OBJECT_KEY_INVALID");
  if (Buffer.byteLength(physicalKey, "utf8") > LEDGER_OSS_MAX_OBJECT_KEY_BYTES)
    throw new Error("LEDGER_OBJECT_KEY_TOO_LONG");
}

/** Returns a logical key; the prefix is included in validation but applied only by storage. */
export function createLedgerPdfObjectKey(
  key: LedgerPartitionKey,
  generationId: number,
  objectKeyPrefix = ""
): string {
  assertLedgerDate(key.purchaseDate);
  if (
    !Number.isSafeInteger(generationId) ||
    generationId < 1 ||
    generationId > LEDGER_PDF_MAX_GENERATION
  )
    throw new Error("LEDGER_GENERATION_INVALID");
  const objectKey = `org/${pathSegment(key.orgId)}/ledger_records/${pathSegment(key.storeName)}/${key.purchaseDate.replaceAll("-", "/")}/台账_${generationId}.pdf`;
  assertLedgerObjectKeyByteLength(objectKey, objectKeyPrefix);
  return objectKey;
}

/** Conservative admission guard before reserving any generation. */
export function assertLedgerPartitionObjectKeyFits(
  key: LedgerPartitionKey,
  objectKeyPrefix = ""
): void {
  createLedgerPdfObjectKey(key, LEDGER_PDF_MAX_GENERATION, objectKeyPrefix);
}
