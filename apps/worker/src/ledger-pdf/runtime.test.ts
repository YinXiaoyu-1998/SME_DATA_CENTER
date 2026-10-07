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
vi.mock("./reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
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
    expect.objectContaining({
      objectKeyPrefix: "tenant/runtime/",
      config: { enabled: false, time: "03:00", timeZone: "Asia/Shanghai" }
    })
  );
  await runtime.maintain();
  expect(mocks.expiry).toHaveBeenCalledWith(expect.anything(), clock);
  await runtime.disconnect();
});

it("checks ZIP expiry and scratch less often while honoring the daily time and catch-up checks", async () => {
  let clock = new Date("2026-10-07T01:59:00Z"); // 09:59 Shanghai
  const runtime = createLedgerWorkerRuntime({
    storage: {} as StorageAdapter,
    scratchRoot: "/synthetic",
    env: {
      DATABASE_URL: "mysql://localhost/ledger_test",
      LEDGER_PDF_RECONCILE_ENABLED: "true",
      LEDGER_PDF_RECONCILE_TIME: "10:00"
    },
    now: () => clock
  });
  try {
    await runtime.maintain(); // Startup checks for a missed schedule.
    clock = new Date("2026-10-07T01:59:30Z");
    await runtime.maintain();
    expect(mocks.daily).toHaveBeenCalledTimes(1);
    expect(mocks.expiry).toHaveBeenCalledTimes(1);
    expect(mocks.scratch).toHaveBeenCalledTimes(1);

    clock = new Date("2026-10-07T02:00:00Z");
    await runtime.maintain();
    expect(mocks.daily).toHaveBeenCalledTimes(2);
    expect(mocks.expiry).toHaveBeenCalledTimes(1);
    expect(mocks.scratch).toHaveBeenCalledTimes(1);

    clock = new Date("2026-10-07T02:04:00Z");
    await runtime.maintain();
    expect(mocks.expiry).toHaveBeenCalledTimes(2);
    expect(mocks.scratch).toHaveBeenCalledTimes(1);
    clock = new Date("2026-10-07T02:14:00Z");
    await runtime.maintain();
    expect(mocks.scratch).toHaveBeenCalledTimes(2);
    expect(mocks.daily).toHaveBeenCalledTimes(2);

    clock = new Date("2026-10-07T03:00:00Z");
    await runtime.maintain();
    expect(mocks.daily).toHaveBeenCalledTimes(3);
    clock = new Date("2026-10-09T04:00:00Z"); // Resume after a missed day.
    await runtime.maintain();
    expect(mocks.daily).toHaveBeenCalledTimes(4);
  } finally {
    await runtime.disconnect();
  }
});

it("retries failed maintenance at the next tick without rerunning successful tasks", async () => {
  let clock = new Date("2026-10-07T02:00:00Z");
  mocks.expiry.mockRejectedValueOnce(new Error("synthetic expiry failure"));
  const runtime = createLedgerWorkerRuntime({
    storage: {} as StorageAdapter,
    scratchRoot: "/synthetic",
    env: { DATABASE_URL: "mysql://localhost/ledger_test" },
    now: () => clock
  });
  try {
    await expect(runtime.maintain()).rejects.toThrow("synthetic expiry failure");
    clock = new Date("2026-10-07T02:01:00Z");
    await runtime.maintain();
    expect(mocks.expiry).toHaveBeenCalledTimes(2);
    expect(mocks.scratch).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.disconnect();
  }
});

it("drains full ZIP expiry batches on subsequent ticks before entering the idle interval", async () => {
  let clock = new Date("2026-10-07T02:00:00Z");
  mocks.expiry.mockResolvedValueOnce(200).mockResolvedValueOnce(1).mockResolvedValue(0);
  const runtime = createLedgerWorkerRuntime({
    storage: {} as StorageAdapter,
    scratchRoot: "/synthetic",
    env: { DATABASE_URL: "mysql://localhost/ledger_test" },
    now: () => clock
  });
  try {
    await runtime.maintain();
    clock = new Date("2026-10-07T02:01:00Z");
    await runtime.maintain();
    expect(mocks.expiry).toHaveBeenCalledTimes(2);
    clock = new Date("2026-10-07T02:02:00Z");
    await runtime.maintain();
    expect(mocks.expiry).toHaveBeenCalledTimes(2);
  } finally {
    await runtime.disconnect();
  }
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
