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
  const evidenceIndexer = createEvidenceIndexerFromEnv({
    storage,
    pdfArtifacts: repository.pdfArtifacts
  });
  const partitionImporter =
    runtimeLimits.workerJobScope === "general"
      ? createPartitionImporter({
          limits: partitionImportLimitsFromRuntime(runtimeLimits),
          onTimingEvent(event) {
            console.log(JSON.stringify(event));
          }
        })
      : undefined;

  const stop = () => {
    abortController.abort();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let maintenance: Promise<void> | undefined;
  const maintain = () => {
    if (maintenance) return;
    maintenance = (async () => {
      await partitionImporter?.maintain({ storage });
      await evidenceIndexer.recoverArtifacts?.();
    })()
      .catch(console.error)
      .finally(() => {
        maintenance = undefined;
      });
  };
  const maintenanceTimer = setInterval(maintain, 60_000);

  try {
    if (runtimeLimits.workerJobScope === "pdf") maintain();
    else await partitionImporter?.maintain({ storage });
    await runWorkerLoop({
      repository,
      storage,
      evidenceIndexer,
      partitionImporter,
      jobScope: runtimeLimits.workerJobScope,
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
    await maintenance;
    await repository.disconnect?.();
    await partitionImporter?.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
