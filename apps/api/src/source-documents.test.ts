import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrismaSourceDocumentRepository } from "./source-documents.js";
import type { AuthenticatedEmployee } from "@smedc/domain";

const prisma = vi.hoisted(() => ({ document: { findMany: vi.fn() }, $disconnect: vi.fn() }));
vi.mock("@prisma/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@prisma/client")>()),
  PrismaClient: class {
    constructor() {
      return prisma;
    }
  }
}));
const employee = {
  id: "synthetic",
  orgId: "org_synthetic",
  clearance: 1,
  disabled: false
} as AuthenticatedEmployee;

describe("source document classification", () => {
  afterEach(() => vi.clearAllMocks());
  it("loads ledger ImportBatch classification regardless of application state with org/clearance checks", async () => {
    prisma.document.findMany.mockImplementation(async (query) => {
      expect(query.where).toMatchObject({
        orgId: "org_synthetic",
        archivedAt: null,
        confidentialityLevel: { lte: 1 }
      });
      expect(query.include).toEqual({ importBatch: { select: { dataset: true } } });
      return [
        {
          id: "ledger",
          orgId: "org_synthetic",
          status: "processing_failed",
          storageObjectKey: "synthetic/ledger",
          originalFileName: "ledger.xlsx",
          contentType: "application/octet-stream",
          byteSize: 10n,
          confidentialityLevel: 0,
          importBatch: { dataset: "delivery_ledger" }
        }
      ];
    });
    const repository = createPrismaSourceDocumentRepository(
      "mysql://synthetic:synthetic@localhost:3307/synthetic"
    );
    const records = await repository.findDownloadableSourceDocuments({
      orgId: "org_synthetic",
      employee,
      sourceDocumentIds: ["ledger"]
    });
    expect(records[0]).toMatchObject({
      sourceDocumentId: "ledger",
      importDataset: "delivery_ledger"
    });
    await repository.disconnect?.();
  });
});
