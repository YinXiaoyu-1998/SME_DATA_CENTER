import { describe, expect, it, vi } from "vitest";
import {
  createLedgerPdfDelivery,
  type LedgerBundleEntry,
  type LedgerDeliveryRepository,
  type LedgerDeliveryEmployee
} from "./delivery.js";
import type { StorageAdapter } from "@smedc/storage";
const employee: LedgerDeliveryEmployee = {
  id: "employee",
  orgId: "org",
  role: "employee",
  clearance: 1,
  disabled: false
};
const scope = {
  storeNames: ["门店"],
  dates: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]
};
function entry(date = "2026-10-01"): LedgerBundleEntry {
  return {
    key: { orgId: "org", storeName: "门店", purchaseDate: date },
    partitionId: date,
    generation: 1,
    dataRevision: 1,
    sourceFingerprint: "a".repeat(64),
    objectKey: "private.pdf",
    checksumSha256: "b".repeat(64),
    byteSize: 10,
    sources: [
      {
        sourceDocumentId: "private-source",
        kind: "ledger",
        confidentialityLevel: 1,
        checksumSha256: "c".repeat(64)
      }
    ]
  };
}
function fixture() {
  const repository: LedgerDeliveryRepository = {
    currentEmployee: vi.fn(async (e) => (e.disabled ? null : e)),
    facts: vi.fn(async () =>
      [1, 2, 3].map((i) => ({
        key: entry(`2026-10-0${i}`).key,
        status: "ready" as const,
        entry: entry(`2026-10-0${i}`)
      }))
    ),
    refresh: vi.fn(async () => ({ requestId: "refresh", status: "queued" })),
    reserveBundle: vi.fn(async () => ({ requestId: "download", status: "queued" })),
    request: vi.fn(async () => null)
  };
  const storage = {
    headObject: vi.fn(async () => ({ state: "found", size: 10 })),
    createDownloadUrl: vi.fn(async () => "https://signed.invalid/fresh")
  } as unknown as StorageAdapter;
  return {
    repository,
    storage,
    delivery: createLedgerPdfDelivery({
      repository,
      storage,
      cursorSecret: "secret",
      now: () => new Date("2026-10-04T00:00:00Z")
    })
  };
}
describe("authorized ledger PDF delivery", () => {
  it("captures exactly three existing PDFs for four dates and omits private metadata", async () => {
    const f = fixture();
    await f.delivery.requestLedgerBundle({ employee, scope, idempotencyKey: "key" });
    expect(f.repository.reserveBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ entries: expect.arrayContaining([entry()]) })
      })
    );
    expect(vi.mocked(f.repository.reserveBundle).mock.calls[0]![0].manifest.entries).toHaveLength(
      3
    );
    const coverage = await f.delivery.coverage({ employee, scope });
    expect(JSON.stringify(coverage)).not.toMatch(/private|source|generation|objectKey/);
  });
  it("rejects visible pending data and no-data scopes without reserving", async () => {
    const f = fixture();
    vi.mocked(f.repository.facts)
      .mockResolvedValueOnce([{ key: entry().key, status: "pending", entry: null }])
      .mockResolvedValueOnce([]);
    await expect(
      f.delivery.requestLedgerBundle({ employee, scope, idempotencyKey: "key" })
    ).rejects.toThrow("LEDGER_PDF_NOT_READY");
    await expect(
      f.delivery.requestLedgerBundle({ employee, scope, idempotencyKey: "key" })
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
    expect(f.repository.reserveBundle).not.toHaveBeenCalled();
  });
  it("allows low-clearance admin refresh but rechecks disabled accounts", async () => {
    const f = fixture();
    await f.delivery.refresh({
      employee: { ...employee, role: "admin", clearance: 0 },
      scope,
      idempotencyKey: "k"
    });
    await expect(f.delivery.refresh({ employee, scope, idempotencyKey: "k" })).rejects.toThrow(
      "ADMIN_REQUIRED"
    );
    await expect(
      f.delivery.coverage({ employee: { ...employee, disabled: true }, scope })
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
  });
  it("encrypts page cursors and binds them to permission and query", async () => {
    const f = fixture();
    vi.mocked(f.repository.facts).mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => ({
        key: entry().key,
        status: "ready",
        entry: entry(String(i))
      }))
    );
    const first = await f.delivery.coverage({ employee, scope });
    expect(first.partitions).toHaveLength(200);
    expect(Buffer.from(first.nextCursor!, "base64url").toString()).not.toContain("门店");
    await expect(
      f.delivery.coverage({
        employee: { ...employee, clearance: 0 },
        scope,
        cursor: first.nextCursor!
      })
    ).rejects.toThrow("LEDGER_CURSOR_INVALID");
    await expect(
      f.delivery.coverage({
        employee,
        scope: { ...scope, storeNames: ["other"] },
        cursor: first.nextCursor!
      })
    ).rejects.toThrow("LEDGER_CURSOR_INVALID");
    expect(
      (await f.delivery.coverage({ employee, scope, cursor: first.nextCursor! })).partitions
    ).toHaveLength(1);
  });
  it("filters refresh status and removes hidden failure counts and global status", async () => {
    const f = fixture();
    vi.mocked(f.repository.request).mockResolvedValue({
      kind: "refresh",
      status: "partial_failed",
      scope,
      items: [
        { key: entry().key, status: "succeeded" },
        { key: { ...entry().key, storeName: "hidden" }, status: "failed" }
      ],
      bundle: null
    });
    const result = await f.delivery.status({ employee, requestId: "refresh" });
    expect(result.status).toBe("succeeded");
    expect(result.partitions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/hidden|counts|partial_failed/);
  });
  it("signs fresh links only for unchanged completed manifests and rechecks after signing", async () => {
    const f = fixture();
    const entries = [1, 2, 3].map((i) => entry(`2026-10-0${i}`));
    vi.mocked(f.repository.request).mockResolvedValue({
      kind: "download",
      status: "succeeded",
      scope,
      items: [],
      bundle: {
        requestId: "download",
        orgId: "org",
        employeeId: employee.id,
        status: "succeeded",
        manifest: { version: 1, scope, entries },
        zipObjectKey: "bundle.zip",
        zipExpiresAt: new Date("2026-10-05"),
        errorCode: null
      }
    });
    await f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" });
    await f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" });
    expect(f.storage.createDownloadUrl).toHaveBeenCalledTimes(2);
    vi.mocked(f.repository.facts).mockResolvedValue(
      entries.map((e) => ({ key: e.key, status: "ready", entry: { ...e, generation: 2 } }))
    );
    await expect(
      f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" })
    ).rejects.toThrow("LEDGER_PDF_BUNDLE_STALE");
    expect(f.storage.createDownloadUrl).toHaveBeenCalledTimes(2);
  });
  it("caps link lifetime to remaining retention and refuses a revoked account after signing", async () => {
    const f = fixture();
    const entries = [1, 2, 3].map((i) => entry(`2026-10-0${i}`));
    vi.mocked(f.repository.request).mockResolvedValue({
      kind: "download",
      status: "succeeded",
      scope,
      items: [],
      bundle: {
        requestId: "download",
        orgId: "org",
        employeeId: employee.id,
        status: "succeeded",
        manifest: { version: 1, scope, entries },
        zipObjectKey: "bundle.zip",
        zipExpiresAt: new Date("2026-10-04T00:00:10Z"),
        errorCode: null
      }
    });
    await f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" });
    expect(f.storage.createDownloadUrl).toHaveBeenCalledWith("bundle.zip", {
      expiresInSeconds: 10,
      downloadFileName: "台账.zip"
    });
    vi.mocked(f.storage.createDownloadUrl).mockImplementation(async () => {
      vi.mocked(f.repository.currentEmployee).mockResolvedValue(null);
      return "https://signed.invalid";
    });
    await expect(
      f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" })
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
  });
});
