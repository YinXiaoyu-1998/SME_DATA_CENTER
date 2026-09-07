import { PHASE3_RUNTIME_LIMIT_DEFAULTS, parsePositiveSafeInteger } from "@enterprise-hub/domain";

export interface WorkerRuntimeLimits {
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
}

export function loadWorkerRuntimeLimits(env: NodeJS.ProcessEnv): WorkerRuntimeLimits {
  const limits = {
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
    })
  };

  if (limits.workerRetryBaseMs > limits.workerRetryMaxMs) {
    throw new Error("WORKER_RETRY_BASE_MS must be less than or equal to WORKER_RETRY_MAX_MS.");
  }

  return limits;
}
