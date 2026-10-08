import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPrismaPartitionDownloadRepository,
  type PartitionDownloadRepository
} from "@smedc/db";
import type { StorageAdapter } from "@smedc/storage";
import type { PartitionDownloadLimits } from "@smedc/domain";
import type { ClaimedProcessingRun } from "../worker.js";
import { createMaintenanceTask } from "../maintenance.js";
import {
  buildPartitionDownload,
  PartitionDownloadBuildFailed,
  type PartitionDownloadBuildLimits
} from "./processor.js";

export function createPartitionDownloadRuntime(input: {
  storage: StorageAdapter;
  repository?: PartitionDownloadRepository;
  databaseUrl?: string;
  limits?: PartitionDownloadLimits;
  buildLimits?: PartitionDownloadBuildLimits;
  now?: () => Date;
}) {
  const repository =
    input.repository ??
    createPrismaPartitionDownloadRepository({
      ...(input.databaseUrl ? { databaseUrl: input.databaseUrl } : {}),
      ...(input.limits ? { limits: input.limits } : {})
    });
  const active = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  const scratch = createMaintenanceTask(15 * 60_000);
  const expiry = createMaintenanceTask(5 * 60_000);
  let stopped = false;
  let maintenance: Promise<void> | undefined;
  return {
    job: {
      async process({
        run,
        storage,
        signal
      }: {
        run: ClaimedProcessingRun;
        storage: StorageAdapter;
        signal?: AbortSignal;
      }): Promise<"succeeded" | "superseded" | "failed"> {
        if (stopped || !run.partitionDownloadRequestId || !run.lockedBy)
          throw new Error("PARTITION_DOWNLOAD_RUN_INVALID");
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        controllers.add(controller);
        const work = buildPartitionDownload({
          requestId: run.partitionDownloadRequestId,
          lease: {
            runId: run.id,
            orgId: run.orgId,
            requestId: run.partitionDownloadRequestId,
            workerId: run.lockedBy,
            attemptNumber: run.attemptNumber
          },
          repository,
          storage,
          ...(input.buildLimits ? { limits: input.buildLimits } : {}),
          signal: controller.signal
        });
        active.add(work);
        try {
          return await work;
        } catch (error) {
          if (error instanceof PartitionDownloadBuildFailed) return "failed";
          throw error;
        } finally {
          active.delete(work);
          controllers.delete(controller);
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    maintain(): Promise<void> {
      if (stopped) return Promise.resolve();
      const now = input.now?.() ?? new Date();
      // Exact-key candidate GC is drained by the shared partition import maintenance consumer.
      maintenance ??= (async () => {
        await expiry(now, async () => (await repository.expire(now)) === 100);
        await scratch(now, async () => {
          const root = input.buildLimits?.scratchRoot ?? tmpdir();
          const entries = await readdir(root, { withFileTypes: true }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            }
          );
          for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith("smedc-partition-zip-")) continue;
            const path = join(root, entry.name);
            const info = await stat(path).catch(() => null);
            if (info && info.mtimeMs < now.getTime() - 86400000)
              await rm(path, { recursive: true, force: true });
          }
        });
      })().finally(() => {
        maintenance = undefined;
      });
      return maintenance;
    },
    async disconnect() {
      stopped = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...active, ...(maintenance ? [maintenance] : [])]);
      await repository.disconnect();
    }
  };
}
