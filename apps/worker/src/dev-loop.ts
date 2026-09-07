import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createStorageAdapter } from "@enterprise-hub/storage";
import { createEvidenceIndexerFromEnv } from "./evidence-index.js";
import { loadWorkerRuntimeLimits } from "./config/runtime-limits.js";
import { createPrismaProcessingWorkerRepository, runWorkerLoop } from "./worker.js";

export async function main(): Promise<void> {
  loadDotenv({ quiet: true, override: false });

  const abortController = new AbortController();
  const runtimeLimits = loadWorkerRuntimeLimits(process.env);
  const repository = createPrismaProcessingWorkerRepository(undefined, {
    structuredImportTransactionTimeoutMs: runtimeLimits.structuredImportTransactionTimeoutMs
  });
  const storage = createStorageAdapter(process.env);
  const evidenceIndexer = createEvidenceIndexerFromEnv();

  const stop = () => {
    abortController.abort();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await runWorkerLoop({
      repository,
      storage,
      evidenceIndexer,
      structuredImportBatchInsertSize: runtimeLimits.structuredImportBatchInsertSize,
      workerConcurrency: runtimeLimits.workerConcurrency,
      leaseSeconds: runtimeLimits.workerLeaseSeconds,
      maxAttempts: runtimeLimits.workerMaxAttempts,
      retryBaseMs: runtimeLimits.workerRetryBaseMs,
      retryMaxMs: runtimeLimits.workerRetryMaxMs,
      pollIntervalMs: runtimeLimits.workerPollIntervalMs,
      signal: abortController.signal,
      onResult(result) {
        if (result.processed) {
          console.log(JSON.stringify(result));
        }
      },
      onError(error) {
        console.error(error);
      }
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await repository.disconnect?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
