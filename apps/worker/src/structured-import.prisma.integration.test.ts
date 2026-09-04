import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  DocumentKind,
  DocumentStatus,
  DocumentType,
  FileType,
  ImportBatchStatus,
  ImportDataset,
  PrismaClient,
  ProcessingJobType,
  ProcessingRunStatus
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getStructuredRegistry, type StructuredDatasetName } from "@enterprise-hub/domain";
import type { StructuredParseResult } from "@enterprise-hub/structured-ingestion";
import { createPrismaProcessingWorkerRepository, ProcessingLeaseLostError } from "./worker.js";

const runIntegration = process.env["RUN_WORKER_PRISMA_INTEGRATION"] === "1";
const describeIntegration = runIntegration ? describe : describe.skip;
const databaseUrl = process.env["DATABASE_URL"] ?? "";
const orgId = "worker-prisma-test-org";
const employeeId = "worker_prisma_test_employee";

describeIntegration("Prisma structured import worker repository", () => {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Worker Prisma Test" } });
    await prisma.employee.create({
      data: {
        id: employeeId,
        orgId,
        email: "worker-prisma-test@example.invalid",
        displayName: "Worker Prisma Test",
        role: "employee"
      }
    });
  });

  beforeEach(async () => {
    await clearTestRecords(prisma);
  });

  afterAll(async () => {
    await clearTestRecords(prisma);
    await prisma.employee.deleteMany({ where: { id: employeeId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("rolls back old-row deletion when Prisma row insertion fails", async () => {
    const repository = createPrismaProcessingWorkerRepository(databaseUrl);
    const fixture = await createStructuredRun(prisma, "rollback");
    const now = new Date("2026-08-10T00:00:00.000Z");
    const claimed = await repository.claimNextProcessingRun({
      workerId: "worker-rollback",
      leaseSeconds: 120,
      now
    });
    expect(claimed?.id).toBe(fixture.runId);
    await repository.beginStructuredImportApply?.({
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-rollback",
      now
    });
    await prisma.dishRow.create({
      data: {
        orgId,
        sourceDocumentId: fixture.documentId,
        importBatchId: fixture.importBatchId,
        sourceSheetIndex: 0,
        sourceSheetName: "Sheet1",
        sourceRowNumber: 99,
        payload: { business_date: "2026-08-10" }
      }
    });

    await expect(
      repository.completeStructuredImport?.({
        runId: fixture.runId,
        documentId: fixture.documentId,
        importBatchId: fixture.importBatchId,
        workerId: "worker-rollback",
        now,
        batchInsertSize: 500,
        result: structuredResult({ sourceSheetName: "x".repeat(256) })
      })
    ).rejects.toThrow();

    expect(
      await prisma.dishRow.findMany({ where: { importBatchId: fixture.importBatchId } })
    ).toEqual([expect.objectContaining({ sourceRowNumber: 99 })]);
    await expectRepositoryState(prisma, fixture, {
      batch: ImportBatchStatus.applying,
      document: DocumentStatus.processing,
      run: ProcessingRunStatus.running,
      lockedBy: "worker-rollback"
    });
    await repository.disconnect?.();
  });

  it("returns an async apply transaction failure to pending without partial rows", async () => {
    const repository = createPrismaProcessingWorkerRepository(databaseUrl);
    const fixture = await createStructuredRun(prisma, "retryrb");
    const now = new Date("2026-08-10T00:30:00.000Z");
    const claimed = await repository.claimNextProcessingRun({
      workerId: "worker-retry-after-rollback",
      leaseSeconds: 120,
      now
    });
    expect(claimed?.id).toBe(fixture.runId);
    await repository.beginStructuredImportApply?.({
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-retry-after-rollback",
      now
    });

    await expect(
      repository.completeStructuredImport?.({
        runId: fixture.runId,
        documentId: fixture.documentId,
        importBatchId: fixture.importBatchId,
        workerId: "worker-retry-after-rollback",
        now,
        batchInsertSize: 500,
        result: structuredResult({ sourceSheetName: "x".repeat(256) })
      })
    ).rejects.toThrow();

    await repository.failProcessingRun({
      runId: fixture.runId,
      documentId: fixture.documentId,
      workerId: "worker-retry-after-rollback",
      now,
      errorCode: "STRUCTURED_IMPORT_FAILED",
      errorSummary: "simulated apply transaction failure",
      willRetry: true,
      nextAvailableAt: now
    });

    expect(await prisma.dishRow.count({ where: { importBatchId: fixture.importBatchId } })).toBe(0);
    await expectRepositoryState(prisma, fixture, {
      batch: ImportBatchStatus.pending,
      document: DocumentStatus.pending_processing,
      run: ProcessingRunStatus.retry_scheduled,
      lockedBy: null
    });
    await repository.disconnect?.();
  });

  it("allows only one Prisma worker to claim a contended structured import", async () => {
    const repositoryA = createPrismaProcessingWorkerRepository(databaseUrl);
    const repositoryB = createPrismaProcessingWorkerRepository(databaseUrl);
    const fixture = await createStructuredRun(prisma, "contention");
    const now = new Date("2026-08-10T01:00:00.000Z");

    const claims = await Promise.all([
      repositoryA.claimNextProcessingRun({ workerId: "worker-a", leaseSeconds: 120, now }),
      repositoryB.claimNextProcessingRun({ workerId: "worker-b", leaseSeconds: 120, now })
    ]);

    expect(claims.filter((claim) => claim?.id === fixture.runId)).toHaveLength(1);
    const run = await prisma.processingRun.findUniqueOrThrow({ where: { id: fixture.runId } });
    expect(run.attemptNumber).toBe(1);
    expect(run.lockedBy).toMatch(/^worker-[ab]$/);
    await Promise.all([repositoryA.disconnect?.(), repositoryB.disconnect?.()]);
  });

  it("applies a catalog snapshot to dish_catalog_rows with safe ignored-sheet status", async () => {
    const repository = createPrismaProcessingWorkerRepository(databaseUrl);
    const fixture = await createStructuredRun(prisma, "catalog", ImportDataset.dish_catalog);
    const now = new Date("2026-08-19T00:00:00.000Z");
    await repository.claimNextProcessingRun({
      workerId: "worker-catalog",
      leaseSeconds: 120,
      now
    });
    await repository.beginStructuredImportApply?.({
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-catalog",
      now
    });
    const result = structuredResult();
    result.rows[0]!.payload = { snapshot_date: "2026-08-19", sku_id: "sku-1" };
    result.ignoredSheets = [{ sheetIndex: 1, name: "总部套餐", reason: "SCHEMA_NOT_MATCHED" }];
    await repository.completeStructuredImport?.({
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-catalog",
      now,
      batchInsertSize: 500,
      result
    });

    expect(
      await prisma.dishCatalogRow.findMany({ where: { importBatchId: fixture.importBatchId } })
    ).toEqual([
      expect.objectContaining({
        sourceSheetIndex: 0,
        sourceSheetName: "Sheet1",
        sourceRowNumber: 2,
        payload: { snapshot_date: "2026-08-19", sku_id: "sku-1" }
      })
    ]);
    expect(await prisma.vipRow.count({ where: { importBatchId: fixture.importBatchId } })).toBe(0);
    expect(
      (await prisma.importBatch.findUniqueOrThrow({ where: { id: fixture.importBatchId } }))
        .sourceSheetSummary
    ).toEqual([
      expect.objectContaining({ name: "Sheet1", status: "imported" }),
      { sheetIndex: 1, name: "总部套餐", reason: "SCHEMA_NOT_MATCHED", status: "ignored" }
    ]);
    expect(
      (await prisma.importBatch.findUniqueOrThrow({ where: { id: fixture.importBatchId } }))
        .appliedAt
    ).toEqual(now);
    await repository.disconnect?.();
  });

  it("publishes delivery ledger rows and appliedAt in one transaction", async () => {
    const repository = createPrismaProcessingWorkerRepository(databaseUrl);
    const fixture = await createStructuredRun(prisma, "dlgr", ImportDataset.delivery_ledger);
    const now = new Date("2026-08-29T03:00:00.000Z");
    await repository.claimNextProcessingRun({
      workerId: "worker-delivery",
      leaseSeconds: 120,
      now
    });
    await repository.beginStructuredImportApply?.({
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-delivery",
      now
    });
    await repository.completeStructuredImport?.({
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-delivery",
      now,
      batchInsertSize: 500,
      result: structuredResult()
    });

    expect(
      await prisma.deliveryLedgerRow.count({ where: { importBatchId: fixture.importBatchId } })
    ).toBe(1);
    expect(
      await prisma.supplierCatalogRow.count({ where: { importBatchId: fixture.importBatchId } })
    ).toBe(0);
    expect(
      (await prisma.importBatch.findUniqueOrThrow({ where: { id: fixture.importBatchId } }))
        .appliedAt
    ).toEqual(now);
    await repository.disconnect?.();
  });

  it("publishes supplier catalog rows and appliedAt in one transaction", async () => {
    const repository = createPrismaProcessingWorkerRepository(databaseUrl);
    const fixture = await createStructuredRun(prisma, "supcat", ImportDataset.supplier_catalog);
    const now = new Date("2026-08-29T04:00:00.000Z");
    await repository.claimNextProcessingRun({
      workerId: "worker-supplier",
      leaseSeconds: 120,
      now
    });
    await repository.beginStructuredImportApply?.({
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-supplier",
      now
    });
    await repository.completeStructuredImport?.({
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-supplier",
      now,
      batchInsertSize: 500,
      result: structuredResult()
    });

    expect(
      await prisma.supplierCatalogRow.count({ where: { importBatchId: fixture.importBatchId } })
    ).toBe(1);
    expect(
      await prisma.deliveryLedgerRow.count({ where: { importBatchId: fixture.importBatchId } })
    ).toBe(0);
    expect(
      (await prisma.importBatch.findUniqueOrThrow({ where: { id: fixture.importBatchId } }))
        .appliedAt
    ).toEqual(now);
    await repository.disconnect?.();
  });

  it("rejects stale Prisma success, reject, and fail transitions while allowing the new lease owner", async () => {
    const repositoryA = createPrismaProcessingWorkerRepository(databaseUrl);
    const repositoryB = createPrismaProcessingWorkerRepository(databaseUrl);
    const fixture = await createStructuredRun(prisma, "lease-loss");
    const firstNow = new Date("2026-08-10T02:00:00.000Z");
    const recoveredNow = new Date("2026-08-10T02:00:02.000Z");
    await repositoryA.claimNextProcessingRun({
      workerId: "worker-a",
      leaseSeconds: 1,
      now: firstNow
    });
    await repositoryB.claimNextProcessingRun({
      workerId: "worker-b",
      leaseSeconds: 120,
      now: recoveredNow
    });

    const transition = {
      runId: fixture.runId,
      documentId: fixture.documentId,
      importBatchId: fixture.importBatchId,
      workerId: "worker-a",
      now: recoveredNow
    };
    await expect(
      repositoryA.completeStructuredImport?.({
        ...transition,
        batchInsertSize: 500,
        result: structuredResult()
      })
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);
    await expect(
      repositoryA.rejectStructuredImport?.({ ...transition, result: rejectedStructuredResult() })
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);
    await expect(
      repositoryA.failProcessingRun({
        runId: fixture.runId,
        documentId: fixture.documentId,
        workerId: "worker-a",
        now: recoveredNow,
        errorCode: "STALE",
        errorSummary: "stale worker",
        willRetry: false,
        nextAvailableAt: recoveredNow
      })
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);
    expect(await prisma.dishRow.count({ where: { importBatchId: fixture.importBatchId } })).toBe(0);
    await expectRepositoryState(prisma, fixture, {
      batch: ImportBatchStatus.validating,
      document: DocumentStatus.processing,
      run: ProcessingRunStatus.running,
      lockedBy: "worker-b"
    });

    await repositoryB.beginStructuredImportApply?.({
      ...transition,
      workerId: "worker-b"
    });
    await repositoryB.completeStructuredImport?.({
      ...transition,
      workerId: "worker-b",
      batchInsertSize: 500,
      result: structuredResult()
    });
    expect(await prisma.dishRow.count({ where: { importBatchId: fixture.importBatchId } })).toBe(1);
    await expectRepositoryState(prisma, fixture, {
      batch: ImportBatchStatus.applied,
      document: DocumentStatus.active,
      run: ProcessingRunStatus.succeeded,
      lockedBy: null
    });
    await Promise.all([repositoryA.disconnect?.(), repositoryB.disconnect?.()]);
  });
});

async function createStructuredRun(
  prisma: PrismaClient,
  suffix: string,
  dataset: ImportDataset = ImportDataset.dishes
) {
  const documentId = `worker_prisma_doc_${suffix}`;
  const importBatchId = `worker_prisma_batch_${suffix}`;
  const runId = `worker_prisma_run_${suffix}`;
  await prisma.document.create({
    data: {
      id: documentId,
      orgId,
      title: `Worker Prisma ${suffix}`,
      documentType: DocumentType.structured_dataset,
      documentKind: DocumentKind.structured,
      fileType: FileType.csv,
      status: DocumentStatus.pending_processing,
      storageObjectKey: `worker-prisma/${suffix}.csv`,
      originalFileName: `${suffix}.csv`,
      contentType: "text/csv",
      byteSize: 1n,
      checksumSha256: "0".repeat(64),
      uploaderId: employeeId,
      sourceSystem: "worker_prisma_test"
    }
  });
  await prisma.importBatch.create({
    data: {
      id: importBatchId,
      orgId,
      sourceDocumentId: documentId,
      dataset,
      registryVersion: getStructuredRegistry(dataset as StructuredDatasetName).version,
      startDate: new Date("2026-08-10T00:00:00.000Z"),
      endDate: new Date("2026-08-10T00:00:00.000Z"),
      idempotencyKey: `worker-prisma-${suffix}`,
      requestFingerprint: suffix.padEnd(64, "0"),
      status: ImportBatchStatus.pending
    }
  });
  await prisma.processingRun.create({
    data: {
      id: runId,
      orgId,
      documentId,
      jobKey: `structured_import:${runId}`,
      status: ProcessingRunStatus.queued,
      jobType: ProcessingJobType.structured_import,
      availableAt: new Date("2026-08-10T00:00:00.000Z")
    }
  });
  return { documentId, importBatchId, runId };
}

function structuredResult(overrides: { sourceSheetName?: string } = {}): StructuredParseResult {
  return {
    sheetSummary: [
      { sheetIndex: 0, name: "Sheet1", hidden: false, headerRowNumber: 1, dataRowCount: 1 }
    ],
    ignoredSheets: [],
    rows: [
      {
        sourceSheetIndex: 0,
        sourceSheetName: overrides.sourceSheetName ?? "Sheet1",
        sourceRowNumber: 2,
        payload: { business_date: "2026-08-10", matched_product_name: "Test dish" }
      }
    ],
    validationErrors: [],
    validationErrorCount: 0,
    validationErrorsTruncated: false
  };
}

function rejectedStructuredResult(): StructuredParseResult {
  return {
    ...structuredResult(),
    rows: [],
    validationErrors: [
      {
        code: "INVALID_HEADER",
        message: "Worksheet header is invalid.",
        sheetName: "Sheet1",
        sheetIndex: 0,
        rowNumber: 1,
        column: null
      }
    ],
    validationErrorCount: 1
  };
}

async function expectRepositoryState(
  prisma: PrismaClient,
  fixture: { documentId: string; importBatchId: string; runId: string },
  expected: {
    batch: ImportBatchStatus;
    document: DocumentStatus;
    run: ProcessingRunStatus;
    lockedBy: string | null;
  }
) {
  const [batch, document, run] = await Promise.all([
    prisma.importBatch.findUniqueOrThrow({ where: { id: fixture.importBatchId } }),
    prisma.document.findUniqueOrThrow({ where: { id: fixture.documentId } }),
    prisma.processingRun.findUniqueOrThrow({ where: { id: fixture.runId } })
  ]);
  expect(batch.status).toBe(expected.batch);
  expect(document.status).toBe(expected.document);
  expect(run.status).toBe(expected.run);
  expect(run.lockedBy).toBe(expected.lockedBy);
}

async function clearTestRecords(prisma: PrismaClient) {
  await prisma.auditLog.deleteMany({ where: { orgId } });
  await prisma.dishRow.deleteMany({ where: { orgId } });
  await prisma.businessRow.deleteMany({ where: { orgId } });
  await prisma.vipRow.deleteMany({ where: { orgId } });
  await prisma.dishCatalogRow.deleteMany({ where: { orgId } });
  await prisma.deliveryLedgerRow.deleteMany({ where: { orgId } });
  await prisma.supplierCatalogRow.deleteMany({ where: { orgId } });
  await prisma.processingRun.deleteMany({ where: { orgId } });
  await prisma.importWindowClaim.deleteMany({ where: { orgId } });
  await prisma.importBatch.deleteMany({ where: { orgId } });
  await prisma.document.deleteMany({ where: { orgId } });
}
