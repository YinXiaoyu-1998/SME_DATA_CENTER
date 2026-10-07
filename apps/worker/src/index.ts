import { createLedgerWorkerRuntime } from "./ledger-pdf/runtime.js";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createStorageAdapter } from "@smedc/storage";
import { createEvidenceIndexerFromEnv } from "./evidence-index.js";
import { parseWorkerRetrievalRuntimeConfig } from "./config/retrieval-runtime.js";
import { loadWorkerRuntimeLimits } from "./config/runtime-limits.js";
import { createPrismaProcessingWorkerRepository, runWorkerOnce } from "./worker.js";
import { createPartitionImporter, partitionImportLimitsFromRuntime } from "./partition-import.js";

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
  const partitionImporter = createPartitionImporter({
    limits: partitionImportLimitsFromRuntime(runtimeLimits),
    onTimingEvent(event) {
      console.error(JSON.stringify(event));
    }
  });

  let shutdownFailure: PromiseRejectedResult | undefined;
  try {
    await ledgerRuntime.maintain();
    await partitionImporter.maintain({ storage });
    const result = await runWorkerOnce({
      repository,
      storage,
      signal: abortController.signal,
      evidenceIndexer,
      ledgerJobs: ledgerRuntime.jobs,
      partitionImporter,
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
      ledgerRuntime.disconnect()
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
