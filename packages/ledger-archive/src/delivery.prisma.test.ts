import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@smedc/storage";
import { createPrismaLedgerDeliveryRepository, type LedgerDeliveryEmployee } from "./delivery.js";
import { readLedgerSourceMetadata } from "./source-reader.js";
vi.mock("./source-reader.js", () => ({ readLedgerSourceMetadata: vi.fn() }));
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
    importBatch: { orgId: "org", status: "applied", archivedAt: null, dataset: "delivery_ledger" },
    quarantineCertificate: { orgId: "org" }
  };
}
function fixture() {
  const query = vi.fn(async () => [key]);
  const tx = {
    $queryRaw: vi.fn(async () => [{ total: 1n, hidden: 0n }]),
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
    ledgerArtifactRequest: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null)
    }
  };
  tx.document.findMany = prisma.document.findMany;
  tx.employee.findFirst = prisma.employee.findFirst;
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
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
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
  it("pending authorization includes a supplier only when the current catalog actually supplies a unique value", async () => {
    const f = fixture();
    vi.mocked(readLedgerSourceMetadata).mockResolvedValue({
      sourceFingerprint: "b".repeat(64),
      rowCount: 1,
      sources: [ledger]
    });
    f.tx.$queryRaw
      .mockResolvedValueOnce([{ total: 1n, hidden: 0n }])
      .mockResolvedValueOnce([{ supplierName: "Supplier" }] as never);
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
