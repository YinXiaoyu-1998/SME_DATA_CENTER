import { describe, expect, it } from "vitest";
import {
  parsePartitionDownloadManifest,
  canonicalizePartitionDownloadScope,
  partitionDownloadFingerprint,
  assertPartitionDownloadSize
} from "./partition-downloads.js";
const scope = {
  dataset: "business" as const,
  enterpriseKey: "demo",
  enterpriseName: "Demo",
  startDate: "2026-10-01",
  endDate: "2026-10-08"
};
describe("partition download snapshots", () => {
  it("retains provable pre-versioned complete manifests and requires unknown legacy jobs to be rebuilt", () => {
    const entry = {
      id: "p",
      storeKey: "physical-key",
      storeName: "Store A",
      merchantId: null,
      enterpriseName: "Enterprise",
      businessDate: "2026-10-01",
      objectKey: "synthetic/p.csv",
      checksumSha256: "a".repeat(64),
      byteSize: "1",
      rowCount: "1",
      confidentialityLevel: 1
    };
    expect(parsePartitionDownloadManifest([entry])).toEqual([entry]);
    expect(parsePartitionDownloadManifest({ version: 1, entries: [entry] })).toEqual([entry]);
    expect(() => parsePartitionDownloadManifest([{ id: "p" }])).toThrow(
      "PARTITION_DOWNLOAD_REBUILD_REQUIRED"
    );
    expect(() => parsePartitionDownloadManifest([entry, entry])).toThrow(
      "PARTITION_DOWNLOAD_REBUILD_REQUIRED"
    );
    expect(() => parsePartitionDownloadManifest({ scope: "unknown" })).toThrow(
      "PARTITION_DOWNLOAD_REBUILD_REQUIRED"
    );
  });
  it("canonicalizes unordered OR filters and store IDs", () => {
    const a = canonicalizePartitionDownloadScope({
      ...scope,
      storeIds: ["b", "a", "b"],
      storeNameContains: [" 店 ", "A", "店"]
    });
    const b = canonicalizePartitionDownloadScope({
      ...scope,
      storeIds: ["a", "b"],
      storeNameContains: ["A", "店"]
    });
    expect(partitionDownloadFingerprint(a)).toBe(partitionDownloadFingerprint(b));
  });
  it("rejects 501 partitions and 256 MiB plus one before persistence", () => {
    expect(() => assertPartitionDownloadSize(501, 1n)).toThrow("PARTITION_DOWNLOAD_LIMIT_EXCEEDED");
    expect(() => assertPartitionDownloadSize(1, 268435457n)).toThrow(
      "PARTITION_DOWNLOAD_LIMIT_EXCEEDED"
    );
    expect(() => assertPartitionDownloadSize(500, 268435456n)).not.toThrow();
    expect(() => assertPartitionDownloadSize(0, 0n)).not.toThrow();
  });
  it("rejects noncanonical or reversed dates", () => {
    expect(() =>
      canonicalizePartitionDownloadScope({ ...scope, startDate: "2026-02-30" })
    ).toThrow();
    expect(() => canonicalizePartitionDownloadScope({ ...scope, endDate: "2026-09-01" })).toThrow();
  });
});
