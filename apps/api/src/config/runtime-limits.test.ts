import { describe, expect, it } from "vitest";
import { loadApiRuntimeLimits } from "./runtime-limits.js";

describe("API runtime limits", () => {
  it("uses the documented defaults", () => {
    expect(loadApiRuntimeLimits({})).toEqual({
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
      partitionImportMaxSourceBytes: 2_147_483_648,
      partitionUploadPartBytes: 16_777_216,
      partitionUploadSessionTtlSeconds: 86_400,
      partitionManifestMaxPartitions: 10_000,
      partitionManifestUrlTtlSeconds: 900
    });
  });

  it("uses valid API overrides", () => {
    expect(
      loadApiRuntimeLimits({
        MAX_UPLOAD_BYTES: "1",
        MCP_MAX_CONCURRENT_REQUESTS: "2",
        MAX_STRUCTURED_IMPORT_ROWS: "2",
        MAX_XLSX_SHEETS: "3",
        MAX_STRUCTURED_CELL_CHARS: "4",
        MAX_XLSX_UNCOMPRESSED_BYTES: "5",
        MAX_XLSX_ZIP_ENTRIES: "6",
        MAX_XLSX_COMPRESSION_RATIO: "7",
        STRUCTURED_IMPORT_BATCH_INSERT_SIZE: "8",
        STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS: "9",
        PARTITION_IMPORT_MAX_SOURCE_BYTES: "10",
        PARTITION_UPLOAD_PART_BYTES: "5242880",
        PARTITION_UPLOAD_SESSION_TTL_SECONDS: "11",
        PARTITION_MANIFEST_MAX_PARTITIONS: "12",
        PARTITION_MANIFEST_URL_TTL_SECONDS: "13"
      })
    ).toEqual({
      maxUploadBytes: 1,
      mcpMaxConcurrentRequests: 2,
      maxStructuredImportRows: 2,
      maxXlsxSheets: 3,
      maxStructuredCellChars: 4,
      maxXlsxUncompressedBytes: 5,
      maxXlsxZipEntries: 6,
      maxXlsxCompressionRatio: 7,
      structuredImportBatchInsertSize: 8,
      structuredImportTransactionTimeoutMs: 9,
      partitionImportMaxSourceBytes: 10,
      partitionUploadPartBytes: 5_242_880,
      partitionUploadSessionTtlSeconds: 11,
      partitionManifestMaxPartitions: 12,
      partitionManifestUrlTtlSeconds: 13
    });
  });

  it.each(["not-a-number", "1.5", "0", "-1", "Infinity", "9007199254740992"])(
    "fails fast for invalid MAX_UPLOAD_BYTES value %s",
    (value) => {
      expect(() => loadApiRuntimeLimits({ MAX_UPLOAD_BYTES: value })).toThrow(
        "MAX_UPLOAD_BYTES must be a safe integer greater than 0."
      );
    }
  );
});
