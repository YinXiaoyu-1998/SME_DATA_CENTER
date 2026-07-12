import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import { createEvidenceIndexerFromEnv } from "./evidence-index.js";
import { createPrismaProcessingWorkerRepository, runWorkerLoop } from "./worker.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function main(): Promise<void> {
  loadDotenv({ quiet: true, override: false });

  const abortController = new AbortController();
  const repository = createPrismaProcessingWorkerRepository();
  const storage = new LocalFileSystemStorageAdapter();
  const evidenceIndexer = createEvidenceIndexerFromEnv();
  const pollIntervalMs = resolvePollIntervalMs(process.env["WORKER_POLL_INTERVAL_MS"]);

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
      pollIntervalMs,
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

function resolvePollIntervalMs(value: string | undefined): number {
  if (!value) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 100) {
    throw new Error("WORKER_POLL_INTERVAL_MS must be an integer greater than or equal to 100.");
  }

  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
