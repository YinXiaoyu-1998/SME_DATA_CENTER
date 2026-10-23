import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@smedc/storage";
import {
  createPrismaLedgerDeliveryRepository,
  createLedgerPdfDelivery,
  type LedgerDeliveryEmployee
} from "./delivery.js";
import { readLedgerSourceMetadata } from "./source-reader.js";
vi.mock("./source-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./source-reader.js")>()),
  readLedgerSourceMetadata: vi.fn()
}));
const hash = "a".repeat(64);
const employee: LedgerDeliveryEmployee = {
  id: "e",
  orgId: "org",
  disabled: false,
  clearance: 0,
  role: "employee"
};
const key = { orgId: "org", storeName: "Store", purchaseDate: "2026-10-01" };
const ledger = {
  sourceDocumentId: "ledger",
  kind: "ledger" as const,
  checksumSha256: hash,
  confidentialityLevel: 0
};
const photo = {
  sourceDocumentId: "photo",
  kind: "certificate" as const,
  checksumSha256: hash,
  confidentialityLevel: 3
};
function document(id: string, level = 0, kind = "structured") {
  return {
    id,
    confidentialityLevel: level,
    status: "active",
    archivedAt: null,
    checksumSha256: hash,
    documentKind: kind,
    businessResources: [],
    importBatch: { orgId: "org", status: "applied", archivedAt: null, dataset: "delivery_ledger" },
    quarantineCertificate: { orgId: "org" }
  };
}
function fixture() {
  const query = vi.fn(async () => [key]);
  const tx = {
    $queryRaw: vi.fn(async () => []),
    businessAuthorizationState: { findUnique: vi.fn(async () => null) },
    businessCategory: { findMany: vi.fn(async () => []) },
    businessGrant: { findMany: vi.fn(async () => []) },
    employee: { findFirst: vi.fn(async () => employee) },
    $queryRawUnsafe: vi.fn(async () => []),
    document: {
      findMany: vi.fn(async () => [document("ledger")]),
      findFirstOrThrow: vi.fn(async () => document("supplier", 3))
    },
    ledgerPdfPartition: {
      findUnique: vi.fn(async () => ({
        id: "p",
        ...key,
        requestedGeneration: 1,
        publishedGeneration: 1,
        dataRevision: 1,
        publishedDataRevision: 1,
        publishedSourceFingerprint: hash,
        currentObjectKey: "existing.pdf",
        checksumSha256: hash,
        byteSize: 10n,
        sources: [ledger]
      }))
    }
  };
  const prisma = {
    $queryRaw: query,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    employee: { findFirst: vi.fn(async () => employee) },
    document: { findMany: vi.fn(async () => [document("ledger")]) },
    ledgerArtifactRequestItem: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null)
    },
    ledgerArtifactRequest: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null)
    }
  };
  tx.document.findMany = prisma.document.findMany;
  tx.employee.findFirst = prisma.employee.findFirst;
  Object.assign(tx.employee, {
    findUnique: (...args: unknown[]) =>
      (tx.employee.findFirst as (...args: unknown[]) => unknown)(...args)
  });
  const storage = {
    headObject: vi.fn(async () => ({ state: "found", size: 10, hash }))
  } as unknown as StorageAdapter;
  const repository = createPrismaLedgerDeliveryRepository({
    prisma: prisma as unknown as PrismaClient,
    storage
  });
  return { prisma, tx, storage, repository };
}
beforeEach(() =>
  vi
    .mocked(readLedgerSourceMetadata)
    .mockResolvedValue({ sourceFingerprint: hash, rowCount: 1, sources: [ledger] })
);
describe("Prisma delivery current data boundaries", () => {
  it("rejects a source revision changed between selection and reservation", async () => {
    const f = fixture();
    const scope = { storeNames: [key.storeName], dates: [key.purchaseDate] };
    const facts = await f.repository.facts(employee, scope);
    const pointer = await f.tx.ledgerPdfPartition.findUnique();
    const create = vi.fn(async () => ({ id: "bundle", status: "queued" }));
    Object.assign(f.tx, {
      ledgerArtifactRequest: { findUnique: vi.fn(async () => null), create },
      processingRun: { create: vi.fn() }
    });
    Object.assign(f.tx.ledgerPdfPartition, {
      findMany: vi.fn(async () => [
        {
          ...pointer,
          purchaseDate: new Date(key.purchaseDate),
          dataRevision: 2
        }
      ])
    });
    await expect(
      f.repository.reserveBundle({
        employee,
        manifest: { version: 1, scope, entries: [facts[0]!.entry!] },
        idempotencyKey: "changed",
        fingerprint: "changed"
      })
    ).rejects.toThrow("LEDGER_PDF_BUNDLE_STALE");
    expect(create).not.toHaveBeenCalled();
  });
  it("reads an exact browser selection without enumerating unrelated catalog partitions, and still rejects revoked sources", async () => {
    const f = fixture();
    // A large unrelated candidate set must never be expanded for a selected key.
    f.prisma.$queryRaw.mockRejectedValue(new Error("unselected catalog exceeds 5000 candidates"));
    const delivery = createLedgerPdfDelivery({
      repository: f.repository,
      storage: f.storage,
      cursorSecret: "test"
    });
    const selection = [{ storeName: key.storeName, purchaseDate: key.purchaseDate }];
    expect(await delivery.coverageForBrowser({ employee, selection })).toEqual({
      partitions: [{ ...selection[0], status: "ready", byteSize: 10 }],
      nextCursor: null
    });
    f.prisma.document.findMany.mockResolvedValue([{ ...document("ledger"), status: "archived" }]);
    expect((await delivery.coverageForBrowser({ employee, selection })).partitions).toEqual([]);
    await expect(
      delivery.requestSelectedLedgerBundle({ employee, selection, idempotencyKey: "revoked" })
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
    await expect(delivery.openLedgerPdf({ employee, selection: selection[0]! })).rejects.toThrow(
      "LEDGER_PDF_UNAVAILABLE"
    );
  });
  it("keeps the current prior PDF readable after a voluntary failed refresh and requires HEAD hash", async () => {
    const f = fixture();
    const pointer = await f.tx.ledgerPdfPartition.findUnique();
    f.tx.ledgerPdfPartition.findUnique.mockResolvedValue({
      ...pointer,
      requestedGeneration: 2,
      errorCode: "LEDGER_RENDER_FAILED"
    } as never);
    const scope = { storeNames: [key.storeName], dates: [key.purchaseDate] };
    expect((await f.repository.facts(employee, scope))[0]).toMatchObject({
      status: "ready",
      entry: { generation: 1 }
    });
    vi.mocked(f.storage.headObject).mockResolvedValue({ state: "found", size: 10 });
    expect((await f.repository.facts(employee, scope))[0]?.status).toBe("missing");
    f.tx.ledgerPdfPartition.findUnique.mockResolvedValue({
      ...pointer,
      requestedGeneration: 2,
      dataRevision: 2
    });
    expect((await f.repository.facts(employee, scope))[0]?.status).toBe("stale");
  });
  it("authorizes no-item and current empty publications only for their owner", async () => {
    const f = fixture();
    const request = {
      kind: "refresh",
      status: "succeeded",
      scope: { storeNames: [key.storeName], dates: [key.purchaseDate] },
      actorKind: "employee",
      actorEmployeeId: employee.id,
      items: []
    };
    f.prisma.ledgerArtifactRequest.findFirst.mockResolvedValue(request);
    expect(await f.repository.request(employee, "empty")).toMatchObject({
      allowEmptyRequest: true
    });
    expect(
      await f.repository.request({ ...employee, id: "admin", role: "admin" }, "empty")
    ).toMatchObject({ allowEmptyRequest: false });
    const pointer = await f.tx.ledgerPdfPartition.findUnique();
    f.tx.ledgerPdfPartition.findUnique.mockResolvedValue({
      ...pointer,
      storeName: key.storeName,
      purchaseDate: new Date(key.purchaseDate),
      rowCount: 0,
      currentObjectKey: null,
      sources: []
    } as never);
    vi.mocked(readLedgerSourceMetadata).mockResolvedValue({
      sourceFingerprint: hash,
      rowCount: 0,
      sources: []
    });
    f.prisma.ledgerArtifactRequest.findFirst.mockResolvedValue({
      ...request,
      items: [
        {
          partitionId: "p",
          generation: 1,
          status: "empty",
          errorCode: null,
          partition: { storeName: key.storeName, purchaseDate: new Date(key.purchaseDate) }
        }
      ]
    });
    expect(await f.repository.request(employee, "empty")).toMatchObject({
      items: [{ key, status: "empty" }]
    });
    expect(
      await f.repository.request({ ...employee, id: "admin", role: "admin" }, "empty")
    ).toMatchObject({ items: [{ key, status: "empty" }] });
    vi.mocked(readLedgerSourceMetadata).mockResolvedValue({
      sourceFingerprint: hash,
      rowCount: 1,
      sources: [photo]
    });
    expect(await f.repository.request(employee, "empty")).toMatchObject({
      items: [{ key, status: "empty" }]
    });
  });
  it("looks up only owner-authorized replacement requests independently of source visibility", async () => {
    const f = fixture();
    const item = {
      partitionId: "p",
      generation: 1,
      status: "superseded",
      errorCode: null,
      partition: { storeName: key.storeName, purchaseDate: new Date(key.purchaseDate) }
    };
    f.prisma.ledgerArtifactRequest.findFirst.mockResolvedValue({
      kind: "refresh",
      status: "succeeded",
      actorKind: "employee",
      actorEmployeeId: employee.id,
      scope: { storeNames: [key.storeName], dates: [key.purchaseDate] },
      items: [item]
    });
    f.prisma.ledgerArtifactRequestItem.findFirst.mockResolvedValue({
      requestId: "replacement",
      status: "queued"
    });
    expect(await f.repository.request(employee, "old")).toMatchObject({
      items: [{ latestRequest: { requestId: "replacement", status: "queued" } }]
    });
    expect(f.prisma.ledgerArtifactRequestItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: "org",
          partitionId: "p",
          generation: { gt: 1 },
          request: { actorKind: "employee", actorEmployeeId: "e", kind: "refresh" }
        }
      })
    );
    vi.mocked(readLedgerSourceMetadata).mockResolvedValue({
      rowCount: 1,
      sourceFingerprint: "b".repeat(64),
      sources: [ledger, photo]
    });
    expect(await f.repository.request(employee, "old")).toMatchObject({
      items: [{ latestRequest: { requestId: "replacement", status: "queued" } }]
    });
    expect(f.prisma.ledgerArtifactRequestItem.findFirst).toHaveBeenCalledTimes(2);
  });
  it("checks current account plus every published dependency without loading business payloads", async () => {
    const f = fixture();
    expect(
      (
        await f.repository.facts(employee, {
          storeNames: [key.storeName],
          dates: [key.purchaseDate]
        })
      )[0]?.status
    ).toBe("ready");
    expect(readLedgerSourceMetadata).toHaveBeenCalledWith(f.tx, key);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    expect(f.storage.headObject).toHaveBeenCalledWith("existing.pdf");
    vi.mocked(f.prisma.document.findMany).mockResolvedValue([
      { ...document("ledger"), status: "archived" }
    ]);
    expect(
      await f.repository.facts(employee, { storeNames: [key.storeName], dates: [key.purchaseDate] })
    ).toEqual([]);
    expect(f.storage.headObject).toHaveBeenCalledTimes(1);
  });
  it("a high-clearance certificate hides the whole pending day", async () => {
    const f = fixture();
    vi.mocked(readLedgerSourceMetadata).mockResolvedValue({
      sourceFingerprint: "b".repeat(64),
      rowCount: 1,
      sources: [ledger, photo]
    });
    f.prisma.document.findMany.mockResolvedValue([
      document("ledger"),
      document("photo", 3, "quarantine_certificate")
    ]);
    expect(
      await f.repository.facts(employee, { storeNames: [key.storeName], dates: [key.purchaseDate] })
    ).toEqual([]);
    expect(f.storage.headObject).not.toHaveBeenCalled();
  });
  it("rejects an explicit complete scope when an existing PDF is not authorized", async () => {
    const f = fixture();
    vi.mocked(readLedgerSourceMetadata).mockResolvedValue({
      rowCount: 1,
      sourceFingerprint: hash,
      sources: [ledger, photo]
    });
    expect(
      await f.repository.facts(employee, { storeNames: [key.storeName], dates: [key.purchaseDate] })
    ).toEqual([]);
    await expect(
      f.repository.facts(
        employee,
        { storeNames: [key.storeName], dates: [key.purchaseDate] },
        { requireComplete: true }
      )
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
  });
  it("pending authorization includes a supplier only when the current catalog actually supplies a unique value", async () => {
    const f = fixture();
    vi.mocked(readLedgerSourceMetadata).mockResolvedValue({
      sourceFingerprint: "b".repeat(64),
      rowCount: 1,
      sources: [ledger]
    });
    f.tx.$queryRaw.mockResolvedValueOnce([{ supplierName: "Supplier" }] as never);
    f.tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: "batch", source_document_id: "supplier" }] as never)
      .mockResolvedValueOnce([
        { supplier_name: "Supplier", unit_address: "Address", contact_phone: null }
      ] as never);
    expect(
      await f.repository.facts(employee, { storeNames: [key.storeName], dates: [key.purchaseDate] })
    ).toEqual([]);
    expect(f.tx.document.findFirstOrThrow).toHaveBeenCalledWith({
      where: { orgId: "org", id: "supplier" }
    });
    expect(f.storage.headObject).not.toHaveBeenCalled();
  });
  it("rejects cross-org, another bundle actor, and operator requests even for admins", async () => {
    const f = fixture();
    const request = {
      orgId: "org",
      id: "r",
      kind: "download",
      actorKind: "employee",
      actorEmployeeId: "another",
      items: []
    };
    f.prisma.ledgerArtifactRequest.findFirst.mockImplementation(async (input: unknown) =>
      (input as { where: { orgId: string } }).where.orgId === "org" ? (request as never) : null
    );
    expect(await f.repository.request(employee, "r")).toBeNull();
    expect(await f.repository.request({ ...employee, role: "admin" }, "r")).toBeNull();
    expect(await f.repository.request({ ...employee, orgId: "other" }, "r")).toBeNull();
    f.prisma.ledgerArtifactRequest.findFirst.mockResolvedValue({
      ...request,
      kind: "refresh",
      actorKind: "operator"
    } as never);
    expect(await f.repository.request({ ...employee, role: "admin" }, "r")).toBeNull();
  });
  it("disabled accounts cannot pass current checks and object state stays authoritative", async () => {
    const f = fixture();
    f.prisma.employee.findFirst.mockResolvedValue(null as never);
    expect(await f.repository.currentEmployee(employee)).toBeNull();
    expect(
      await f.repository.facts(employee, { storeNames: [key.storeName], dates: [key.purchaseDate] })
    ).toEqual([]);
    f.prisma.employee.findFirst.mockResolvedValue(employee);
    vi.mocked(f.storage.headObject).mockResolvedValue({ state: "not_found" });
    expect(
      (
        await f.repository.facts(employee, {
          storeNames: [key.storeName],
          dates: [key.purchaseDate]
        })
      )[0]?.status
    ).toBe("missing");
  });
  it("rechecks current account permissions for all captured PDFs at acceptance", async () => {
    const f = fixture();
    const create = vi.fn();
    Object.assign(f.tx, { ledgerArtifactRequest: { findUnique: vi.fn(async () => null), create } });
    const entry = {
      key,
      partitionId: "p",
      generation: 1,
      dataRevision: 1,
      sourceFingerprint: hash,
      objectKey: "existing.pdf",
      checksumSha256: hash,
      byteSize: 10,
      sources: [ledger, photo]
    };
    await expect(
      f.repository.reserveBundle({
        employee: { ...employee, clearance: 3 },
        manifest: {
          version: 1,
          scope: { storeNames: [key.storeName], dates: [key.purchaseDate] },
          entries: [entry]
        },
        idempotencyKey: "current",
        fingerprint: "current"
      })
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
    expect(create).not.toHaveBeenCalled();
  });
  it("uses the account state in the current authorization snapshot for task management", async () => {
    const f = fixture();
    f.prisma.employee.findFirst
      .mockResolvedValueOnce(employee)
      .mockResolvedValueOnce({ ...employee, disabled: true });
    expect(await f.repository.currentEmployee(employee)).toBeNull();
  });
  it("reserves one bundle per opaque key and rejects collisions across actor or scope", async () => {
    const f = fixture();
    const existing = { id: "bundle", requestFingerprint: "fingerprint", status: "queued" };
    const requests = { findUnique: vi.fn(async () => existing), create: vi.fn() };
    const runs = { create: vi.fn() };
    Object.assign(f.tx, { ledgerArtifactRequest: requests, processingRun: runs });
    const manifest = {
      version: 1 as const,
      scope: { storeNames: [key.storeName], dates: [key.purchaseDate] },
      entries: []
    };
    expect(
      await f.repository.reserveBundle({
        employee,
        manifest,
        idempotencyKey: "Key",
        fingerprint: "fingerprint"
      })
    ).toEqual({ requestId: "bundle", status: "queued" });
    await expect(
      f.repository.reserveBundle({
        employee,
        manifest,
        idempotencyKey: "Key",
        fingerprint: "different-actor-or-scope"
      })
    ).rejects.toThrow("LEDGER_IDEMPOTENCY_CONFLICT");
    expect(requests.findUnique).toHaveBeenCalledWith({
      where: { orgId_idempotencyKey: { orgId: "org", idempotencyKey: "Key" } }
    });
    expect(requests.create).not.toHaveBeenCalled();
    expect(runs.create).not.toHaveBeenCalled();
  });
});
