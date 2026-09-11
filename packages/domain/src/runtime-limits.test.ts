import { describe, expect, it } from "vitest";
import { PHASE3_RUNTIME_LIMIT_DEFAULTS, parsePositiveSafeInteger } from "./runtime-limits.js";

describe("Phase 3 runtime limit primitives", () => {
  it("provides the authoritative immutable defaults", () => {
    expect(PHASE3_RUNTIME_LIMIT_DEFAULTS).toEqual({
      maxUploadBytes: 52_428_800,
      mcpMaxConcurrentRequests: 8,
      maxStructuredImportRows: 100_000,
      maxXlsxSheets: 20,
      maxStructuredCellChars: 32_767,
      maxXlsxUncompressedBytes: 209_715_200,
      maxXlsxZipEntries: 10_000,
      maxXlsxCompressionRatio: 100,
      structuredImportBatchInsertSize: 500,
      structuredImportTransactionTimeoutMs: 120_000,
      maxDocumentChars: 5_000_000,
      maxChunksPerDocument: 5_000,
      evidenceChunkMaxChars: 1_600,
      evidenceChunkOverlapChars: 200,
      evidenceSectionMaxChars: 6_000,
      evidenceSectionMaxChunks: 6,
      workerConcurrency: 2,
      workerLeaseSeconds: 120,
      workerPollIntervalMs: 1_000,
      workerMaxAttempts: 3,
      workerRetryBaseMs: 1_000,
      workerRetryMaxMs: 60_000
    });
    expect(Object.isFrozen(PHASE3_RUNTIME_LIMIT_DEFAULTS)).toBe(true);
  });

  it("uses a default for missing or whitespace-only values", () => {
    expect(parsePositiveSafeInteger({}, "LIMIT", { defaultValue: 7 })).toBe(7);
    expect(parsePositiveSafeInteger({ LIMIT: "  \t " }, "LIMIT", { defaultValue: 7 })).toBe(7);
  });

  it("accepts a positive safe integer override", () => {
    expect(parsePositiveSafeInteger({ LIMIT: "42" }, "LIMIT", { defaultValue: 7 })).toBe(42);
  });

  it.each(["abc", "1.5", "0", "-1", "Infinity", "9007199254740992"])(
    "rejects invalid positive integer value %s",
    (value) => {
      expect(() =>
        parsePositiveSafeInteger({ LIMIT: value }, "LIMIT", { defaultValue: 7 })
      ).toThrow("LIMIT must be a safe integer greater than 0.");
    }
  );

  it("enforces a configured minimum", () => {
    expect(() =>
      parsePositiveSafeInteger({ LIMIT: "99" }, "LIMIT", { defaultValue: 100, minimum: 100 })
    ).toThrow("LIMIT must be a safe integer greater than or equal to 100.");
  });
});
