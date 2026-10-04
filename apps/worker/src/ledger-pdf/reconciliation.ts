import type { PrismaClient } from "@prisma/client";
import {
  createPrismaLedgerReconciliation,
  LEDGER_RECONCILIATION_DEFAULTS,
  mostRecentLedgerScheduleDate
} from "@smedc/ledger-archive/reconciliation";
import type { StorageAdapter } from "@smedc/storage";

export function readLedgerReconciliationConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env["LEDGER_PDF_RECONCILIATION_ENABLED"] ?? "false";
  if (!["true", "false"].includes(enabled)) throw new Error("LEDGER_RECONCILIATION_CONFIG_INVALID");
  const time = env["LEDGER_PDF_RECONCILIATION_TIME"] ?? LEDGER_RECONCILIATION_DEFAULTS.time;
  const timeZone =
    env["LEDGER_PDF_RECONCILIATION_TIMEZONE"] ?? LEDGER_RECONCILIATION_DEFAULTS.timeZone;
  mostRecentLedgerScheduleDate({ now: new Date(0), time, timeZone });
  return { enabled: enabled === "true", time, timeZone };
}

/** Maintenance schedules durable jobs; worker calls process once per claimed page then yields. */
export function createLedgerReconciliationWorker(input: {
  prisma: PrismaClient;
  objectKeyPrefix?: string;
  now?: () => Date;
  config?: ReturnType<typeof readLedgerReconciliationConfig>;
}) {
  const service = createPrismaLedgerReconciliation(input);
  const config = input.config ?? readLedgerReconciliationConfig();
  return {
    ensureDailyReconciliation() {
      return service.ensureDailyReconciliation(config);
    },
    async process({
      run,
      storage,
      signal
    }: {
      run: {
        id: string;
        orgId: string;
        jobType: string;
        lockedBy: string | null;
        attemptNumber: number;
        ledgerPdfReconciliationRunId?: string | null;
      };
      storage: StorageAdapter;
      signal?: AbortSignal;
    }): Promise<"completed" | "continue"> {
      if (
        run.jobType !== "ledger_pdf_reconcile" ||
        !run.ledgerPdfReconciliationRunId ||
        !run.lockedBy
      )
        throw new Error("LEDGER_RECONCILIATION_RUN_INVALID");
      const result = await service.reconcileLedgerPage({
        runId: run.ledgerPdfReconciliationRunId,
        lease: { runId: run.id, lockedBy: run.lockedBy, attemptNumber: run.attemptNumber },
        storage,
        limit: 200,
        signal
      });
      return result.done ? "completed" : "continue";
    }
  };
}
