import { describe, expect, it } from "vitest";
import { loadWorkerRuntimeLimits } from "./runtime-limits.js";

describe("worker runtime limits", () => {
  it("uses the documented defaults", () => {
    expect(loadWorkerRuntimeLimits({})).toEqual({
      maxDocumentChars: 5_000_000,
      maxChunksPerDocument: 5_000,
      structuredImportBatchInsertSize: 500,
      structuredImportTransactionTimeoutMs: 120_000,
      workerConcurrency: 2,
      workerLeaseSeconds: 120,
      workerPollIntervalMs: 1_000,
      workerMaxAttempts: 3,
      workerRetryBaseMs: 1_000,
      workerRetryMaxMs: 60_000,
      partitionImportMaxSourceBytes: 2_147_483_648,
      partitionImportMaxRows: 5_000_000,
      partitionImportMaxPartitions: 10_000,
      partitionImportMaxCanonicalBytes: 8_589_934_592,
      partitionImportWorkDirectory: "/var/lib/smedc/partition-work",
      partitionImportMinFreeBytes: 12_884_901_888,
      partitionImportMaxOpenFiles: 32,
      partitionImportObjectConcurrency: 6,
      partitionImportJobRetentionDays: 30
    });
  });

  it("uses valid worker overrides", () => {
    expect(
      loadWorkerRuntimeLimits({
        MAX_DOCUMENT_CHARS: "1",
        MAX_CHUNKS_PER_DOCUMENT: "2",
        STRUCTURED_IMPORT_BATCH_INSERT_SIZE: "8",
        STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS: "9",
        WORKER_CONCURRENCY: "3",
        WORKER_LEASE_SECONDS: "4",
        WORKER_POLL_INTERVAL_MS: "100",
        WORKER_MAX_ATTEMPTS: "5",
        WORKER_RETRY_BASE_MS: "6",
        WORKER_RETRY_MAX_MS: "7",
        PARTITION_IMPORT_MAX_SOURCE_BYTES: "10",
        PARTITION_IMPORT_MAX_ROWS: "11",
        PARTITION_IMPORT_MAX_PARTITIONS: "12",
        PARTITION_IMPORT_MAX_CANONICAL_BYTES: "13",
        PARTITION_IMPORT_WORK_DIR: "/tmp/partition-work",
        PARTITION_IMPORT_MIN_FREE_BYTES: "14",
        PARTITION_IMPORT_OBJECT_CONCURRENCY: "8",
        PARTITION_IMPORT_JOB_RETENTION_DAYS: "15"
      })
    ).toEqual({
      maxDocumentChars: 1,
      maxChunksPerDocument: 2,
      structuredImportBatchInsertSize: 8,
      structuredImportTransactionTimeoutMs: 9,
      workerConcurrency: 3,
      workerLeaseSeconds: 4,
      workerPollIntervalMs: 100,
      workerMaxAttempts: 5,
      workerRetryBaseMs: 6,
      workerRetryMaxMs: 7,
      partitionImportMaxSourceBytes: 10,
      partitionImportMaxRows: 11,
      partitionImportMaxPartitions: 12,
      partitionImportMaxCanonicalBytes: 13,
      partitionImportWorkDirectory: "/tmp/partition-work",
      partitionImportMinFreeBytes: 14,
      partitionImportMaxOpenFiles: 32,
      partitionImportObjectConcurrency: 8,
      partitionImportJobRetentionDays: 15
    });
  });

  it.each(["not-a-number", "1.5", "0", "-1", "Infinity", "9007199254740992"])(
    "fails fast for invalid WORKER_CONCURRENCY value %s",
    (value) => {
      expect(() => loadWorkerRuntimeLimits({ WORKER_CONCURRENCY: value })).toThrow(
        "WORKER_CONCURRENCY must be a safe integer greater than 0."
      );
    }
  );

  it("preserves the 100ms minimum worker poll interval", () => {
    expect(() => loadWorkerRuntimeLimits({ WORKER_POLL_INTERVAL_MS: "99" })).toThrow(
      "WORKER_POLL_INTERVAL_MS must be a safe integer greater than or equal to 100."
    );
  });

  it("rejects partition object concurrency above the eight-request safety bound", () => {
    expect(() => loadWorkerRuntimeLimits({ PARTITION_IMPORT_OBJECT_CONCURRENCY: "9" })).toThrow(
      "PARTITION_IMPORT_OBJECT_CONCURRENCY must be less than or equal to 8."
    );
  });

  it("rejects a retry base greater than the retry maximum", () => {
    expect(() =>
      loadWorkerRuntimeLimits({ WORKER_RETRY_BASE_MS: "1001", WORKER_RETRY_MAX_MS: "1000" })
    ).toThrow("WORKER_RETRY_BASE_MS must be less than or equal to WORKER_RETRY_MAX_MS.");
  });
});
