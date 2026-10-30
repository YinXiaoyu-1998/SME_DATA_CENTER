export const PARTITION_DATASETS = [
  "business",
  "dishes",
  "in_store_orders",
  "takeaway_orders"
] as const;

export type PartitionDatasetName = (typeof PARTITION_DATASETS)[number];

export const PARTITION_ERROR_CODES = {
  invalidStoreNameFilter: "INVALID_PARTITION_STORE_NAME_FILTER",
  uploadSessionRequired: "PARTITION_UPLOAD_SESSION_REQUIRED",
  uploadExpired: "PARTITION_UPLOAD_EXPIRED",
  uploadIncomplete: "PARTITION_UPLOAD_INCOMPLETE",
  sourceChecksumMismatch: "PARTITION_SOURCE_CHECKSUM_MISMATCH",
  sourceDateOutOfRange: "PARTITION_SOURCE_DATE_OUT_OF_RANGE",
  storeIdentityMissing: "PARTITION_STORE_IDENTITY_MISSING",
  storeIdentityConflict: "PARTITION_STORE_IDENTITY_CONFLICT",
  limitExceeded: "PARTITION_LIMIT_EXCEEDED",
  manifestTooLarge: "PARTITION_MANIFEST_TOO_LARGE",
  datasetRequiresPartitionExtract: "DATASET_REQUIRES_PARTITION_EXTRACT"
} as const;

export type PartitionErrorCode = (typeof PARTITION_ERROR_CODES)[keyof typeof PARTITION_ERROR_CODES];

export interface PartitionManifestRequest {
  dataset: PartitionDatasetName;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  storeIds?: string[];
  storeNameContains?: string[];
}

export interface PartitionManifestEntry {
  businessDate: string;
  storeId: string | null;
  storeName: string;
  rowCount: number | string;
  byteSize: number | string;
  checksumSha256: string;
  presignedDownloadUrl: string;
}

export interface PartitionManifest {
  dataset: PartitionDatasetName;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  expiresAt: string;
  partitionCount: number;
  totalRowCount: number | string;
  partitions: PartitionManifestEntry[];
}

export class PartitionContractError extends Error {
  readonly code: PartitionErrorCode;

  constructor(code: PartitionErrorCode, message: string) {
    super(message);
    this.name = "PartitionContractError";
    this.code = code;
  }
}

export function normalizeEnterpriseIdentity(value: string): {
  enterpriseKey: string;
  enterpriseName: string;
} {
  const enterpriseName = normalizeIdentityText(value);
  if (!enterpriseName) {
    throw new PartitionContractError(
      PARTITION_ERROR_CODES.storeIdentityMissing,
      "Enterprise name is required."
    );
  }

  return {
    enterpriseKey: asciiLowercase(enterpriseName),
    enterpriseName
  };
}

export function partitionStoreIdentity(input: {
  merchantId: string | null | undefined;
  storeName: string | null | undefined;
}): {
  storeKey: string;
  merchantId: string | null;
  storeName: string;
} {
  const merchantId = normalizeIdentityText(input.merchantId ?? "");
  const storeName = normalizeIdentityText(input.storeName ?? "");

  if (!merchantId && !storeName) {
    throw new PartitionContractError(
      PARTITION_ERROR_CODES.storeIdentityMissing,
      "Merchant ID or store name is required."
    );
  }

  return {
    storeKey: merchantId ? `merchant:${merchantId}` : `name:${asciiLowercase(storeName)}`,
    merchantId: merchantId || null,
    storeName
  };
}

export function isPartitionDataset(value: string): value is PartitionDatasetName {
  return PARTITION_DATASETS.includes(value as PartitionDatasetName);
}

function normalizeIdentityText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** Order reports were introduced after business authorization; no legacy read entitlement. */
export function isOrderPartitionDataset(value: string): boolean {
  return value === "in_store_orders" || value === "takeaway_orders";
}
