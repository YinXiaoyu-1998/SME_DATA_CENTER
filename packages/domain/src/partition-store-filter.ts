import { PARTITION_ERROR_CODES, PartitionContractError } from "./structured-partitions.js";

export function parsePartitionStoreNameContains(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw invalidScope();
  }
  return value.map((item) => {
    if (typeof item !== "string") throw invalidScope();
    const normalized = item.normalize("NFC").trim();
    if (!normalized || normalized.length > 255) throw invalidScope();
    return normalized;
  });
}

function invalidScope(): PartitionContractError {
  return new PartitionContractError(
    PARTITION_ERROR_CODES.invalidStoreNameFilter,
    "storeNameContains must contain 1–20 non-empty strings of at most 255 characters."
  );
}
