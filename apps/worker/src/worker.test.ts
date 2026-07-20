import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import {
  PROCESSING_ERROR_CODES,
  runWorkerLoop,
  runWorkerOnce,
  type ClaimedProcessingRun,
  type EvidenceDocumentChunkWrite,
  type EvidenceIndexer,
  type ProcessingWorkerRepository
} from "./worker.js";

interface RecordedDocument {
  id: string;
  orgId: string;
  uploaderId: string;
  status: string;
  storageObjectKey: string;
  originalFileName: string | null;
  documentKind?: string | null;
  fileType?: string | null;
  contentVersion?: number;
}

interface RecordedRun {
  id: string;
  orgId: string;
  documentId: string;
  status: string;
  retryCount: number;
  attemptNumber: number;
  availableAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  errorCode: string | null;
  jobType: string;
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
  evidenceChunks: EvidenceDocumentChunkWrite[];
  auditLogs: RecordedAuditLog[];
} {
  const document = input.document;
  const run: RecordedRun = {
    id: input.run?.id ?? "run_1",
    orgId: document.orgId,
    documentId: document.id,
    status: input.run?.status ?? "queued",
    retryCount: input.run?.retryCount ?? 0,
    attemptNumber: input.run?.attemptNumber ?? 0,
    availableAt: new Date("2026-07-20T00:00:00.000Z"),
    lockedBy: null,
    lockedUntil: null,
    errorCode: input.run?.errorCode ?? null,
    jobType: input.run?.jobType ?? "evidence_document_index"
  };
  const evidenceChunks: EvidenceDocumentChunkWrite[] = [];
  const auditLogs: RecordedAuditLog[] = [];

  return {
    document,
    run,
    evidenceChunks,
    auditLogs,
    async claimNextProcessingRun({
      workerId,
      now,
      leaseSeconds
    }): Promise<ClaimedProcessingRun | null> {
      const claimable =
        (["queued", "retry_scheduled"].includes(run.status) && run.availableAt <= now) ||
        (run.status === "running" && run.lockedUntil !== null && run.lockedUntil < now);
      if (!claimable) {
        return null;
      }

      run.status = "running";
      run.attemptNumber += 1;
      run.lockedBy = workerId;
      run.lockedUntil = new Date(now.getTime() + leaseSeconds * 1_000);
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
        attemptNumber: run.attemptNumber,
        jobType: run.jobType,
        lockedBy: run.lockedBy,
        lockedUntil: run.lockedUntil,
        document: { ...document }
      };
    },
    async heartbeatProcessingRun({ runId, workerId, now, leaseSeconds }) {
      if (
        run.id !== runId ||
        run.lockedBy !== workerId ||
        run.status !== "running" ||
        !run.lockedUntil ||
        run.lockedUntil <= now
      ) {
        return false;
      }
      run.lockedUntil = new Date(now.getTime() + leaseSeconds * 1_000);
      return true;
    },
    async completeEvidenceIndexing({ documentId, runId, workerId, now, chunks: nextChunks }) {
      expect(documentId).toBe(document.id);
      expect(runId).toBe(run.id);
      expect(run.lockedBy).toBe(workerId);
      expect(run.lockedUntil && run.lockedUntil > now).toBe(true);

      evidenceChunks.push(...nextChunks);
      run.status = "succeeded";
      run.lockedBy = null;
      run.lockedUntil = null;
      document.status = "active";
      auditLogs.push({
        action: "document.activated",
        targetId: document.id,
        result: "succeeded"
      });
    },
    async failProcessingRun({
      documentId,
      runId,
      workerId,
      now,
      errorCode,
      willRetry,
      nextAvailableAt
    }) {
      expect(documentId).toBe(document.id);
      expect(runId).toBe(run.id);
      expect(run.lockedBy).toBe(workerId);
      expect(run.lockedUntil && run.lockedUntil > now).toBe(true);

      run.retryCount += 1;
      run.errorCode = errorCode;
      run.lockedBy = null;
      run.lockedUntil = null;
      run.availableAt = nextAvailableAt;

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

  it("runs as a loop until the queue is idle and the caller aborts", async () => {
    const storage = await createStorage();
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_loop",
      fileName: "loop.md",
      contentType: "text/markdown",
      body: "# Loop"
    });
    const repository = createFakeRepository({
      document: {
        id: "doc_loop",
        orgId: "default-org",
        uploaderId: "emp_baoli_manager",
        status: "pending_processing",
        storageObjectKey: stored.key,
        originalFileName: "loop.md",
        documentKind: "evidence",
        fileType: "md",
        contentVersion: 1
      }
    });
    const evidenceIndexer: EvidenceIndexer = {
      async indexDocument() {
        return {
          retrievalConfigVersion: "phase3.retrieval.v1",
          qdrantCollection: "enterprise_hub_evidence_test",
          embeddingProvider: "fake",
          embeddingModel: "fake-embedding-v1",
          embeddingVersion: "fake-embedding-v1@phase3.retrieval.v1",
          embeddingDimension: 8,
          lexicalIndexVersion: "lexical.v1",
          rerankProvider: null,
          rerankModel: null,
          rerankVersion: null,
          chunks: []
        };
      }
    };
    const abortController = new AbortController();
    const results: unknown[] = [];

    await runWorkerLoop({
      repository,
      storage,
      evidenceIndexer,
      pollIntervalMs: 100,
      signal: abortController.signal,
      onResult(result) {
        results.push(result);

        if (!result.processed) {
          abortController.abort();
        }
      }
    });

    expect(results).toEqual([
      { processed: true, documentId: "doc_loop", status: "active" },
      { processed: false }
    ]);
    expect(repository.document.status).toBe("active");
  });

  it("moves unsupported processing job types to processing_failed without retry", async () => {
    const storage = await createStorage();
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_unknown_job",
      fileName: "receipt.md",
      contentType: "text/markdown",
      body: "# Receipt"
    });
    const repository = createFakeRepository({
      document: {
        id: "doc_unknown_job",
        orgId: "default-org",
        uploaderId: "emp_baoli_manager",
        status: "pending_processing",
        storageObjectKey: stored.key,
        originalFileName: "receipt.md",
        documentKind: "evidence",
        fileType: "md",
        contentVersion: 1
      },
      run: {
        jobType: "unknown_job_type"
      }
    });

    const result = await runWorkerOnce({
      repository,
      storage,
      workerId: "worker-a",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    expect(result).toEqual({
      processed: true,
      documentId: "doc_unknown_job",
      status: "processing_failed"
    });
    expect(repository.run.retryCount).toBe(1);
    expect(repository.run.attemptNumber).toBe(1);
    expect(repository.run.errorCode).toBe(PROCESSING_ERROR_CODES.unsupportedProcessingJobType);
    expect(repository.document.status).toBe("processing_failed");
    expect(repository.evidenceChunks).toHaveLength(0);
    expect(repository.auditLogs.map((log) => log.action)).toEqual([
      "document.processing_started",
      "document.processing_failed"
    ]);
  });

  it("schedules transient failures with exponential backoff and max attempts", async () => {
    const storage = await createStorage();
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_transient",
      fileName: "transient.md",
      contentType: "text/markdown",
      body: "# Transient"
    });
    const repository = createFakeRepository({
      document: {
        id: "doc_transient",
        orgId: "default-org",
        uploaderId: "emp_baoli_manager",
        status: "pending_processing",
        storageObjectKey: stored.key,
        originalFileName: "transient.md",
        documentKind: "evidence",
        fileType: "md",
        contentVersion: 1
      }
    });
    const times = [
      new Date("2026-07-20T00:00:00.000Z"),
      new Date("2026-07-20T00:00:01.000Z"),
      new Date("2026-07-20T00:00:03.000Z")
    ];
    const evidenceIndexer: EvidenceIndexer = {
      async indexDocument() {
        throw new Error("temporary provider failure");
      }
    };

    for (const [index, now] of times.entries()) {
      const result = await runWorkerOnce({
        repository,
        storage,
        evidenceIndexer,
        workerId: "worker-a",
        leaseSeconds: 10,
        maxAttempts: 3,
        retryBaseMs: 1_000,
        retryMaxMs: 60_000,
        now: () => now
      });
      expect(result.processed).toBe(true);
      if (index === 0) {
        expect(repository.run.availableAt.toISOString()).toBe("2026-07-20T00:00:01.000Z");
      }
      if (index === 1) {
        expect(repository.run.availableAt.toISOString()).toBe("2026-07-20T00:00:03.000Z");
      }
      if (index < times.length - 1) {
        repository.run.availableAt = now;
        repository.document.status = "pending_processing";
      }
    }

    expect(repository.run.retryCount).toBe(3);
    expect(repository.run.attemptNumber).toBe(3);
    expect(repository.run.status).toBe("failed");
    expect(repository.document.status).toBe("processing_failed");
    expect(repository.run.errorCode).toBe(PROCESSING_ERROR_CODES.evidenceIndexingFailed);
  });

  it("runs evidence indexing jobs before activating MD evidence documents", async () => {
    const storage = await createStorage();
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_evidence_md",
      fileName: "customer-feedback-sop.md",
      contentType: "text/markdown",
      body: "# 差评处理\n\n先联系客户，再登记处置结果。"
    });
    const repository = createFakeRepository({
      document: {
        id: "doc_evidence_md",
        orgId: "default-org",
        uploaderId: "emp_baoli_manager",
        status: "pending_processing",
        storageObjectKey: stored.key,
        originalFileName: "customer-feedback-sop.md",
        documentKind: "evidence",
        fileType: "md",
        contentVersion: 1
      },
      run: {
        jobType: "evidence_document_index"
      }
    });
    const indexedInputs: string[] = [];
    const evidenceIndexer: EvidenceIndexer = {
      async indexDocument(input) {
        indexedInputs.push(input.content.toString("utf8"));
        return {
          retrievalConfigVersion: "phase3.retrieval.v1",
          qdrantCollection: "enterprise_hub_evidence_test",
          embeddingProvider: "fake",
          embeddingModel: "fake-embedding-v1",
          embeddingVersion: "fake-embedding-v1@phase3.retrieval.v1",
          embeddingDimension: 8,
          lexicalIndexVersion: "lexical.v1",
          rerankProvider: "fake",
          rerankModel: "fake-rerank-v1",
          rerankVersion: "fake-rerank-v1@phase3.retrieval.v1",
          chunks: [
            {
              documentId: "doc_evidence_md",
              chunkIndex: 0,
              chunkText: "差评处理\n\n先联系客户，再登记处置结果。",
              chunkHash: "hash_1",
              indexType: "evidence",
              chunkId: "chk_1",
              qdrantPointId: "00000000-0000-4000-8000-000000000001",
              contentVersion: 1,
              retrievalConfigVersion: "phase3.retrieval.v1",
              modelName: "fake-embedding-v1",
              modelVersion: "fake-embedding-v1@phase3.retrieval.v1",
              sourceLocation: {
                sectionHeadingPath: ["差评处理"],
                blockTypes: ["heading", "paragraph"],
                sourceLocations: [{ startLine: 1, endLine: 3 }]
              }
            }
          ]
        };
      }
    };

    const result = await runWorkerOnce({ repository, storage, evidenceIndexer });

    expect(result).toEqual({ processed: true, documentId: "doc_evidence_md", status: "active" });
    expect(indexedInputs).toEqual(["# 差评处理\n\n先联系客户，再登记处置结果。"]);
    expect(repository.evidenceChunks).toHaveLength(1);
    expect(repository.evidenceChunks[0]).toMatchObject({
      indexType: "evidence",
      chunkId: "chk_1",
      retrievalConfigVersion: "phase3.retrieval.v1"
    });
    expect(repository.document.status).toBe("active");
  });

  it("does not activate evidence documents when indexing fails", async () => {
    const storage = await createStorage();
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId: "doc_evidence_fail",
      fileName: "broken.md",
      contentType: "text/markdown",
      body: "# Broken"
    });
    const repository = createFakeRepository({
      document: {
        id: "doc_evidence_fail",
        orgId: "default-org",
        uploaderId: "emp_baoli_manager",
        status: "pending_processing",
        storageObjectKey: stored.key,
        originalFileName: "broken.md",
        documentKind: "evidence",
        fileType: "md",
        contentVersion: 1
      },
      run: {
        jobType: "evidence_document_index"
      }
    });
    const evidenceIndexer: EvidenceIndexer = {
      async indexDocument() {
        throw new Error("Qdrant upsert failed");
      }
    };

    const result = await runWorkerOnce({ repository, storage, evidenceIndexer });

    expect(result).toEqual({
      processed: true,
      documentId: "doc_evidence_fail",
      status: "retry_scheduled"
    });
    expect(repository.document.status).toBe("pending_processing");
    expect(repository.evidenceChunks).toHaveLength(0);
  });
});
