import { describe, expect, it, vi } from "vitest";
import { createPrismaLedgerArtifactAccess } from "./access.js";
import type { PrismaClient } from "@prisma/client";

const employee = { id: "employee", orgId: "org", clearance: 0, disabled: false };
const source = {
  sourceDocumentId: "ledger",
  kind: "ledger" as const,
  confidentialityLevel: 0,
  checksumSha256: "checksum"
};
const document = {
  id: "ledger",
  status: "active",
  archivedAt: null,
  confidentialityLevel: 0,
  checksumSha256: "checksum",
  documentKind: "structured",
  importBatch: { orgId: "org", status: "applied", archivedAt: null, dataset: "delivery_ledger" }
};
function fixture(changes = {}) {
  const prisma = {
    employee: { findFirst: vi.fn().mockResolvedValue(employee) },
    document: { findMany: vi.fn().mockResolvedValue([{ ...document, ...changes }]) }
  };
  return {
    prisma,
    access: createPrismaLedgerArtifactAccess({ prisma: prisma as unknown as PrismaClient })
  };
}
describe("current ledger source authorization", () => {
  it("requires all current dependencies and does not grant content access to a low-clearance admin", async () => {
    const { access, prisma } = fixture();
    expect(await access.canReadLedgerArtifact({ orgId: "org", employee, sources: [source] })).toBe(
      true
    );
    expect(
      await access.canReadLedgerArtifact({
        orgId: "org",
        employee,
        sources: [source, { ...source, sourceDocumentId: "hidden", confidentialityLevel: 2 }]
      })
    ).toBe(false);
    prisma.document.findMany.mockResolvedValueOnce([]);
    expect(await access.canReadLedgerArtifact({ orgId: "org", employee, sources: [source] })).toBe(
      false
    );
    expect(
      await access.canReadLedgerArtifact({ orgId: "other", employee, sources: [source] })
    ).toBe(false);
    expect(await access.canReadLedgerArtifact({ orgId: "org", employee, sources: [] })).toBe(false);
  });
  it.each([
    { status: "archived" },
    { archivedAt: new Date() },
    { confidentialityLevel: 1 },
    { checksumSha256: "changed" },
    { importBatch: { ...document.importBatch, status: "failed" } },
    { importBatch: { ...document.importBatch, archivedAt: new Date() } }
  ])("rejects revoked or changed source %j", async (changes) => {
    expect(
      await fixture(changes).access.canReadLedgerArtifact({
        orgId: "org",
        employee,
        sources: [source]
      })
    ).toBe(false);
  });
  it("rechecks account disabling and decreased clearance", async () => {
    const { access, prisma } = fixture();
    prisma.employee.findFirst.mockResolvedValueOnce({ ...employee, disabled: true });
    expect(await access.canReadLedgerArtifact({ orgId: "org", employee, sources: [source] })).toBe(
      false
    );
    prisma.employee.findFirst.mockResolvedValueOnce({ ...employee, clearance: 0 });
    expect(
      await access.canReadLedgerArtifact({
        orgId: "org",
        employee: { ...employee, clearance: 3 },
        sources: [{ ...source, confidentialityLevel: 1 }]
      })
    ).toBe(false);
  });
  it("checks publication sources in the supplied transaction without an employee identity", async () => {
    const { access, prisma } = fixture();
    const tx = { document: { findMany: vi.fn().mockResolvedValue([document]) } };
    expect(
      await access.sourcesAreCurrent({
        orgId: "org",
        sources: [source],
        tx: tx as unknown as import("@prisma/client").Prisma.TransactionClient
      })
    ).toBe(true);
    expect(prisma.employee.findFirst).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    tx.document.findMany.mockResolvedValueOnce([{ ...document, confidentialityLevel: 1 }]);
    expect(
      await access.sourcesAreCurrent({
        orgId: "org",
        sources: [source],
        tx: tx as unknown as import("@prisma/client").Prisma.TransactionClient
      })
    ).toBe(false);
    tx.document.findMany.mockResolvedValueOnce([
      {
        ...document,
        documentKind: "structured",
        importBatch: {
          ...document.importBatch,
          dataset: "supplier_catalog",
          archivedAt: new Date()
        }
      }
    ]);
    expect(
      await access.sourcesAreCurrent({
        orgId: "org",
        sources: [{ ...source, kind: "supplier" }],
        tx: tx as unknown as import("@prisma/client").Prisma.TransactionClient
      })
    ).toBe(false);
  });

  it("requires current certificate and supplier provenance too", async () => {
    const { access, prisma } = fixture();
    prisma.document.findMany.mockResolvedValueOnce([
      {
        ...document,
        id: "photo",
        documentKind: "quarantine_certificate",
        quarantineCertificate: { orgId: "org" }
      }
    ]);
    expect(
      await access.canReadLedgerArtifact({
        orgId: "org",
        employee,
        sources: [{ ...source, sourceDocumentId: "photo", kind: "certificate" }]
      })
    ).toBe(true);
    prisma.document.findMany.mockResolvedValueOnce([
      {
        ...document,
        id: "supplier",
        importBatch: { ...document.importBatch, dataset: "supplier_catalog" }
      }
    ]);
    expect(
      await access.canReadLedgerArtifact({
        orgId: "org",
        employee,
        sources: [{ ...source, sourceDocumentId: "supplier", kind: "supplier" }]
      })
    ).toBe(true);
  });
});
