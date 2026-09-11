import { describe, expect, it } from "vitest";
import { loadWorkerRuntimeLimits } from "./runtime-limits.js";

describe("worker runtime limits", () => {
  it("uses the documented defaults", () => {
    expect(loadWorkerRuntimeLimits({})).toEqual({
      maxDocumentChars: 5_000_000,
      maxChunksPerDocument: 5_000,
      evidenceChunkMaxChars: 1_600,
      evidenceChunkOverlapChars: 200,
      structuredImportBatchInsertSize: 500,
      structuredImportTransactionTimeoutMs: 120_000,
      workerConcurrency: 2,
      workerLeaseSeconds: 120,
      workerPollIntervalMs: 1_000,
      workerMaxAttempts: 3,
      workerRetryBaseMs: 1_000,
      workerRetryMaxMs: 60_000
    });
  });

  it("uses valid worker overrides", () => {
    expect(
      loadWorkerRuntimeLimits({
        MAX_DOCUMENT_CHARS: "1",
        MAX_CHUNKS_PER_DOCUMENT: "2",
        EVIDENCE_CHUNK_MAX_CHARS: "10",
        EVIDENCE_CHUNK_OVERLAP_CHARS: "11",
        STRUCTURED_IMPORT_BATCH_INSERT_SIZE: "8",
        STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS: "9",
        WORKER_CONCURRENCY: "3",
        WORKER_LEASE_SECONDS: "4",
        WORKER_POLL_INTERVAL_MS: "100",
        WORKER_MAX_ATTEMPTS: "5",
        WORKER_RETRY_BASE_MS: "6",
        WORKER_RETRY_MAX_MS: "7"
      })
    ).toEqual({
      maxDocumentChars: 1,
      maxChunksPerDocument: 2,
      evidenceChunkMaxChars: 10,
      evidenceChunkOverlapChars: 11,
      structuredImportBatchInsertSize: 8,
      structuredImportTransactionTimeoutMs: 9,
      workerConcurrency: 3,
      workerLeaseSeconds: 4,
      workerPollIntervalMs: 100,
      workerMaxAttempts: 5,
      workerRetryBaseMs: 6,
      workerRetryMaxMs: 7
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

  it("rejects a retry base greater than the retry maximum", () => {
    expect(() =>
      loadWorkerRuntimeLimits({ WORKER_RETRY_BASE_MS: "1001", WORKER_RETRY_MAX_MS: "1000" })
    ).toThrow("WORKER_RETRY_BASE_MS must be less than or equal to WORKER_RETRY_MAX_MS.");
  });
});
