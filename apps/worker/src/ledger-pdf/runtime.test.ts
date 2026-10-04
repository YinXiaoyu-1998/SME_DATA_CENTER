import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  scratch: vi.fn(),
  daily: vi.fn(),
  expiry: vi.fn(),
  disconnect: vi.fn(),
  generatorDisconnect: vi.fn(),
  reconcileFactory: vi.fn(),
  bundle: vi.fn()
}));
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    $disconnect = mocks.disconnect;
  }
}));
vi.mock("@smedc/db", () => ({ createDatabaseAdapter: vi.fn() }));
vi.mock("./processor.js", () => ({
  createLedgerPdfProcessor: () => ({
    process: vi.fn(),
    maintain: mocks.scratch,
    disconnect: mocks.generatorDisconnect
  })
}));
vi.mock("./reconciliation.js", () => ({
  readLedgerReconciliationConfig: (env: NodeJS.ProcessEnv) => ({
    enabled: env["LEDGER_PDF_RECONCILE_ENABLED"] === "true"
  }),
  createLedgerReconciliationWorker: mocks.reconcileFactory
}));
vi.mock("./bundle.js", () => ({
  createPrismaLedgerBundleArchive: vi.fn(),
  enqueueExpiredLedgerBundles: mocks.expiry,
  processLedgerBundle: mocks.bundle
}));
import { AliyunOssStorageAdapter, type StorageAdapter } from "@smedc/storage";
import { createLedgerWorkerRuntime } from "./runtime.js";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scratch.mockResolvedValue(undefined);
  mocks.daily.mockResolvedValue(undefined);
  mocks.expiry.mockResolvedValue(0);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.generatorDisconnect.mockResolvedValue(undefined);
  mocks.reconcileFactory.mockReturnValue({
    process: vi.fn(),
    ensureDailyReconciliation: mocks.daily
  });
});
it("registers all handlers with the trusted prefix and expires ZIPs when reconciliation is disabled", async () => {
  // No OSS constructor/network: a trusted adapter prototype supplies its physical prefix.
  const storage = Object.assign(
    Object.create(AliyunOssStorageAdapter.prototype) as StorageAdapter,
    { keyPrefix: "tenant/runtime/" }
  );
  const clock = new Date("2026-10-04T00:00:00Z");
  const runtime = createLedgerWorkerRuntime({
    storage,
    scratchRoot: "/synthetic",
    env: { DATABASE_URL: "mysql://localhost/ledger_test", LEDGER_PDF_RECONCILE_ENABLED: "false" },
    now: () => clock
  });
  expect(Object.keys(runtime.jobs)).toEqual([
    "ledger_pdf_generate",
    "ledger_pdf_reconcile",
    "ledger_pdf_bundle"
  ]);
  expect(mocks.reconcileFactory).toHaveBeenCalledWith(
    expect.objectContaining({ objectKeyPrefix: "tenant/runtime/", config: { enabled: false } })
  );
  await runtime.maintain();
  expect(mocks.expiry).toHaveBeenCalledWith(expect.anything(), clock);
  await runtime.disconnect();
});
it("coalesces timer cycles and waits for every maintenance operation before disconnect after failure", async () => {
  let finish!: () => void;
  mocks.scratch.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  mocks.daily.mockRejectedValue(new Error("synthetic schedule failure"));
  const runtime = createLedgerWorkerRuntime({
    storage: {} as StorageAdapter,
    scratchRoot: "/synthetic",
    env: { DATABASE_URL: "mysql://localhost/ledger_test" }
  });
  const cycle = runtime.maintain();
  const observed = cycle.catch((error: unknown) => error);
  expect(runtime.maintain()).toBe(cycle);
  const stopped = runtime.disconnect().catch((error: unknown) => error);
  await Promise.resolve();
  expect(mocks.disconnect).not.toHaveBeenCalled();
  expect(mocks.expiry).toHaveBeenCalledTimes(1);
  finish();
  expect(await observed).toEqual(new Error("synthetic schedule failure"));
  expect(await stopped).toEqual(new Error("synthetic schedule failure"));
  expect(mocks.disconnect).toHaveBeenCalledOnce();
  expect(mocks.generatorDisconnect).toHaveBeenCalledOnce();
  await runtime.maintain();
  expect(mocks.expiry).toHaveBeenCalledTimes(1);
});
