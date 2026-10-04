import { createLedgerWorkerRuntime } from "./ledger-pdf/runtime.js";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createStorageAdapter } from "@smedc/storage";
import { createEvidenceIndexerFromEnv } from "./evidence-index.js";
import { parseWorkerRetrievalRuntimeConfig } from "./config/retrieval-runtime.js";
import { loadWorkerRuntimeLimits } from "./config/runtime-limits.js";
import { createPrismaProcessingWorkerRepository, runWorkerLoop } from "./worker.js";
import { createPartitionImporter, partitionImportLimitsFromRuntime } from "./partition-import.js";

export async function main(): Promise<void> {
  loadDotenv({ quiet: true, override: false });

  const abortController = new AbortController();
  const runtimeLimits = loadWorkerRuntimeLimits(process.env);
  const retrievalRuntime = parseWorkerRetrievalRuntimeConfig(process.env);
  const repository = createPrismaProcessingWorkerRepository(undefined, {
    structuredImportTransactionTimeoutMs: runtimeLimits.structuredImportTransactionTimeoutMs,
    evidenceRetrievalConfigVersion: retrievalRuntime.qdrant.retrievalConfigVersion
  });
  const storage = createStorageAdapter(process.env);
  const evidenceIndexer = createEvidenceIndexerFromEnv();
  const ledgerRuntime = createLedgerWorkerRuntime({
    storage,
    scratchRoot: runtimeLimits.ledgerPdfScratchRoot
  });
  const partitionImporter = createPartitionImporter({
    limits: partitionImportLimitsFromRuntime(runtimeLimits),
    onTimingEvent(event) {
      console.log(JSON.stringify(event));
    }
  });

  const stop = () => {
    abortController.abort();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const maintenanceTimer = setInterval(() => {
    void ledgerRuntime.maintain().catch(console.error);
    void partitionImporter.maintain({ storage }).catch(console.error);
  }, 60_000);

  try {
    await ledgerRuntime.maintain();
    await partitionImporter.maintain({ storage });
    await runWorkerLoop({
      repository,
      storage,
      evidenceIndexer,
      ledgerJobs: ledgerRuntime.jobs,
      partitionImporter,
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
    clearInterval(maintenanceTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await repository.disconnect?.();
    await partitionImporter.disconnect();
    await ledgerRuntime.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
