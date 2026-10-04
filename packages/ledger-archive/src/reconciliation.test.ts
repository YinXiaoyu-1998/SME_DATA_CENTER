import { describe, expect, it, vi } from "vitest";
import type { LedgerPdfPartition } from "@prisma/client";
import {
  ledgerNeedsRepair,
  mostRecentLedgerScheduleDate,
  reconcileLedgerPage,
  type LedgerReconciliationRepository,
  type LedgerReconciliationState
} from "./reconciliation.js";
const hash = "a".repeat(64);
const key = { orgId: "org", storeName: "Store", purchaseDate: "2026-10-04" };
const source = { sourceFingerprint: hash, rowCount: 1, sources: [] };
const lease = { runId: "processing", lockedBy: "worker", attemptNumber: 1 };
function partition(overrides: Partial<LedgerPdfPartition> = {}): LedgerPdfPartition {
  return {
    dataRevision: 1,
    publishedDataRevision: 1,
    requestedGeneration: 1,
    publishedGeneration: 1,
    publishedSourceFingerprint: hash,
    currentObjectKey: "pdf",
    checksumSha256: hash,
    byteSize: 12n,
    rowCount: 1,
    errorCode: null,
    ...overrides
  } as LedgerPdfPartition;
}
function fixture() {
  const state: LedgerReconciliationState = {
    id: "scan",
    orgId: "org",
    phase: "facts",
    cursor: null,
    scannedCount: 0,
    healthyCount: 0,
    abnormalCount: 0,
    submittedCount: 0,
    inflightSkippedCount: 0,
    failedCount: 0
  };
  const repository = {
    getState: vi.fn().mockResolvedValue(state),
    listKeys: vi.fn().mockResolvedValue({ keys: [key], nextCursor: null }),
    observe: vi.fn().mockResolvedValue({ partition: partition(), source }),
    reserveRepair: vi
      .fn()
      .mockImplementation(async ({ needsRepair }) => (needsRepair ? "submitted" : "healthy")),
    checkpoint: vi.fn().mockResolvedValue(undefined)
  } satisfies LedgerReconciliationRepository;
  const storage = { headObject: vi.fn().mockResolvedValue({ state: "found", size: 12, hash }) };
  return {
    state,
    repository,
    storage,
    run: () => reconcileLedgerPage({ runId: "scan", lease, repository, storage })
  };
}
describe("daily ledger reconciliation policy", () => {
  it("uses the most recent due Shanghai date even at month/year boundaries", () => {
    expect(
      mostRecentLedgerScheduleDate({
        now: new Date("2026-10-03T18:59:59Z"),
        time: "03:00",
        timeZone: "Asia/Shanghai"
      })
    ).toBe("2026-10-03");
    expect(
      mostRecentLedgerScheduleDate({
        now: new Date("2026-10-03T19:00:00Z"),
        time: "03:00",
        timeZone: "Asia/Shanghai"
      })
    ).toBe("2026-10-04");
    expect(
      mostRecentLedgerScheduleDate({
        now: new Date("2026-12-31T18:00:00Z"),
        time: "03:00",
        timeZone: "Asia/Shanghai"
      })
    ).toBe("2026-12-31");
    expect(() =>
      mostRecentLedgerScheduleDate({ now: new Date(), time: "24:00", timeZone: "Asia/Shanghai" })
    ).toThrow("CONFIG_INVALID");
  });
  it("detects missing indexes, revisions, fingerprints, objects and object metadata", () => {
    expect(ledgerNeedsRepair(null, source)).toBe(true);
    expect(ledgerNeedsRepair(partition({ dataRevision: 2 }), source)).toBe(true);
    expect(ledgerNeedsRepair(partition(), { ...source, sourceFingerprint: "b".repeat(64) })).toBe(
      true
    );
    expect(ledgerNeedsRepair(partition(), source, { state: "not_found" })).toBe(true);
    expect(ledgerNeedsRepair(partition(), source, { state: "found", size: 13 })).toBe(true);
    expect(
      ledgerNeedsRepair(partition(), source, { state: "found", size: 12, hash: "b".repeat(64) })
    ).toBe(true);
    expect(ledgerNeedsRepair(partition(), source, { state: "found", size: 12 })).toBe(true);
    expect(ledgerNeedsRepair(partition(), source, { state: "found", size: 12, hash })).toBe(false);
  });
  it("sends emptied index partitions through the same generation path and skips published empties", () => {
    expect(ledgerNeedsRepair(partition(), { ...source, rowCount: 0 })).toBe(true);
    expect(
      ledgerNeedsRepair(partition({ currentObjectKey: null, rowCount: 0 }), {
        ...source,
        rowCount: 0
      })
    ).toBe(false);
  });
  it("healthy checks use HEAD only and advance durable facts to index phase", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ done: false, nextCursor: null, phase: "index" });
    expect(f.repository.reserveRepair).toHaveBeenCalledWith(
      expect.objectContaining({ needsRepair: false })
    );
    expect(f.repository.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        counts: expect.objectContaining({ healthyCount: 1, submittedCount: 0 })
      })
    );
  });
  it("records storage forbidden/timeout/rate-limit failures without rebuilding", async () => {
    for (const code of ["OSS_FORBIDDEN", "ETIMEDOUT", "RATE_LIMITED"]) {
      const f = fixture();
      f.storage.headObject.mockRejectedValue(new Error(code));
      await f.run();
      expect(f.repository.reserveRepair).not.toHaveBeenCalled();
      expect(f.repository.checkpoint).toHaveBeenCalledWith(
        expect.objectContaining({
          counts: expect.objectContaining({ failedCount: 1, submittedCount: 0 })
        })
      );
    }
  });
  it("rereads a stale observation once and reuses inflight/retry jobs", async () => {
    const f = fixture();
    f.storage.headObject.mockResolvedValue({ state: "not_found" });
    f.repository.reserveRepair
      .mockRejectedValueOnce(new Error("LEDGER_OBSERVATION_STALE"))
      .mockResolvedValueOnce("inflight");
    await f.run();
    expect(f.repository.observe).toHaveBeenCalledTimes(2);
    expect(f.repository.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        counts: expect.objectContaining({
          abnormalCount: 1,
          inflightSkippedCount: 1,
          submittedCount: 0
        })
      })
    );
  });
  it("never retries an expired lease or checkpoints its page", async () => {
    const f = fixture();
    f.repository.reserveRepair.mockRejectedValue(new Error("LEDGER_RECONCILIATION_LEASE_LOST"));
    await expect(f.run()).rejects.toThrow("LEASE_LOST");
    expect(f.repository.checkpoint).not.toHaveBeenCalled();
  });
  it("bounds HEAD concurrency at four and yields after at most 200 partitions", async () => {
    const f = fixture();
    f.repository.listKeys.mockResolvedValue({
      keys: Array.from({ length: 200 }, (_, i) => ({ ...key, storeName: `Store ${i}` })),
      nextCursor: "next"
    });
    let active = 0,
      max = 0;
    f.storage.headObject.mockImplementation(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { state: "found", size: 12, hash };
    });
    expect(await f.run()).toEqual({ done: false, nextCursor: "next", phase: "facts" });
    expect(max).toBe(4);
    expect(f.repository.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ counts: expect.objectContaining({ scannedCount: 200 }) })
    );
    await expect(
      reconcileLedgerPage({
        runId: "scan",
        lease,
        repository: f.repository,
        storage: f.storage,
        limit: 201
      })
    ).rejects.toThrow("LIMIT_INVALID");
  });
  it("finishes scanning separately from repair processing", async () => {
    const f = fixture();
    f.state.phase = "index";
    f.storage.headObject.mockResolvedValue({ state: "not_found" });
    expect(await f.run()).toEqual({ done: true, nextCursor: null, phase: "completed" });
    expect(f.repository.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ counts: expect.objectContaining({ submittedCount: 1 }) })
    );
  });
});
