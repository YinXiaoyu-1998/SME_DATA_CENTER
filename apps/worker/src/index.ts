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
            console.error(JSON.stringify(event));
          }
        })
      : undefined;

  try {
    await partitionImporter?.maintain({ storage });
    await evidenceIndexer.recoverArtifacts?.();
    const result = await runWorkerOnce({
      repository,
      storage,
      evidenceIndexer,
      partitionImporter,
      jobScope: runtimeLimits.workerJobScope,
      structuredImportBatchInsertSize: runtimeLimits.structuredImportBatchInsertSize,
      leaseSeconds: runtimeLimits.workerLeaseSeconds,
      maxAttempts: runtimeLimits.workerMaxAttempts,
      retryBaseMs: runtimeLimits.workerRetryBaseMs,
      retryMaxMs: runtimeLimits.workerRetryMaxMs
    });
    console.log(JSON.stringify(result));
  } finally {
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
