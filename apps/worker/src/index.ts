import { createPartitionDownloadRuntime } from "./partition-download/runtime.js";
import { createLedgerWorkerRuntime } from "./ledger-pdf/runtime.js";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createStorageAdapter } from "@smedc/storage";
import { createEvidenceIndexerFromEnv } from "./evidence-index.js";
import { parseWorkerRetrievalRuntimeConfig } from "./config/retrieval-runtime.js";
import { loadWorkerRuntimeLimits } from "./config/runtime-limits.js";
import { createPrismaProcessingWorkerRepository, runWorkerOnce } from "./worker.js";
import { createPartitionImporter, partitionImportLimitsFromRuntime } from "./partition-import.js";
import { createPrismaCostCardRepository } from "@smedc/db";
import { createCostCardImporter } from "./cost-card-import.js";

export const workerWorkspaceName = "@smedc/worker";

export async function main(): Promise<void> {
  loadDotenv({ quiet: true, override: false });
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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
  const partitionDownloads = createPartitionDownloadRuntime({ storage, limits: runtimeLimits });
  const partitionImporter = createPartitionImporter({
    limits: partitionImportLimitsFromRuntime(runtimeLimits),
    onTimingEvent(event) {
      console.error(JSON.stringify(event));
    }
  });
  const costCardImporter = createCostCardImporter({
    repository: createPrismaCostCardRepository(),
    limits: partitionImportLimitsFromRuntime(runtimeLimits)
  });

  let shutdownFailure: PromiseRejectedResult | undefined;
  try {
    await partitionDownloads.maintain();
    await ledgerRuntime.maintain();
    await partitionImporter.maintain({ storage });
    const result = await runWorkerOnce({
      repository,
      storage,
      signal: abortController.signal,
      evidenceIndexer,
      partitionDownloadJob: partitionDownloads.job,
      ledgerJobs: ledgerRuntime.jobs,
      partitionImporter,
      costCardImporter,
      structuredImportBatchInsertSize: runtimeLimits.structuredImportBatchInsertSize,
      leaseSeconds: runtimeLimits.workerLeaseSeconds,
      maxAttempts: runtimeLimits.workerMaxAttempts,
      retryBaseMs: runtimeLimits.workerRetryBaseMs,
      retryMaxMs: runtimeLimits.workerRetryMaxMs
    });
    console.log(JSON.stringify(result));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    const closed = await Promise.allSettled([
      repository.disconnect?.(),
      partitionImporter.disconnect(),
      costCardImporter.disconnect(),
      ledgerRuntime.disconnect(),
      partitionDownloads.disconnect()
    ]);
    shutdownFailure = closed.find((result) => result.status === "rejected");
  }
  if (shutdownFailure) throw shutdownFailure.reason;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
