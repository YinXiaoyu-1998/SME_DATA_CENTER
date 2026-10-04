import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@smedc/storage";
const { page, ensure } = vi.hoisted(() => ({ page: vi.fn(), ensure: vi.fn() }));
vi.mock("@smedc/ledger-archive/reconciliation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPrismaLedgerReconciliation: () => ({
    reconcileLedgerPage: page,
    ensureDailyReconciliation: ensure
  })
}));
import {
  createLedgerReconciliationWorker,
  readLedgerReconciliationConfig
} from "./reconciliation.js";
describe("reconciliation worker adapter", () => {
  it("defaults disabled at 03:00 Shanghai and validates configuration", () => {
    expect(readLedgerReconciliationConfig({})).toEqual({
      enabled: false,
      time: "03:00",
      timeZone: "Asia/Shanghai"
    });
    expect(() =>
      readLedgerReconciliationConfig({ LEDGER_PDF_RECONCILIATION_ENABLED: "yes" })
    ).toThrow("CONFIG_INVALID");
    expect(() =>
      readLedgerReconciliationConfig({ LEDGER_PDF_RECONCILIATION_TIMEZONE: "UTC" })
    ).toThrow("CONFIG_INVALID");
  });
  it("passes the exact lease and reports continue vs completed for entrypoint wiring", async () => {
    const worker = createLedgerReconciliationWorker({
      prisma: {} as PrismaClient,
      config: readLedgerReconciliationConfig({})
    });
    const run = {
      id: "processing",
      orgId: "org",
      jobType: "ledger_pdf_reconcile",
      ledgerPdfReconciliationRunId: "scan",
      lockedBy: "worker",
      attemptNumber: 4
    };
    page.mockResolvedValueOnce({ done: false }).mockResolvedValueOnce({ done: true });
    expect(await worker.process({ run, storage: {} as StorageAdapter })).toBe("continue");
    expect(await worker.process({ run, storage: {} as StorageAdapter })).toBe("completed");
    expect(page).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "scan",
        lease: { runId: "processing", lockedBy: "worker", attemptNumber: 4 },
        limit: 200
      })
    );
    await worker.ensureDailyReconciliation();
    expect(ensure).toHaveBeenCalledWith({
      enabled: false,
      time: "03:00",
      timeZone: "Asia/Shanghai"
    });
    await expect(
      worker.process({ run: { ...run, lockedBy: null }, storage: {} as StorageAdapter })
    ).rejects.toThrow("RUN_INVALID");
  });
});
