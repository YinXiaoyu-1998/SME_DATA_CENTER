import { parsePositiveSafeInteger, type RuntimeLimitEnv } from "./runtime-limits.js";

export interface PartitionDownloadLimits {
  partitionDownloadMaxPartitions: number;
  partitionDownloadMaxBytes: number;
  partitionDownloadMaxActivePerOrg: number;
  partitionDownloadMaxActivePerRequester: number;
  partitionDownloadRetentionSeconds: number;
  partitionDownloadUrlTtlSeconds: number;
}

export function loadPartitionDownloadLimits(env: RuntimeLimitEnv): PartitionDownloadLimits {
  const bounded = (key: string, defaultValue: number, maximum: number) => {
    const value = parsePositiveSafeInteger(env, key, { defaultValue });
    if (value > maximum) throw new Error(`${key} must be less than or equal to ${maximum}.`);
    return value;
  };
  return {
    partitionDownloadMaxPartitions: bounded("PARTITION_DOWNLOAD_MAX_PARTITIONS", 500, 2_000),
    partitionDownloadMaxBytes: bounded("PARTITION_DOWNLOAD_MAX_BYTES", 268_435_456, 1_073_741_824),
    partitionDownloadMaxActivePerOrg: bounded("PARTITION_DOWNLOAD_MAX_ACTIVE_PER_ORG", 16, 64),
    partitionDownloadMaxActivePerRequester: bounded(
      "PARTITION_DOWNLOAD_MAX_ACTIVE_PER_REQUESTER",
      4,
      16
    ),
    partitionDownloadRetentionSeconds: bounded(
      "PARTITION_DOWNLOAD_RETENTION_SECONDS",
      86_400,
      86_400
    ),
    partitionDownloadUrlTtlSeconds: bounded("PARTITION_DOWNLOAD_URL_TTL_SECONDS", 900, 900)
  };
}

/** Public extract metadata. Counts and byte sizes use base-10 strings to preserve precision. */
export interface PartitionDownloadManifest {
  version: 1;
  dataset: "business" | "dishes";
  enterpriseName: string;
  startDate: string;
  endDate: string;
  filter: { storeIds?: string[]; storeNameContains?: string[] };
  partitionCount: number;
  totalRowCount: string;
  files: PartitionDownloadManifestFile[];
}
export interface PartitionDownloadManifestFile {
  fileName: string;
  businessDate: string;
  storeId: string | null;
  storeName: string;
  rowCount: string;
  byteSize: string;
  checksumSha256: string;
}
