import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createStorageAdapter } from "@enterprise-hub/storage";
import { createEvidenceIndexerFromEnv } from "./evidence-index.js";
import { loadWorkerRuntimeLimits } from "./config/runtime-limits.js";
import { createPrismaProcessingWorkerRepository, runWorkerOnce } from "./worker.js";

export const workerWorkspaceName = "@enterprise-hub/worker";

export async function main(): Promise<void> {
  loadDotenv({ quiet: true, override: false });
  const runtimeLimits = loadWorkerRuntimeLimits(process.env);

  const repository = createPrismaProcessingWorkerRepository();
  const storage = createStorageAdapter(process.env);
  const evidenceIndexer = createEvidenceIndexerFromEnv();

  try {
    const result = await runWorkerOnce({
      repository,
      storage,
      evidenceIndexer,
      leaseSeconds: runtimeLimits.workerLeaseSeconds,
      maxAttempts: runtimeLimits.workerMaxAttempts,
      retryBaseMs: runtimeLimits.workerRetryBaseMs,
      retryMaxMs: runtimeLimits.workerRetryMaxMs
    });
    console.log(JSON.stringify(result));
  } finally {
    await repository.disconnect?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
