import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import {
  PROCESSING_ERROR_CODES,
  ProcessingLeaseLostError,
  runWorkerOnce,
  type ClaimedProcessingRun,
  type ProcessingWorkerRepository
} from "./worker.js";

describe("structured import processing worker", () => {
  let storageRoot: string | undefined;

  afterEach(async () => {
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
      storageRoot = undefined;
    }
  });

  it("applies a valid CSV import through the leased worker", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_structured_csv",
      fileName: "dishes.csv",
      contentType: "text/csv",
      body: await readFile("fixtures/structured/dishes-valid.csv")
    });
    const repository = createStructuredImportRepository({
      storageObjectKey: stored.key,
      originalFileName: "dishes.csv",
      fileType: "csv"
    });

    const appliedAt = new Date("2026-07-20T00:00:00.000Z");
    const result = await runWorkerOnce({
      repository,
      storage,
      workerId: "worker-structured",
      now: () => appliedAt
    });

    expect(result).toEqual({
      processed: true,
      documentId: "doc_structured_csv",
      status: "active"
    });
    expect(repository.document.status).toBe("active");
    expect(repository.importBatch).toMatchObject({
      status: "applied",
      appliedAt,
      totalRowCount: 1,
      appliedRowCount: 1,
      validationErrorCount: 0,
      sourceSheetSummary: [expect.objectContaining({ name: "Sheet1", dataRowCount: 1 })]
    });
    expect(repository.rows).toEqual([
      expect.objectContaining({
        sourceSheetIndex: 0,
        sourceSheetName: "Sheet1",
        sourceRowNumber: 2
      })
    ]);
  });

  it("preserves sheet lineage for single-sheet and multi-sheet XLSX imports", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });

    const single = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_single_xlsx",
      fileName: "single.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await readFile("fixtures/structured/xlsx/typed-cells.xlsx")
    });
    const singleRepository = createStructuredImportRepository({
      storageObjectKey: single.key,
      originalFileName: "single.xlsx",
      fileType: "xlsx"
    });

    await expect(
      runWorkerOnce({ repository: singleRepository, storage, workerId: "worker-single-xlsx" })
    ).resolves.toMatchObject({ status: "active" });
    expect(singleRepository.rows).toEqual([
      expect.objectContaining({ sourceSheetIndex: 0, sourceSheetName: "Data" })
    ]);

    const multi = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_multi_xlsx",
      fileName: "multi.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await readFile("fixtures/structured/xlsx/cross-sheet.xlsx")
    });
    const multiRepository = createStructuredImportRepository({
      storageObjectKey: multi.key,
      originalFileName: "multi.xlsx",
      fileType: "xlsx"
    });

    await expect(
      runWorkerOnce({ repository: multiRepository, storage, workerId: "worker-multi-xlsx" })
    ).resolves.toMatchObject({ status: "active" });
    expect(multiRepository.rows).toHaveLength(2);
    expect(multiRepository.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceSheetIndex: 0, sourceSheetName: "First" }),
        expect.objectContaining({ sourceSheetIndex: 1, sourceSheetName: "Second" })
      ])
    );
    expect(multiRepository.importBatch.sourceSheetSummary).toEqual([
      expect.objectContaining({ name: "First", dataRowCount: 1 }),
      expect.objectContaining({ name: "Second", dataRowCount: 1 })
    ]);
  });

  it("rejects invalid headers without publishing rows", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_invalid_headers",
      fileName: "invalid.csv",
      contentType: "text/csv",
      body: await readFile("fixtures/structured/dishes-invalid-unknown-column.csv")
    });
    const repository = createStructuredImportRepository({
      storageObjectKey: stored.key,
      originalFileName: "invalid.csv",
      fileType: "csv"
    });

    await expect(
      runWorkerOnce({ repository, storage, workerId: "worker-reject" })
    ).resolves.toEqual({
      processed: true,
      documentId: "doc_structured_csv",
      status: "rejected"
    });
    expect(repository.importBatch.status).toBe("rejected");
    expect(repository.importBatch.appliedAt).toBeNull();
    expect(repository.importBatch.validationErrorCount).toBeGreaterThan(0);
    expect(repository.rows).toHaveLength(0);
    expect(repository.failures).toHaveLength(0);
  });

  it("rejects an unsupported structured file format without retrying", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_invalid_format",
      fileName: "dishes.txt",
      contentType: "text/plain",
      body: "not a structured export"
    });
    const repository = createStructuredImportRepository({
      storageObjectKey: stored.key,
      originalFileName: "dishes.txt",
      fileType: "txt"
    });

    await expect(
      runWorkerOnce({ repository, storage, workerId: "worker-format" })
    ).resolves.toEqual({
      processed: true,
      documentId: "doc_structured_csv",
      status: "rejected"
    });
    expect(repository.importBatch).toMatchObject({
      status: "rejected",
      validationErrorCount: 1
    });
    expect(repository.failures).toHaveLength(0);
    expect(repository.rows).toHaveLength(0);
  });

  it("retries transient storage failures and marks the batch failed after max attempts", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const repository = createStructuredImportRepository({
      storageObjectKey: "missing-object",
      originalFileName: "dishes.csv",
      fileType: "csv"
    });

    await expect(
      runWorkerOnce({ repository, storage, workerId: "worker-retry", maxAttempts: 2 })
    ).resolves.toMatchObject({ status: "retry_scheduled" });
    await expect(
      runWorkerOnce({ repository, storage, workerId: "worker-retry", maxAttempts: 2 })
    ).resolves.toMatchObject({ status: "processing_failed" });

    expect(repository.failures).toEqual([
      { errorCode: PROCESSING_ERROR_CODES.storageReadFailed, willRetry: true },
      { errorCode: PROCESSING_ERROR_CODES.storageReadFailed, willRetry: false }
    ]);
    expect(repository.importBatch.status).toBe("failed");
    expect(repository.importBatch.appliedAt).toBeNull();
  });

  it("does not publish rows or terminal state after losing its lease", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_lease_lost",
      fileName: "dishes.csv",
      contentType: "text/csv",
      body: await readFile("fixtures/structured/dishes-valid.csv")
    });
    const repository = createStructuredImportRepository({
      storageObjectKey: stored.key,
      originalFileName: "dishes.csv",
      fileType: "csv",
      completeError: "lease_lost"
    });

    await expect(runWorkerOnce({ repository, storage, workerId: "worker-lease" })).resolves.toEqual(
      {
        processed: true,
        documentId: "doc_structured_csv",
        status: "retry_scheduled"
      }
    );
    expect(repository.rows).toHaveLength(0);
    expect(repository.importBatch.appliedAt).toBeNull();
    expect(repository.run.status).toBe("running");
    expect(repository.failures).toHaveLength(0);
  });

  it("checks the lease against a fresh timestamp after structured parsing", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_expired_after_parse",
      fileName: "dishes.csv",
      contentType: "text/csv",
      body: await readFile("fixtures/structured/dishes-valid.csv")
    });
    const repository = createStructuredImportRepository({
      storageObjectKey: stored.key,
      originalFileName: "dishes.csv",
      fileType: "csv"
    });
    const claimedAt = new Date("2026-07-20T00:00:00.000Z");
    const expiredAt = new Date("2026-07-20T00:02:01.000Z");
    const timestamps = [claimedAt, expiredAt, expiredAt];

    await expect(
      runWorkerOnce({
        repository,
        storage,
        workerId: "worker-expired-parse",
        now: () => timestamps.shift() ?? expiredAt
      })
    ).resolves.toMatchObject({ status: "retry_scheduled" });
    expect(repository.rows).toHaveLength(0);
    expect(repository.run.status).toBe("running");
  });

  it("does not reject or fail a batch after its lease is lost", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const invalid = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_reject_lease_lost",
      fileName: "invalid.csv",
      contentType: "text/csv",
      body: await readFile("fixtures/structured/dishes-invalid-unknown-column.csv")
    });
    const rejectRepository = createStructuredImportRepository({
      storageObjectKey: invalid.key,
      originalFileName: "invalid.csv",
      fileType: "csv",
      loseLeaseWhen: "reject"
    });

    await expect(
      runWorkerOnce({ repository: rejectRepository, storage, workerId: "worker-reject-lease" })
    ).resolves.toMatchObject({ status: "retry_scheduled" });
    expect(rejectRepository.importBatch.status).toBe("validating");
    expect(rejectRepository.rejectCount).toBe(0);

    const failRepository = createStructuredImportRepository({
      storageObjectKey: "missing-object",
      originalFileName: "dishes.csv",
      fileType: "csv",
      loseLeaseWhen: "fail"
    });
    await expect(
      runWorkerOnce({ repository: failRepository, storage, workerId: "worker-fail-lease" })
    ).resolves.toMatchObject({ status: "retry_scheduled" });
    expect(failRepository.importBatch.status).toBe("validating");
    expect(failRepository.failures).toHaveLength(0);
  });

  it("allows only one worker to claim and apply a contended structured import", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_race",
      fileName: "dishes.csv",
      contentType: "text/csv",
      body: await readFile("fixtures/structured/dishes-valid.csv")
    });
    const repository = createStructuredImportRepository({
      storageObjectKey: stored.key,
      originalFileName: "dishes.csv",
      fileType: "csv"
    });

    const results = await Promise.all([
      runWorkerOnce({ repository, storage, workerId: "worker-a" }),
      runWorkerOnce({ repository, storage, workerId: "worker-b" })
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        { processed: true, documentId: "doc_structured_csv", status: "active" },
        { processed: false }
      ])
    );
    expect(repository.rows).toHaveLength(1);
    expect(repository.run.attemptNumber).toBe(1);
  });

  it("keeps existing rows intact when atomic apply fails", async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_atomic_failure",
      fileName: "dishes.csv",
      contentType: "text/csv",
      body: await readFile("fixtures/structured/dishes-valid.csv")
    });
    const existingRow = { sourceRowNumber: 99 };
    const repository = createStructuredImportRepository({
      storageObjectKey: stored.key,
      originalFileName: "dishes.csv",
      fileType: "csv",
      completeError: "apply_failure",
      initialRows: [existingRow]
    });

    await expect(
      runWorkerOnce({ repository, storage, workerId: "worker-atomic" })
    ).resolves.toMatchObject({
      status: "retry_scheduled"
    });
    expect(repository.applyAttempts).toEqual([{ deletedRowCount: 1, insertedRowCount: 1 }]);
    expect(repository.rows).toEqual([existingRow]);
    expect(repository.importBatch.appliedAt).toBeNull();
  });
});

function createStructuredImportRepository(options: {
  storageObjectKey: string;
  originalFileName: string;
  fileType: string;
  completeError?: "lease_lost" | "apply_failure";
  initialRows?: unknown[];
  loseLeaseWhen?: "complete" | "reject" | "fail";
}): ProcessingWorkerRepository & {
  document: { status: string };
  importBatch: {
    status: string;
    appliedAt: Date | null;
    totalRowCount: number;
    appliedRowCount: number;
    validationErrorCount: number;
    sourceSheetSummary: unknown[];
  };
  rows: unknown[];
  run: { status: string; retryCount: number; attemptNumber: number };
  failures: Array<{ errorCode: string; willRetry: boolean }>;
  rejectCount: number;
  applyAttempts: Array<{ deletedRowCount: number; insertedRowCount: number }>;
} {
  const document = {
    id: "doc_structured_csv",
    orgId: "default-org",
    uploaderId: "emp_1",
    status: "pending_processing",
    storageObjectKey: options.storageObjectKey,
    originalFileName: options.originalFileName,
    documentKind: "structured",
    fileType: options.fileType
  };
  const run = {
    id: "run_structured_csv",
    orgId: document.orgId,
    documentId: document.id,
    status: "queued",
    attemptNumber: 0,
    retryCount: 0,
    lockedBy: null as string | null,
    lockedUntil: null as Date | null
  };
  const importBatch = {
    status: "pending",
    appliedAt: null as Date | null,
    totalRowCount: 0,
    appliedRowCount: 0,
    validationErrorCount: 0,
    sourceSheetSummary: [] as unknown[]
  };
  const rows: unknown[] = [...(options.initialRows ?? [])];
  const failures: Array<{ errorCode: string; willRetry: boolean }> = [];
  const applyAttempts: Array<{ deletedRowCount: number; insertedRowCount: number }> = [];
  let rejectCount = 0;

  return {
    document,
    importBatch,
    rows,
    run,
    failures,
    applyAttempts,
    get rejectCount() {
      return rejectCount;
    },
    async claimNextProcessingRun({
      workerId,
      now,
      leaseSeconds
    }): Promise<ClaimedProcessingRun | null> {
      await Promise.resolve();
      if (!(["queued", "retry_scheduled"] as string[]).includes(run.status)) return null;
      run.status = "running";
      run.attemptNumber += 1;
      run.lockedBy = workerId;
      run.lockedUntil = new Date(now.getTime() + leaseSeconds * 1_000);
      document.status = "processing";
      importBatch.status = "validating";
      return {
        id: run.id,
        orgId: run.orgId,
        documentId: run.documentId,
        retryCount: run.retryCount,
        attemptNumber: run.attemptNumber,
        jobType: "structured_import",
        lockedBy: run.lockedBy,
        lockedUntil: run.lockedUntil,
        structuredImport: {
          importBatchId: "batch_structured_csv",
          dataset: "dishes",
          registryVersion: "dishes.2026-09-04.v2",
          startDate: "20260701",
          endDate: "20260731"
        },
        document: { ...document }
      };
    },
    async failProcessingRun(input) {
      if (options.loseLeaseWhen === "fail") loseLease(run);
      if (run.lockedBy !== input.workerId || !run.lockedUntil || run.lockedUntil <= input.now) {
        throw new ProcessingLeaseLostError(input.runId);
      }
      failures.push({ errorCode: input.errorCode, willRetry: input.willRetry });
      run.retryCount += 1;
      run.lockedBy = null;
      run.lockedUntil = null;
      run.status = input.willRetry ? "retry_scheduled" : "failed";
      document.status = input.willRetry ? "pending_processing" : "processing_failed";
      if (!input.willRetry) importBatch.status = "failed";
    },
    async beginStructuredImportApply() {
      importBatch.status = "applying";
    },
    async rejectStructuredImport(input) {
      if (options.loseLeaseWhen === "reject") loseLease(run);
      if (run.lockedBy !== input.workerId || !run.lockedUntil || run.lockedUntil <= input.now) {
        throw new ProcessingLeaseLostError(input.runId);
      }
      rejectCount += 1;
      importBatch.status = "rejected";
      importBatch.sourceSheetSummary = input.result.sheetSummary;
      importBatch.validationErrorCount = input.result.validationErrorCount;
      document.status = "processing_failed";
      run.status = "failed";
      run.lockedBy = null;
      run.lockedUntil = null;
    },
    async completeStructuredImport(input: {
      result: { rows: unknown[]; sheetSummary: unknown[] };
      workerId: string;
      now: Date;
    }) {
      if (options.loseLeaseWhen === "complete") loseLease(run);
      if (run.lockedBy !== input.workerId || !run.lockedUntil || run.lockedUntil <= input.now) {
        throw new ProcessingLeaseLostError(run.id);
      }
      if (options.completeError === "lease_lost") throw new ProcessingLeaseLostError(run.id);
      const stagedRows = [...rows];
      const deletedRowCount = stagedRows.length;
      stagedRows.splice(0, stagedRows.length);
      stagedRows.push(...input.result.rows);
      applyAttempts.push({ deletedRowCount, insertedRowCount: input.result.rows.length });
      if (options.completeError === "apply_failure") throw new Error("database write failed");
      rows.splice(0, rows.length, ...stagedRows);
      importBatch.status = "applied";
      importBatch.appliedAt = input.now;
      importBatch.totalRowCount = input.result.rows.length;
      importBatch.appliedRowCount = input.result.rows.length;
      importBatch.sourceSheetSummary = input.result.sheetSummary;
      document.status = "active";
      run.status = "succeeded";
    }
  } as ProcessingWorkerRepository & {
    document: { status: string };
    importBatch: {
      status: string;
      appliedAt: Date | null;
      totalRowCount: number;
      appliedRowCount: number;
      validationErrorCount: number;
      sourceSheetSummary: unknown[];
    };
    rows: unknown[];
    run: { status: string; retryCount: number; attemptNumber: number };
    failures: Array<{ errorCode: string; willRetry: boolean }>;
    rejectCount: number;
    applyAttempts: Array<{ deletedRowCount: number; insertedRowCount: number }>;
  };
}

function loseLease(run: { lockedBy: string | null; lockedUntil: Date | null }) {
  run.lockedBy = "worker-other";
  run.lockedUntil = new Date("2099-01-01T00:00:00.000Z");
}
