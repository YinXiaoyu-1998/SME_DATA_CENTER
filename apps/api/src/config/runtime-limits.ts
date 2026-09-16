import { PHASE3_RUNTIME_LIMIT_DEFAULTS, parsePositiveSafeInteger } from "@smedc/domain";

export interface ApiRuntimeLimits {
  maxUploadBytes: number;
  mcpMaxConcurrentRequests: number;
  maxStructuredImportRows: number;
  maxXlsxSheets: number;
  maxStructuredCellChars: number;
  maxXlsxUncompressedBytes: number;
  maxXlsxZipEntries: number;
  maxXlsxCompressionRatio: number;
  structuredImportBatchInsertSize: number;
  structuredImportTransactionTimeoutMs: number;
  partitionImportMaxSourceBytes: number;
  partitionUploadPartBytes: number;
  partitionUploadSessionTtlSeconds: number;
  partitionManifestMaxPartitions: number;
  partitionManifestUrlTtlSeconds: number;
}

export function loadApiRuntimeLimits(env: NodeJS.ProcessEnv): ApiRuntimeLimits {
  return {
    maxUploadBytes: parsePositiveSafeInteger(env, "MAX_UPLOAD_BYTES", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxUploadBytes
    }),
    mcpMaxConcurrentRequests: parsePositiveSafeInteger(env, "MCP_MAX_CONCURRENT_REQUESTS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.mcpMaxConcurrentRequests
    }),
    maxStructuredImportRows: parsePositiveSafeInteger(env, "MAX_STRUCTURED_IMPORT_ROWS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredImportRows
    }),
    maxXlsxSheets: parsePositiveSafeInteger(env, "MAX_XLSX_SHEETS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxSheets
    }),
    maxStructuredCellChars: parsePositiveSafeInteger(env, "MAX_STRUCTURED_CELL_CHARS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredCellChars
    }),
    maxXlsxUncompressedBytes: parsePositiveSafeInteger(env, "MAX_XLSX_UNCOMPRESSED_BYTES", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxUncompressedBytes
    }),
    maxXlsxZipEntries: parsePositiveSafeInteger(env, "MAX_XLSX_ZIP_ENTRIES", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxZipEntries
    }),
    maxXlsxCompressionRatio: parsePositiveSafeInteger(env, "MAX_XLSX_COMPRESSION_RATIO", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxCompressionRatio
    }),
    structuredImportBatchInsertSize: parsePositiveSafeInteger(
      env,
      "STRUCTURED_IMPORT_BATCH_INSERT_SIZE",
      { defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.structuredImportBatchInsertSize }
    ),
    structuredImportTransactionTimeoutMs: parsePositiveSafeInteger(
      env,
      "STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS",
      { defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.structuredImportTransactionTimeoutMs }
    ),
    partitionImportMaxSourceBytes: parsePositiveSafeInteger(
      env,
      "PARTITION_IMPORT_MAX_SOURCE_BYTES",
      {
        defaultValue: 2_147_483_648
      }
    ),
    partitionUploadPartBytes: parsePositiveSafeInteger(env, "PARTITION_UPLOAD_PART_BYTES", {
      defaultValue: 16_777_216,
      minimum: 5_242_880
    }),
    partitionUploadSessionTtlSeconds: parsePositiveSafeInteger(
      env,
      "PARTITION_UPLOAD_SESSION_TTL_SECONDS",
      {
        defaultValue: 86_400
      }
    ),
    partitionManifestMaxPartitions: parsePositiveSafeInteger(
      env,
      "PARTITION_MANIFEST_MAX_PARTITIONS",
      {
        defaultValue: 10_000
      }
    ),
    partitionManifestUrlTtlSeconds: parsePositiveSafeInteger(
      env,
      "PARTITION_MANIFEST_URL_TTL_SECONDS",
      {
        defaultValue: 900
      }
    )
  };
}
