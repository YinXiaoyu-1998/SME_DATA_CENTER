import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  importBatch: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn()
  },
  importWindowClaim: {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn()
  },
  document: {
    create: vi.fn(),
    update: vi.fn()
  },
  dishRow: {
    deleteMany: vi.fn()
  },
  businessRow: {
    deleteMany: vi.fn()
  },
  vipRow: {
    deleteMany: vi.fn()
  },
  dishCatalogRow: {
    deleteMany: vi.fn()
  },
  processingRun: {
    create: vi.fn()
  },
  auditLog: {
    create: vi.fn()
  },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
  $disconnect: vi.fn()
}));

vi.mock("@prisma/adapter-mariadb", () => ({
  PrismaMariaDb: class PrismaMariaDb {}
}));

vi.mock("@prisma/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@prisma/client")>();

  return {
    ...original,
    PrismaClient: class PrismaClient {
      constructor() {
        return prisma;
      }
    }
  };
});

import { Prisma } from "@prisma/client";
import { createPrismaStructuredImportRepository } from "./structured-imports.js";

const audit = {
  requestId: "req_http_1",
  sourceIp: "198.51.100.8",
  clientSource: "http_api" as const,
  launcherVersion: null
};

function importBatchRecord(
  status = "pending",
  processingRuns: Array<{ id: string; status: string }> = [],
  dataset = "dishes"
) {
  return {
    id: "imp_1",
    orgId: "org_1",
    sourceDocumentId: "doc_1",
    dataset,
    status,
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-05T00:00:00.000Z"),
    sourceSheetSummary: [],
    validationErrors: [],
    totalRowCount: 1,
    appliedRowCount: status === "applied" ? 1 : 0,
    sourceDocument: {
      status: status === "applied" ? "active" : "pending_processing",
      fileType: "csv",
      storageObjectKey: "org/org_1/documents/doc_1/original/data.csv",
      originalFileName: "data.csv",
      documentLabels: [{ label: { key: "all_staff" } }],
      processingRuns
    }
  };
}

describe("Prisma structured import audit provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.importBatch.findUnique.mockResolvedValue(null);
    prisma.importWindowClaim.findUnique.mockResolvedValue(null);
    prisma.importWindowClaim.delete.mockResolvedValue({});
    prisma.importWindowClaim.deleteMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma)
    );
    prisma.document.create.mockResolvedValue({});
    prisma.importBatch.create.mockResolvedValue({});
    prisma.importWindowClaim.create.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});
    prisma.importBatch.findUniqueOrThrow.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve({ ...importBatchRecord(), id: where.id })
    );
    prisma.importBatch.findFirst.mockResolvedValue(importBatchRecord());
    prisma.importBatch.updateMany.mockResolvedValue({ count: 1 });
    prisma.importBatch.update.mockResolvedValue(importBatchRecord("applied"));
    prisma.document.update.mockResolvedValue({});
    prisma.dishRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.businessRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.vipRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.dishCatalogRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.processingRun.create.mockResolvedValue({});
    prisma.$executeRaw.mockResolvedValue(1);
  });

  it("persists the complete audit context when reserving a structured import", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });

    await repository.reserveStructuredImport({
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      documentId: "doc_1",
      dataset: "dishes",
      fileType: "csv",
      startDate: "20260701",
      endDate: "20260705",
      idempotencyKey: "idem_1",
      requestFingerprint: "fingerprint_1",
      document: {
        title: "Dishes",
        storageObjectKey: "org/org_1/documents/doc_1/original/data.csv",
        originalFileName: "data.csv",
        contentType: "text/csv",
        byteSize: 10,
        checksumSha256: "hash",
        labelIds: ["label_1"],
        labels: ["all_staff"]
      },
      sourceSheetSummary: [],
      totalRowCount: 1,
      audit
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: "req_http_1",
          clientIp: "198.51.100.8",
          clientSource: "http_api",
          launcherVersion: null
        })
      })
    );
  });

  it("persists the complete audit context when applying a structured import", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });

    await repository.applyReservedStructuredImport({
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      importBatchId: "imp_1",
      rows: [
        {
          sourceSheetIndex: 0,
          sourceSheetName: "Sheet1",
          sourceRowNumber: 2,
          payload: { product_name: "Tea" }
        }
      ],
      audit
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: "req_http_1",
          clientIp: "198.51.100.8",
          clientSource: "http_api",
          launcherVersion: null
        })
      })
    );
  });

  it("uses the dedicated catalog row branch when reapplying a reserved snapshot", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    prisma.importBatch.findFirst.mockResolvedValueOnce(
      importBatchRecord("pending", [], "dish_catalog")
    );
    prisma.importBatch.update.mockResolvedValueOnce(
      importBatchRecord("applied", [], "dish_catalog")
    );

    await repository.applyReservedStructuredImport({
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      importBatchId: "imp_1",
      rows: [
        {
          sourceSheetIndex: 2,
          sourceSheetName: "Catalog B",
          sourceRowNumber: 2,
          payload: { sku_id: "sku-1" }
        }
      ],
      audit
    });

    expect(prisma.dishCatalogRow.deleteMany).toHaveBeenCalledWith({
      where: { importBatchId: "imp_1" }
    });
    expect(prisma.vipRow.deleteMany).not.toHaveBeenCalled();
    expect(JSON.stringify(prisma.$executeRaw.mock.calls)).toContain("Catalog B");
  });

  it("creates a queued structured-import processing run only after a reservation exists", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });

    await repository.enqueueReservedStructuredImport({
      orgId: "org_1",
      importBatchId: "imp_1"
    });

    expect(prisma.processingRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        documentId: "doc_1",
        jobKey: "structured_import:imp_1",
        status: "queued",
        jobType: "structured_import"
      })
    });
  });

  it("returns the authoritative queued run when a concurrent replay wins the job-key race", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    prisma.importBatch.findFirst
      .mockResolvedValueOnce(importBatchRecord())
      .mockResolvedValueOnce(importBatchRecord("pending", [{ id: "run_1", status: "queued" }]));
    prisma.processingRun.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate structured-import job", {
        code: "P2002",
        clientVersion: "test"
      })
    );

    await expect(
      repository.enqueueReservedStructuredImport({ orgId: "org_1", importBatchId: "imp_1" })
    ).resolves.toMatchObject({ processingRunId: "run_1", processingStatus: "queued" });
  });

  it.each(["rejected", "failed"] as const)(
    "releases a %s import-window claim before accepting a replacement key",
    async (terminalStatus) => {
      const repository = createPrismaStructuredImportRepository({
        databaseUrl: "mysql://test",
        transactionTimeoutMs: 1_000,
        batchInsertSize: 100
      });
      prisma.importWindowClaim.findUnique.mockResolvedValueOnce({
        id: `claim_${terminalStatus}`,
        importBatch: importBatchRecord(terminalStatus)
      });

      await repository.reserveStructuredImport({
        orgId: "org_1",
        actorEmployeeId: "emp_2",
        documentId: "doc_2",
        dataset: "dishes",
        fileType: "csv",
        startDate: "20260701",
        endDate: "20260705",
        idempotencyKey: "replacement-key",
        requestFingerprint: "replacement-fingerprint",
        document: {
          title: "Replacement dishes",
          storageObjectKey: "org/org_1/documents/doc_2/original/data.csv",
          originalFileName: "data.csv",
          contentType: "text/csv",
          byteSize: 10,
          checksumSha256: "hash",
          labelIds: ["label_1"],
          labels: ["all_staff"]
        },
        sourceSheetSummary: [],
        totalRowCount: 0,
        audit
      });

      expect(prisma.importWindowClaim.delete).toHaveBeenCalledWith({
        where: { id: `claim_${terminalStatus}` }
      });
    }
  );

  it("releases an archived applied snapshot claim for a new key but replays the original key", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    const archivedBatch = {
      ...importBatchRecord(
        "applied",
        [{ id: "run_archived", status: "succeeded" }],
        "dish_catalog"
      ),
      id: "imp_archived",
      requestFingerprint: "archived-fingerprint",
      startDate: new Date("2026-08-19T00:00:00.000Z"),
      endDate: new Date("2026-08-19T00:00:00.000Z"),
      sourceDocument: {
        ...importBatchRecord("applied").sourceDocument,
        status: "archived",
        processingRuns: [{ id: "run_archived", status: "succeeded" }]
      }
    };
    const replacementBatch = {
      ...importBatchRecord("pending", [], "dish_catalog"),
      id: "imp_replacement",
      startDate: new Date("2026-08-19T00:00:00.000Z"),
      endDate: new Date("2026-08-19T00:00:00.000Z")
    };
    prisma.importBatch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(archivedBatch);
    prisma.importWindowClaim.findUnique.mockResolvedValueOnce({
      id: "claim_archived",
      importBatch: archivedBatch
    });
    prisma.importWindowClaim.deleteMany.mockResolvedValueOnce({ count: 1 });
    prisma.importBatch.findUniqueOrThrow.mockResolvedValueOnce(replacementBatch);

    const baseInput = {
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      dataset: "dish_catalog" as const,
      fileType: "csv" as const,
      startDate: "20260819",
      endDate: "20260819",
      document: {
        title: "Catalog snapshot",
        storageObjectKey: "org/org_1/documents/doc_replacement/original/catalog.csv",
        originalFileName: "catalog.csv",
        contentType: "text/csv",
        byteSize: 10,
        checksumSha256: "hash",
        labelIds: ["label_1"],
        labels: ["all_staff"]
      },
      sourceSheetSummary: [],
      totalRowCount: 0,
      audit
    };

    await expect(
      repository.reserveStructuredImport({
        ...baseInput,
        documentId: "doc_replacement",
        idempotencyKey: "replacement-key",
        requestFingerprint: "replacement-fingerprint"
      })
    ).resolves.toMatchObject({
      state: "created",
      importBatch: { id: "imp_replacement", dataset: "dish_catalog" }
    });
    expect(prisma.importWindowClaim.deleteMany).toHaveBeenCalledWith({
      where: { id: "claim_archived", importBatchId: "imp_archived" }
    });

    await expect(
      repository.reserveStructuredImport({
        ...baseInput,
        documentId: "doc_unused",
        idempotencyKey: "original-key",
        requestFingerprint: "archived-fingerprint"
      })
    ).resolves.toMatchObject({
      state: "existing",
      importBatch: { id: "imp_archived", status: "archived", sourceDocumentStatus: "archived" }
    });
    expect(prisma.importWindowClaim.findUnique).toHaveBeenCalledOnce();
  });
});
