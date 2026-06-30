import { pathToFileURL } from "node:url";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import { createPrismaProcessingWorkerRepository, runWorkerOnce } from "./worker.js";

export const workerWorkspaceName = "@enterprise-hub/worker";

export async function main(): Promise<void> {
  const repository = createPrismaProcessingWorkerRepository();
  const storage = new LocalFileSystemStorageAdapter();

  try {
    const result = await runWorkerOnce({ repository, storage });
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
