import { expect, it } from "vitest";
import { loadPartitionDownloadLimits } from "./partition-downloads.js";
it("bounds partition bundle resource, active request, and lifetime limits", () => {
  expect(loadPartitionDownloadLimits({})).toEqual({
    partitionDownloadMaxPartitions: 500,
    partitionDownloadMaxBytes: 268435456,
    partitionDownloadMaxActivePerOrg: 16,
    partitionDownloadMaxActivePerRequester: 4,
    partitionDownloadRetentionSeconds: 86400,
    partitionDownloadUrlTtlSeconds: 900
  });
  for (const [key, maximum] of Object.entries({
    PARTITION_DOWNLOAD_MAX_PARTITIONS: 2000,
    PARTITION_DOWNLOAD_MAX_BYTES: 1073741824,
    PARTITION_DOWNLOAD_MAX_ACTIVE_PER_ORG: 64,
    PARTITION_DOWNLOAD_MAX_ACTIVE_PER_REQUESTER: 16,
    PARTITION_DOWNLOAD_RETENTION_SECONDS: 86400,
    PARTITION_DOWNLOAD_URL_TTL_SECONDS: 900
  })) {
    expect(() => loadPartitionDownloadLimits({ [key]: String(maximum) })).not.toThrow();
    for (const value of ["0", "1.5", String(maximum + 1)])
      expect(() => loadPartitionDownloadLimits({ [key]: value })).toThrow(key);
  }
});
