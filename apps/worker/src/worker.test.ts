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
        jobType: run.jobType,
        document: { ...document }
      };
    },
    async completeEvidenceIndexing({ documentId, runId, chunks: nextChunks }) {
      expect(documentId).toBe(document.id);
      expect(runId).toBe(run.id);

      evidenceChunks.push(...nextChunks);
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

  it("moves unsupported processing job types to processing_failed after bounded retries", async () => {
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

    await runWorkerOnce({ repository, storage });
    await runWorkerOnce({ repository, storage });
    const result = await runWorkerOnce({ repository, storage });

    expect(result).toEqual({
      processed: true,
      documentId: "doc_unknown_job",
      status: "processing_failed"
    });
    expect(repository.run.retryCount).toBe(3);
    expect(repository.run.errorCode).toBe(PROCESSING_ERROR_CODES.unsupportedProcessingJobType);
    expect(repository.document.status).toBe("processing_failed");
    expect(repository.evidenceChunks).toHaveLength(0);
    expect(repository.auditLogs.map((log) => log.action)).toEqual([
      "document.processing_started",
      "document.processing_started",
      "document.processing_started",
      "document.processing_failed"
    ]);
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
