import { loadPartitionDownloadLimits, type PartitionDownloadLimits } from "@smedc/domain";
import { PHASE3_RUNTIME_LIMIT_DEFAULTS, parsePositiveSafeInteger } from "@smedc/domain";

export interface WorkerRuntimeLimits extends PartitionDownloadLimits {
  maxDocumentChars: number;
  maxChunksPerDocument: number;
  structuredImportBatchInsertSize: number;
  structuredImportTransactionTimeoutMs: number;
  workerConcurrency: number;
  workerLeaseSeconds: number;
  workerPollIntervalMs: number;
  workerMaxAttempts: number;
  workerRetryBaseMs: number;
  workerRetryMaxMs: number;
  ledgerPdfScratchRoot: string;
  partitionImportMaxSourceBytes: number;
  partitionImportMaxRows: number;
  partitionImportMaxPartitions: number;
  partitionImportMaxCanonicalBytes: number;
  partitionImportWorkDirectory: string;
  partitionImportMinFreeBytes: number;
  partitionImportMaxOpenFiles: number;
  partitionImportObjectConcurrency: number;
  partitionImportJobRetentionDays: number;
}

export function loadWorkerRuntimeLimits(env: NodeJS.ProcessEnv): WorkerRuntimeLimits {
  const limits = {
    ...loadPartitionDownloadLimits(env),
    maxDocumentChars: parsePositiveSafeInteger(env, "MAX_DOCUMENT_CHARS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxDocumentChars
    }),
    maxChunksPerDocument: parsePositiveSafeInteger(env, "MAX_CHUNKS_PER_DOCUMENT", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxChunksPerDocument
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
    workerConcurrency: parsePositiveSafeInteger(env, "WORKER_CONCURRENCY", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.workerConcurrency
    }),
    workerLeaseSeconds: parsePositiveSafeInteger(env, "WORKER_LEASE_SECONDS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.workerLeaseSeconds
    }),
    workerPollIntervalMs: parsePositiveSafeInteger(env, "WORKER_POLL_INTERVAL_MS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.workerPollIntervalMs,
      minimum: 100
    }),
    workerMaxAttempts: parsePositiveSafeInteger(env, "WORKER_MAX_ATTEMPTS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.workerMaxAttempts
    }),
    workerRetryBaseMs: parsePositiveSafeInteger(env, "WORKER_RETRY_BASE_MS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.workerRetryBaseMs
    }),
    workerRetryMaxMs: parsePositiveSafeInteger(env, "WORKER_RETRY_MAX_MS", {
      defaultValue: PHASE3_RUNTIME_LIMIT_DEFAULTS.workerRetryMaxMs
    }),
    ledgerPdfScratchRoot: env["LEDGER_PDF_SCRATCH_ROOT"]?.trim() || "/var/lib/smedc/ledger-pdf",
    partitionImportMaxSourceBytes: parsePositiveSafeInteger(
      env,
      "PARTITION_IMPORT_MAX_SOURCE_BYTES",
      { defaultValue: 2_147_483_648 }
    ),
    partitionImportMaxRows: parsePositiveSafeInteger(env, "PARTITION_IMPORT_MAX_ROWS", {
      defaultValue: 5_000_000
    }),
    partitionImportMaxPartitions: parsePositiveSafeInteger(env, "PARTITION_IMPORT_MAX_PARTITIONS", {
      defaultValue: 10_000
    }),
    partitionImportMaxCanonicalBytes: parsePositiveSafeInteger(
      env,
      "PARTITION_IMPORT_MAX_CANONICAL_BYTES",
      { defaultValue: 8_589_934_592 }
    ),
    partitionImportWorkDirectory:
      env["PARTITION_IMPORT_WORK_DIR"]?.trim() || "/var/lib/smedc/partition-work",
    partitionImportMinFreeBytes: parsePositiveSafeInteger(env, "PARTITION_IMPORT_MIN_FREE_BYTES", {
      defaultValue: 12_884_901_888
    }),
    partitionImportMaxOpenFiles: 32,
    partitionImportObjectConcurrency: parsePositiveSafeInteger(
      env,
      "PARTITION_IMPORT_OBJECT_CONCURRENCY",
      { defaultValue: 6 }
    ),
    partitionImportJobRetentionDays: parsePositiveSafeInteger(
      env,
      "PARTITION_IMPORT_JOB_RETENTION_DAYS",
      { defaultValue: 30 }
    )
  };

  if (limits.workerRetryBaseMs > limits.workerRetryMaxMs) {
    throw new Error("WORKER_RETRY_BASE_MS must be less than or equal to WORKER_RETRY_MAX_MS.");
  }
  if (limits.partitionImportObjectConcurrency > 8) {
    throw new Error("PARTITION_IMPORT_OBJECT_CONCURRENCY must be less than or equal to 8.");
  }

  return limits;
}
