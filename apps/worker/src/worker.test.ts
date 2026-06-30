import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import {
  PROCESSING_ERROR_CODES,
  runWorkerOnce,
  type ClaimedProcessingRun,
  type DocumentChunkWrite,
  type ProcessingWorkerRepository
} from "./worker.js";

interface RecordedDocument {
  id: string;
  orgId: string;
  uploaderId: string;
  status: string;
  storageObjectKey: string;
  originalFileName: string | null;
}

interface RecordedRun {
  id: string;
  orgId: string;
  documentId: string;
  status: string;
  retryCount: number;
  errorCode: string | null;
}

interface RecordedAuditLog {
  action: string;
  targetId: string;
  result: string;
}

function createFakeRepository(input: {
  document: RecordedDocument;
  run?: Partial<RecordedRun>;
}): ProcessingWorkerRepository & {
  document: RecordedDocument;
  run: RecordedRun;
  chunks: DocumentChunkWrite[];
  auditLogs: RecordedAuditLog[];
} {
  const document = input.document;
  const run: RecordedRun = {
    id: input.run?.id ?? "run_1",
    orgId: document.orgId,
    documentId: document.id,
    status: input.run?.status ?? "queued",
    retryCount: input.run?.retryCount ?? 0,
    errorCode: input.run?.errorCode ?? null
  };
  const chunks: DocumentChunkWrite[] = [];
  const auditLogs: RecordedAuditLog[] = [];

  return {
    document,
    run,
    chunks,
    auditLogs,
    async claimNextProcessingRun(): Promise<ClaimedProcessingRun | null> {
      if (!["queued", "retry_scheduled"].includes(run.status)) {
        return null;
      }

      run.status = "running";
      document.status = "processing";
      auditLogs.push({
        action: "document.processing_started",
        targetId: document.id,
        result: "succeeded"
      });

      return {
        id: run.id,
        orgId: run.orgId,
        documentId: run.documentId,
        retryCount: run.retryCount,
        document: { ...document }
      };
    },
    async completeProcessingRun({ documentId, runId, chunks: nextChunks }) {
      expect(documentId).toBe(document.id);
      expect(runId).toBe(run.id);

      for (const nextChunk of nextChunks) {
        if (
          !chunks.some(
            (chunk) =>
              chunk.documentId === nextChunk.documentId &&
              chunk.chunkHash === nextChunk.chunkHash &&
              chunk.indexType === nextChunk.indexType
          )
        ) {
          chunks.push(nextChunk);
        }
      }

      run.status = "succeeded";
      document.status = "active";
      auditLogs.push({
        action: "document.activated",
        targetId: document.id,
        result: "succeeded"
      });
    },
    async failProcessingRun({ documentId, runId, errorCode, willRetry }) {
      expect(documentId).toBe(document.id);
      expect(runId).toBe(run.id);

      run.retryCount += 1;
      run.errorCode = errorCode;

      if (willRetry) {
        run.status = "retry_scheduled";
        document.status = "pending_processing";
        return;
      }

      run.status = "failed";
      document.status = "processing_failed";
      auditLogs.push({
        action: "document.processing_failed",
        targetId: document.id,
        result: "failed"
      });
    }
  };
}

describe("processing worker", () => {
  let storageRoot: string | undefined;

  afterEach(async () => {
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
      storageRoot = undefined;
    }
  });

  async function createStorage() {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-worker-"));
    return new LocalFileSystemStorageAdapter({ root: storageRoot });
  }

  it("activates a supported CSV document and writes deterministic chunks", async () => {
    const storage = await createStorage();
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_csv",
      fileName: "baoli-june-meituan.csv",
      contentType: "text/csv",
      body: "date,revenue\n2026-06-01,100\n2026-06-02,120\n"
    });
    const repository = createFakeRepository({
      document: {
        id: "doc_csv",
        orgId: "default-org",
        uploaderId: "emp_baoli_manager",
        status: "pending_processing",
        storageObjectKey: stored.key,
        originalFileName: "baoli-june-meituan.csv"
      }
    });

    const result = await runWorkerOnce({ repository, storage });

    expect(result).toEqual({ processed: true, documentId: "doc_csv", status: "active" });
    expect(repository.document.status).toBe("active");
    expect(repository.run.status).toBe("succeeded");
    expect(repository.chunks.length).toBeGreaterThanOrEqual(1);
    expect(repository.chunks.map((chunk) => chunk.chunkText)).toContain("date,revenue");
    expect(repository.auditLogs.map((log) => log.action)).toEqual([
      "document.processing_started",
      "document.activated"
    ]);
  });

  it("does not duplicate chunks when the same document is processed again", async () => {
    const storage = await createStorage();
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_idempotent",
      fileName: "notes.md",
      contentType: "text/markdown",
      body: "# Daily Notes\n\nFirst paragraph\nSecond paragraph\n"
    });
    const repository = createFakeRepository({
      document: {
        id: "doc_idempotent",
        orgId: "default-org",
        uploaderId: "emp_baoli_manager",
        status: "pending_processing",
        storageObjectKey: stored.key,
        originalFileName: "notes.md"
      }
    });

    await runWorkerOnce({ repository, storage });
    const firstChunkCount = repository.chunks.length;
    repository.run.status = "queued";
    repository.document.status = "pending_processing";
    await runWorkerOnce({ repository, storage });

    expect(firstChunkCount).toBeGreaterThan(0);
    expect(repository.chunks).toHaveLength(firstChunkCount);
  });

  it("moves unsupported files to processing_failed after bounded retries", async () => {
    const storage = await createStorage();
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_binary",
      fileName: "receipt.pdf",
      contentType: "application/pdf",
      body: Buffer.from([0xff, 0xd8, 0xff, 0x00])
    });
    const repository = createFakeRepository({
      document: {
        id: "doc_binary",
        orgId: "default-org",
        uploaderId: "emp_baoli_manager",
        status: "pending_processing",
        storageObjectKey: stored.key,
        originalFileName: "receipt.pdf"
      }
    });

    await runWorkerOnce({ repository, storage });
    await runWorkerOnce({ repository, storage });
    const result = await runWorkerOnce({ repository, storage });

    expect(result).toEqual({
      processed: true,
      documentId: "doc_binary",
      status: "processing_failed"
    });
    expect(repository.run.retryCount).toBe(3);
    expect(repository.run.errorCode).toBe(PROCESSING_ERROR_CODES.unsupportedFileType);
    expect(repository.document.status).toBe("processing_failed");
    expect(repository.chunks).toHaveLength(0);
    expect(repository.auditLogs.map((log) => log.action)).toEqual([
      "document.processing_started",
      "document.processing_started",
      "document.processing_started",
      "document.processing_failed"
    ]);
  });
});
