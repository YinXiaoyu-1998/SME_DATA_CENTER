import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  processingRun: {
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn()
  },
  importBatch: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  },
  dishRow: { deleteMany: vi.fn(), createMany: vi.fn() },
  businessRow: { deleteMany: vi.fn(), createMany: vi.fn() },
  vipRow: { deleteMany: vi.fn(), createMany: vi.fn() },
  dishCatalogRow: { deleteMany: vi.fn(), createMany: vi.fn() },
  document: { update: vi.fn() },
  auditLog: { create: vi.fn() },
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
    prisma.vipRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.vipRow.createMany.mockResolvedValue({ count: 1 });
    prisma.document.update.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});
  });

  it("writes catalog rows through their own branch and stores safe imported/ignored summaries", async () => {
    const repository = createPrismaProcessingWorkerRepository("mysql://test");

    await repository.completeStructuredImport?.({
      runId: "run_1",
      documentId: "doc_1",
      importBatchId: "imp_1",
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
    expect(JSON.stringify(prisma.importBatch.update.mock.calls)).not.toContain("Ignored cell");
  });

  it("preserves the exact legacy sheet summary shape for an applied window dataset", async () => {
    prisma.importBatch.findFirst.mockResolvedValueOnce({
      id: "imp_1",
      orgId: "org_1",
      sourceDocumentId: "doc_1",
      dataset: "dishes"
    });
    prisma.dishRow.deleteMany.mockResolvedValueOnce({ count: 0 });
    prisma.dishRow.createMany.mockResolvedValueOnce({ count: 1 });
    const repository = createPrismaProcessingWorkerRepository("mysql://test");
    const sheetSummary = [
      { sheetIndex: 0, name: "Sheet1", hidden: false, headerRowNumber: 1, dataRowCount: 1 }
    ];

    await repository.completeStructuredImport?.({
      runId: "run_1",
      documentId: "doc_1",
      importBatchId: "imp_1",
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
      dataset: "business"
    });
    const repository = createPrismaProcessingWorkerRepository("mysql://test");
    const sheetSummary = [
      { sheetIndex: 0, name: "Sheet1", hidden: false, headerRowNumber: 1, dataRowCount: 1 }
    ];

    await repository.rejectStructuredImport?.({
      runId: "run_1",
      documentId: "doc_1",
      importBatchId: "imp_1",
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
