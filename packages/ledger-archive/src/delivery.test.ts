import { describe, expect, it, vi } from "vitest";
import {
  createLedgerPdfDelivery,
  ledgerBundleEntriesEqual,
  parseLedgerBundleManifest,
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
    auditDenied: vi.fn(async () => {}),
    facts: vi.fn(async () =>
      [1, 2, 3].map((i) => ({
        key: entry(`2026-10-0${i}`).key,
        status: "ready" as const,
        entry: entry(`2026-10-0${i}`)
      }))
    ),
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
  it("rejects a cutover during signing and keeps the owner's successful task status", async () => {
    const f = fixture();
    const authorization = {
      orgId: "org",
      employeeId: employee.id,
      role: "employee" as const,
      disabled: false,
      clearance: 1,
      mode: "legacy" as const,
      authorizationVersion: "7",
      categories: [],
      grants: []
    };
    vi.mocked(f.repository.currentEmployee)
      .mockResolvedValueOnce({ ...employee, authorization })
      .mockResolvedValue({
        ...employee,
        authorization: { ...authorization, mode: "enabled", authorizationVersion: "8" }
      });
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
        manifest: { version: 1, scope, entries: [entry()] },
        zipObjectKey: "bundle.zip",
        zipExpiresAt: new Date("2026-10-05"),
        errorCode: null
      }
    });
    await expect(
      f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" })
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    expect(await f.delivery.status({ employee, requestId: "download" })).toMatchObject({
      status: "succeeded"
    });
  });
  it("reports an unknown old manifest as requiring rebuild while preserving successful owner progress", async () => {
    const f = fixture();
    vi.mocked(f.repository.request).mockResolvedValue({
      kind: "download",
      status: "succeeded",
      scope,
      items: [],
      rebuildRequired: true,
      bundle: null
    });
    expect(await f.delivery.status({ employee, requestId: "old" })).toMatchObject({
      status: "succeeded",
      errorCode: "LEDGER_DOWNLOAD_REBUILD_REQUIRED"
    });
    await expect(f.delivery.issueLedgerBundleUrl({ employee, requestId: "old" })).rejects.toThrow(
      "LEDGER_DOWNLOAD_REBUILD_REQUIRED"
    );
    expect(f.storage.createDownloadUrl).not.toHaveBeenCalled();
  });

  it("compares known nested manifest values after a MySQL JSON-style key reorder", async () => {
    function reorder(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reorder);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, child]) => [key, reorder(child)])
        );
      return value;
    }
    expect(
      ledgerBundleEntriesEqual(
        [entry()],
        [{ ...entry(), sources: [{ ...entry().sources[0]!, confidentialityLevel: 3 }] }]
      )
    ).toBe(true);
    const f = fixture();
    const entries = [1, 2, 3].map((i) => entry(`2026-10-0${i}`));
    const manifest = parseLedgerBundleManifest(
      JSON.parse(JSON.stringify(reorder({ version: 1, scope, entries })))
    );
    expect(ledgerBundleEntriesEqual(entries, manifest.entries)).toBe(true);
    for (const changed of [
      { ...entry(), key: { ...entry().key, orgId: "other" } },
      { ...entry(), partitionId: "other" },
      { ...entry(), generation: 2 },
      { ...entry(), dataRevision: 2 },
      { ...entry(), sourceFingerprint: "d".repeat(64) },
      { ...entry(), objectKey: "other" },
      { ...entry(), checksumSha256: "d".repeat(64) },
      { ...entry(), byteSize: 11 },
      ...["sourceDocumentId", "kind", "checksumSha256"].map((field) => ({
        ...entry(),
        sources: [{ ...entry().sources[0]!, [field]: "changed" }]
      }))
    ])
      expect(ledgerBundleEntriesEqual([entry()], [changed as LedgerBundleEntry])).toBe(false);
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
        manifest,
        zipObjectKey: "bundle.zip",
        zipExpiresAt: new Date("2026-10-05"),
        errorCode: null
      }
    });
    await expect(
      f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" })
    ).resolves.toHaveProperty("downloadUrl");
    vi.mocked(f.repository.facts).mockResolvedValue(
      entries.slice(0, 2).map((e) => ({ key: e.key, status: "ready", entry: e }))
    );
    await expect(
      f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" })
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
    expect(await f.delivery.status({ employee, requestId: "download" })).toMatchObject({
      status: "succeeded"
    });
    expect(f.storage.createDownloadUrl).toHaveBeenCalledTimes(1);
  });
  it("exposes owner task outcomes independently of current resource visibility", async () => {
    const f = fixture();
    vi.mocked(f.repository.facts).mockResolvedValue([]);
    const request = {
      kind: "refresh" as const,
      status: "succeeded",
      scope,
      items: [],
      bundle: null,
      allowEmptyRequest: true
    };
    vi.mocked(f.repository.request).mockResolvedValue(request);
    expect(await f.delivery.status({ employee, requestId: "empty" })).toMatchObject({
      status: "succeeded",
      partitions: []
    });
    vi.mocked(f.repository.request).mockResolvedValue({
      ...request,
      allowEmptyRequest: false,
      items: [{ key: entry().key, status: "empty" }],
      visibleEmptyKeys: [entry().key]
    });
    expect(await f.delivery.status({ employee, requestId: "empty" })).toMatchObject({
      status: "succeeded",
      partitions: [{ storeName: "门店", purchaseDate: "2026-10-01", status: "empty" }]
    });
    vi.mocked(f.repository.request).mockResolvedValue({
      ...request,
      allowEmptyRequest: false,
      items: [{ key: entry().key, status: "failed" }]
    });
    expect(await f.delivery.status({ employee, requestId: "hidden" })).toMatchObject({
      status: "failed"
    });
  });
  it("returns only safe per-item diagnostics and visible authorized replacement references", async () => {
    const f = fixture();
    vi.mocked(f.repository.request).mockResolvedValue({
      kind: "refresh",
      status: "partial_failed",
      scope,
      bundle: null,
      items: [
        { key: entry().key, status: "failed", errorCode: "LEDGER_LIMIT_EXCEEDED" },
        {
          key: entry("2026-10-02").key,
          status: "failed",
          errorCode: "database SQL private-object/source-id"
        },
        {
          key: entry("2026-10-03").key,
          status: "superseded",
          latestRequest: { requestId: "authorized-replacement", status: "queued" }
        },
        {
          key: { ...entry().key, storeName: "hidden" },
          status: "failed",
          errorCode: "private-error",
          latestRequest: { requestId: "hidden-request", status: "failed" }
        }
      ]
    });
    const result = await f.delivery.status({ employee, requestId: "refresh" });
    expect(result.partitions).toMatchObject([
      { errorCode: "LEDGER_LIMIT_EXCEEDED" },
      { errorCode: "LEDGER_GENERATION_FAILED" },
      { latestRequest: { requestId: "authorized-replacement", status: "queued" } },
      {
        errorCode: "LEDGER_GENERATION_FAILED",
        latestRequest: { requestId: "hidden-request", status: "failed" }
      }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|SQL|source-id/);
  });
  it("captures exactly three existing PDFs for four dates and omits private metadata", async () => {
    const f = fixture();
    await f.delivery.requestLedgerBundle({ employee, scope, idempotencyKey: "key" });
    expect(f.repository.facts).toHaveBeenCalledWith(employee, scope, { requireComplete: true });
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
  it("keeps employee delivery read-only for generation and rechecks disabled accounts", async () => {
    const f = fixture();
    expect(f.delivery).not.toHaveProperty("refresh");
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
  it("returns owner task progress independently of resource grant changes", async () => {
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
    expect(result.status).toBe("partial_failed");
    expect(result.partitions).toHaveLength(2);
    expect(f.repository.facts).not.toHaveBeenCalled();
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
  it("keeps succeeded status after scope revocation, refuses links, and permits restored access", async () => {
    const f = fixture();
    const entries = [entry(), entry("2026-10-02")];
    const record = {
      kind: "download" as const,
      status: "succeeded",
      scope,
      items: [],
      bundle: {
        requestId: "download",
        orgId: "org",
        employeeId: employee.id,
        status: "succeeded",
        manifest: { version: 1 as const, scope, entries },
        zipObjectKey: "bundle.zip",
        zipExpiresAt: new Date("2026-10-05"),
        errorCode: null
      }
    };
    vi.mocked(f.repository.request).mockResolvedValue(record);
    vi.mocked(f.repository.facts).mockResolvedValue([
      { key: entries[0]!.key, status: "ready", entry: entries[0]! }
    ]);
    expect(await f.delivery.status({ employee, requestId: "download" })).toMatchObject({
      status: "succeeded",
      partitions: expect.arrayContaining([
        { storeName: "门店", purchaseDate: "2026-10-02", status: "succeeded" }
      ])
    });
    expect(f.repository.facts).not.toHaveBeenCalled();
    await expect(
      f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" })
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
    expect(record.status).toBe("succeeded");
    expect(f.repository.auditDenied).toHaveBeenCalledWith(
      employee,
      "download",
      "LEDGER_PDF_UNAVAILABLE"
    );
    vi.mocked(f.repository.facts).mockResolvedValue(
      [...entries, entry("2026-10-03")].map((e) => ({ key: e.key, status: "ready", entry: e }))
    );
    expect(
      await f.delivery.issueLedgerBundleUrl({ employee, requestId: "download" })
    ).toHaveProperty("downloadUrl");
    expect(record.bundle.manifest.entries).toEqual(entries);
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
