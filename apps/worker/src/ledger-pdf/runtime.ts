import {
  createPrismaLedgerBundleArchive,
  enqueueExpiredLedgerBundles,
  processLedgerBundle
} from "./bundle.js";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { AliyunOssStorageAdapter, type StorageAdapter } from "@smedc/storage";
import { createLedgerPdfProcessor } from "./processor.js";
import { createMaintenanceTask } from "../maintenance.js";
import { mostRecentLedgerScheduleDate } from "@smedc/ledger-archive/reconciliation";
import {
  createLedgerReconciliationWorker,
  readLedgerReconciliationConfig
} from "./reconciliation.js";

/** One lifecycle for all ledger jobs in both production and one-shot workers. */
export function createLedgerWorkerRuntime(input: {
  storage: StorageAdapter;
  scratchRoot: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}) {
  const env = input.env ?? process.env;
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required for ledger jobs");
  const config = readLedgerReconciliationConfig(env);
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const generator = createLedgerPdfProcessor({ databaseUrl, scratchRoot: input.scratchRoot });
  const reconciliation = createLedgerReconciliationWorker({
    prisma,
    objectKeyPrefix:
      input.storage instanceof AliyunOssStorageAdapter ? input.storage.keyPrefix : "",
    config,
    ...(input.now ? { now: input.now } : {})
  });
  const bundleArchive = createPrismaLedgerBundleArchive({
    prisma,
    storage: input.storage,
    ...(input.now ? { now: input.now } : {})
  });
  const scratch = createMaintenanceTask(15 * 60_000);
  const expiry = createMaintenanceTask(5 * 60_000);
  const daily = createMaintenanceTask(60 * 60_000, (now) => {
    const date = mostRecentLedgerScheduleDate({ now, ...config });
    // Shanghai has no DST. Check at the next configured time, or hourly for missed/new work.
    return new Date(`${date}T${config.time}:00+08:00`).getTime() + 24 * 60 * 60_000;
  });
  let maintenance: Promise<void> | undefined;
  let stopped = false;
  return {
    jobs: {
      ledger_pdf_generate: generator,
      ledger_pdf_reconcile: reconciliation,
      ledger_pdf_bundle: {
        process({ run, storage, signal }: Parameters<typeof generator.process>[0]) {
          if (!run.ledgerArtifactRequestId || !run.lockedBy)
            throw new Error("LEDGER_BUNDLE_RUN_INVALID");
          return processLedgerBundle({
            requestId: run.ledgerArtifactRequestId,
            lease: { runId: run.id, lockedBy: run.lockedBy, attemptNumber: run.attemptNumber },
            archive: bundleArchive,
            storage,
            ...(signal ? { signal } : {}),
            ...(input.now ? { now: input.now } : {})
          });
        }
      }
    },
    maintain(): Promise<void> {
      if (stopped) return Promise.resolve();
      const now = input.now?.() ?? new Date();
      // A slow cycle must not overlap the timer's next maintenance cycle.
      maintenance ??= Promise.allSettled([
        scratch(now, () => generator.maintain()),
        daily(now, () => reconciliation.ensureDailyReconciliation()),
        // Expiry applies even during backfill with delivery/reconciliation disabled.
        expiry(now, async () => (await enqueueExpiredLedgerBundles(prisma, now)) === 200)
      ])
        .then((results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        })
        .finally(() => {
          maintenance = undefined;
        });
      return maintenance;
    },
    async disconnect() {
      stopped = true;
      try {
        await maintenance;
      } finally {
        await Promise.all([generator.disconnect(), prisma.$disconnect()]);
      }
    }
  };
}
