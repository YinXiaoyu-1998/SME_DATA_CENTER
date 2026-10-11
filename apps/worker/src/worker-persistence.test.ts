import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  processingRun: {
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn()
  },
  importBatch: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  },
  vipRow: { deleteMany: vi.fn(), createMany: vi.fn() },
  dishCatalogRow: { deleteMany: vi.fn(), createMany: vi.fn() },
  deliveryLedgerRow: { deleteMany: vi.fn(), createMany: vi.fn() },
  supplierCatalogRow: { deleteMany: vi.fn(), createMany: vi.fn() },
  businessAuthorizationState: { upsert: vi.fn() },
  businessCategory: { findUnique: vi.fn() },
  document: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
  ledgerPdfPartition: { upsert: vi.fn() },
  $queryRaw: vi.fn(),
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

import { createPrismaProcessingWorkerRepository } from "./worker.js";

describe("Prisma structured worker persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.businessAuthorizationState.upsert.mockResolvedValue({ mode: "legacy", version: 1n });
    prisma.businessCategory.findUnique.mockResolvedValue({
      id: "fixed:catalog",
      kind: "fixed",
      confidentialityLevel: null,
      dimensions: []
    });
    prisma.document.findFirstOrThrow.mockResolvedValue({ sourceMetadata: null });
    prisma.$queryRaw.mockResolvedValue([{ id: "org_1" }]);
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma)
    );
    prisma.processingRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.processingRun.findUniqueOrThrow.mockResolvedValue({ orgId: "org_1" });
    prisma.importBatch.findFirst.mockResolvedValue({
      id: "imp_1",
      orgId: "org_1",
      sourceDocumentId: "doc_1",
      dataset: "dish_catalog"
    });
    prisma.importBatch.update.mockResolvedValue({});
    prisma.importBatch.updateMany.mockResolvedValue({ count: 1 });
    prisma.dishCatalogRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.dishCatalogRow.createMany.mockResolvedValue({ count: 1 });
    prisma.deliveryLedgerRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.deliveryLedgerRow.createMany.mockResolvedValue({ count: 1 });
    prisma.supplierCatalogRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.supplierCatalogRow.createMany.mockResolvedValue({ count: 1 });
    prisma.vipRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.vipRow.createMany.mockResolvedValue({ count: 1 });
    prisma.document.update.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});
    prisma.ledgerPdfPartition.upsert.mockImplementation(async (input) => input.create);
  });

  it("claims only matching active evidence reindex jobs without hiding the active document", async () => {
    const activeDocument = {
      id: "doc_evidence",
      orgId: "org_1",
      uploaderId: "emp_1",
      status: "active",
      storageObjectKey: "org/org_1/documents/doc_evidence/original/sop.docx",
      originalFileName: "sop.docx",
      documentKind: "evidence",
      fileType: "docx",
      contentVersion: 1,
      confidentialityLevel: 0
    };
    const run = {
      id: "run_reindex",
      orgId: "org_1",
      documentId: "doc_evidence",
      partitionImportJobId: null,
      jobKey: "evidence_document_index:doc_evidence:1:phase3.retrieval.v2-bm25",
      status: "queued",
      jobType: "evidence_document_index",
      attemptNumber: 0,
      retryCount: 0,
      availableAt: new Date("2026-09-21T00:00:00.000Z"),
      lockedBy: null,
      lockedUntil: null,
      partitionImportJob: null,
      document: activeDocument
    };
    prisma.processingRun.findFirst.mockResolvedValueOnce(run);
    prisma.processingRun.findUniqueOrThrow.mockResolvedValueOnce({
      ...run,
      status: "running",
      lockedBy: "worker-v2",
      lockedUntil: new Date("2026-09-21T00:01:00.000Z")
    });
    const repository = createPrismaProcessingWorkerRepository("mysql://test", {
      evidenceRetrievalConfigVersion: "phase3.retrieval.v2-bm25"
    });

    const claimed = await repository.claimNextProcessingRun({
      workerId: "worker-v2",
      now: new Date("2026-09-21T00:00:00.000Z"),
      leaseSeconds: 60
    });

    expect(prisma.processingRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  jobType: "evidence_document_index",
                  jobKey: { endsWith: ":phase3.retrieval.v2-bm25" },
                  document: expect.objectContaining({ status: "active" })
                })
              ])
            })
          ])
        })
      })
    );
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(claimed).toMatchObject({
      id: "run_reindex",
      isEvidenceReindex: true,
      document: { id: "doc_evidence", status: "active" }
    });
  });

  it("writes catalog rows through their own branch and stores safe imported/ignored summaries", async () => {
    const repository = createPrismaProcessingWorkerRepository("mysql://test", {
      structuredImportTransactionTimeoutMs: 42_000
    });

    await repository.completeStructuredImport?.({
      runId: "run_1",
      attemptNumber: 1,
      documentId: "doc_1",
      importBatchId: "imp_1",
      dataset: "dish_catalog",
      workerId: "worker_1",
      now: new Date("2026-08-19T00:00:00.000Z"),
      batchInsertSize: 500,
      result: {
        sheetSummary: [
          {
            sheetIndex: 0,
            name: "Catalog",
            hidden: false,
            headerRowNumber: 1,
            dataRowCount: 1
          }
        ],
        ignoredSheets: [{ sheetIndex: 1, name: "总部套餐", reason: "SCHEMA_NOT_MATCHED" }],
        rows: [
          {
            sourceSheetIndex: 0,
            sourceSheetName: "Catalog",
            sourceRowNumber: 2,
            payload: { snapshot_date: "2026-08-19", sku_id: "sku-1" }
          }
        ],
        validationErrors: [],
        validationErrorCount: 0,
        validationErrorsTruncated: false
      }
    });

    expect(prisma.dishCatalogRow.deleteMany).toHaveBeenCalledWith({
      where: { importBatchId: "imp_1" }
    });
    expect(prisma.dishCatalogRow.createMany).toHaveBeenCalledOnce();
    expect(prisma.vipRow.deleteMany).not.toHaveBeenCalled();
    expect(prisma.vipRow.createMany).not.toHaveBeenCalled();
    expect(prisma.importBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceSheetSummary: [
            {
              sheetIndex: 0,
              name: "Catalog",
              hidden: false,
              headerRowNumber: 1,
              dataRowCount: 1,
              status: "imported"
            },
            {
              sheetIndex: 1,
              name: "总部套餐",
              reason: "SCHEMA_NOT_MATCHED",
              status: "ignored"
            }
          ]
        })
      })
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 42_000 });
    expect(JSON.stringify(prisma.importBatch.update.mock.calls)).not.toContain("Ignored cell");
  });

  it("publishes delivery ledger rows with lineage and the completion timestamp", async () => {
    prisma.importBatch.findFirst.mockResolvedValueOnce({
      id: "imp_delivery",
      orgId: "org_1",
      sourceDocumentId: "doc_delivery",
      dataset: "delivery_ledger"
    });
    const now = new Date("2026-08-29T01:02:03.000Z");
    const repository = createPrismaProcessingWorkerRepository("mysql://test");

    await repository.completeStructuredImport?.({
      runId: "run_delivery",
      attemptNumber: 1,
      documentId: "doc_delivery",
      importBatchId: "imp_delivery",
      dataset: "delivery_ledger",
      workerId: "worker_delivery",
      now,
      batchInsertSize: 500,
      result: {
        sheetSummary: [
          { sheetIndex: 0, name: "Receipt", hidden: false, headerRowNumber: 4, dataRowCount: 1 }
        ],
        ignoredSheets: [],
        rows: [
          {
            sourceSheetIndex: 0,
            sourceSheetName: "Receipt",
            sourceRowNumber: 8,
            payload: {
              receipt_id: "SH-1",
              item_name: "Rice",
              store_name: "Synthetic",
              purchase_date: "2026-08-19"
            }
          }
        ],
        validationErrors: [],
        validationErrorCount: 0,
        validationErrorsTruncated: false
      }
    });

    expect(prisma.ledgerPdfPartition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          orgId: "org_1",
          storeName: "Synthetic",
          dataRevision: 1
        }),
        update: { dataRevision: { increment: 1 } }
      })
    );
    expect(prisma.deliveryLedgerRow.deleteMany).toHaveBeenCalledWith({
      where: { importBatchId: "imp_delivery" }
    });
    expect(prisma.deliveryLedgerRow.createMany).toHaveBeenCalledWith({
      data: [
        {
          orgId: "org_1",
          sourceDocumentId: "doc_delivery",
          importBatchId: "imp_delivery",
          sourceSheetIndex: 0,
          sourceSheetName: "Receipt",
          sourceRowNumber: 8,
          payload: {
            receipt_id: "SH-1",
            item_name: "Rice",
            store_name: "Synthetic",
            purchase_date: "2026-08-19"
          }
        }
      ]
    });
    expect(prisma.supplierCatalogRow.deleteMany).not.toHaveBeenCalled();
    expect(prisma.supplierCatalogRow.createMany).not.toHaveBeenCalled();
    expect(prisma.importBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "imp_delivery" },
        data: expect.objectContaining({ status: "applied", appliedAt: now })
      })
    );
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("publishes supplier catalog rows with lineage and the completion timestamp", async () => {
    prisma.importBatch.findFirst.mockResolvedValueOnce({
      id: "imp_supplier",
      orgId: "org_1",
      sourceDocumentId: "doc_supplier",
      dataset: "supplier_catalog"
    });
    const now = new Date("2026-08-29T04:05:06.000Z");
    const repository = createPrismaProcessingWorkerRepository("mysql://test");

    await repository.completeStructuredImport?.({
      runId: "run_supplier",
      attemptNumber: 1,
      documentId: "doc_supplier",
      importBatchId: "imp_supplier",
      dataset: "supplier_catalog",
      workerId: "worker_supplier",
      now,
      batchInsertSize: 500,
      result: {
        sheetSummary: [
          { sheetIndex: 0, name: "Suppliers", hidden: false, headerRowNumber: 2, dataRowCount: 1 }
        ],
        ignoredSheets: [],
        rows: [
          {
            sourceSheetIndex: 0,
            sourceSheetName: "Suppliers",
            sourceRowNumber: 3,
            payload: { supplier_name: "Supplier A", contact_phone: "13800000000" }
          }
        ],
        validationErrors: [],
        validationErrorCount: 0,
        validationErrorsTruncated: false
      }
    });

    expect(prisma.supplierCatalogRow.deleteMany).toHaveBeenCalledWith({
      where: { importBatchId: "imp_supplier" }
    });
    expect(prisma.supplierCatalogRow.createMany).toHaveBeenCalledWith({
      data: [
        {
          orgId: "org_1",
          sourceDocumentId: "doc_supplier",
          importBatchId: "imp_supplier",
          sourceSheetIndex: 0,
          sourceSheetName: "Suppliers",
          sourceRowNumber: 3,
          payload: { supplier_name: "Supplier A", contact_phone: "13800000000" }
        }
      ]
    });
    expect(prisma.deliveryLedgerRow.deleteMany).not.toHaveBeenCalled();
    expect(prisma.deliveryLedgerRow.createMany).not.toHaveBeenCalled();
    expect(prisma.importBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "imp_supplier" },
        data: expect.objectContaining({ status: "applied", appliedAt: now })
      })
    );
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("preserves the exact legacy sheet summary shape for an applied window dataset", async () => {
    prisma.importBatch.findFirst.mockResolvedValueOnce({
      id: "imp_1",
      orgId: "org_1",
      sourceDocumentId: "doc_1",
      dataset: "vip"
    });
    prisma.vipRow.deleteMany.mockResolvedValueOnce({ count: 0 });
    prisma.vipRow.createMany.mockResolvedValueOnce({ count: 1 });
    const repository = createPrismaProcessingWorkerRepository("mysql://test");
    const sheetSummary = [
      { sheetIndex: 0, name: "Sheet1", hidden: false, headerRowNumber: 1, dataRowCount: 1 }
    ];

    await repository.completeStructuredImport?.({
      runId: "run_1",
      attemptNumber: 1,
      documentId: "doc_1",
      importBatchId: "imp_1",
      dataset: "vip",
      workerId: "worker_1",
      now: new Date("2026-08-19T00:00:00.000Z"),
      batchInsertSize: 500,
      result: {
        sheetSummary,
        ignoredSheets: [{ sheetIndex: 1, name: "Ignored", reason: "SCHEMA_NOT_MATCHED" }],
        rows: [
          {
            sourceSheetIndex: 0,
            sourceSheetName: "Sheet1",
            sourceRowNumber: 2,
            payload: { product_name: "Tea" }
          }
        ],
        validationErrors: [],
        validationErrorCount: 0,
        validationErrorsTruncated: false
      }
    });

    expect(prisma.importBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceSheetSummary: sheetSummary })
      })
    );
  });

  it("preserves the exact legacy sheet summary shape for a rejected window dataset", async () => {
    prisma.importBatch.findFirst.mockResolvedValueOnce({
      id: "imp_1",
      orgId: "org_1",
      sourceDocumentId: "doc_1",
      dataset: "vip"
    });
    const repository = createPrismaProcessingWorkerRepository("mysql://test");
    const sheetSummary = [
      { sheetIndex: 0, name: "Sheet1", hidden: false, headerRowNumber: 1, dataRowCount: 1 }
    ];

    await repository.rejectStructuredImport?.({
      runId: "run_1",
      attemptNumber: 1,
      documentId: "doc_1",
      importBatchId: "imp_1",
      dataset: "vip",
      workerId: "worker_1",
      now: new Date("2026-08-19T00:00:00.000Z"),
      result: {
        sheetSummary,
        ignoredSheets: [{ sheetIndex: 1, name: "Ignored", reason: "SCHEMA_NOT_MATCHED" }],
        rows: [],
        validationErrors: [
          {
            code: "INVALID_NUMBER",
            message: "invalid",
            sheetName: "Sheet1",
            sheetIndex: 0,
            rowNumber: 2,
            column: "gross_sales"
          }
        ],
        validationErrorCount: 1,
        validationErrorsTruncated: false
      }
    });

    expect(prisma.importBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceSheetSummary: sheetSummary })
      })
    );
  });
});

it("fences failure by attempt and stops before document/domain mutation when stale", async () => {
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma)
  );
  prisma.processingRun.findUniqueOrThrow.mockResolvedValue({
    orgId: "synthetic",
    jobType: "evidence_document_index"
  });
  prisma.processingRun.updateMany.mockResolvedValueOnce({ count: 0 });
  prisma.document.update.mockClear();
  const repository = createPrismaProcessingWorkerRepository("mysql://test");
  await expect(
    repository.failProcessingRun({
      runId: "stale",
      documentId: "doc",
      workerId: "same-worker",
      attemptNumber: 1,
      now: new Date(),
      errorCode: "STALE",
      errorSummary: "synthetic",
      willRetry: false,
      nextAvailableAt: new Date()
    })
  ).rejects.toThrow("no longer leased");
  expect(prisma.processingRun.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        attemptNumber: 1,
        lockedBy: "same-worker",
        status: "running"
      })
    })
  );
  expect(prisma.document.update).not.toHaveBeenCalled();
});
