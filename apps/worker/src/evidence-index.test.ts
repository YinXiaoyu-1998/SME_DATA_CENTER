import { describe, expect, it } from "vitest";
import {
  createEvidenceIndexer,
  type QdrantEvidencePoint,
  type QdrantEvidenceWriter
} from "./evidence-index.js";
import { createFakeEmbeddingProvider } from "./model-providers/embedding.js";
import { createFakeRerankProvider } from "./model-providers/rerank.js";
import type { ClaimedProcessingRun } from "./worker.js";

function evidenceRun(
  overrides: Partial<ClaimedProcessingRun["document"]> = {}
): ClaimedProcessingRun {
  return {
    id: "run_1",
    orgId: "default-org",
    documentId: "doc_evidence",
    retryCount: 0,
    jobType: "evidence_document_index",
    document: {
      id: "doc_evidence",
      orgId: "default-org",
      uploaderId: "emp_admin",
      status: "processing",
      storageObjectKey: "org/default-org/documents/doc_evidence/original/sop.md",
      originalFileName: "sop.md",
      documentKind: "evidence",
      fileType: "md",
      contentVersion: 1,
      ...overrides
    }
  };
}

describe("evidence indexer", () => {
  it("parses, chunks, embeds, creates sparse vectors, upserts to Qdrant, and returns chunk manifests", async () => {
    const points: QdrantEvidencePoint[] = [];
    const qdrantWriter: QdrantEvidenceWriter = {
      async upsertEvidencePoints(input) {
        points.push(...input.points);
      }
    };
    const indexer = createEvidenceIndexer({
      retrievalConfig: {
        version: "phase3.retrieval.v1",
        status: "active",
        chunker: { name: "phase3.structure-aware", version: "chunker.v1" },
        denseEmbedding: {
          provider: "fake",
          model: "fake-embedding-v1",
          version: "fake-embedding-v1@phase3.retrieval.v1",
          dimension: 8
        },
        lexical: {
          version: "lexical.v1",
          sparseModel: "qdrant-native-sparse-v1"
        },
        rerank: {
          enabled: true,
          provider: "fake",
          model: "fake-rerank-v1",
          version: "fake-rerank-v1@phase3.retrieval.v1"
        },
        qdrant: {
          collection: "enterprise_hub_evidence_test"
        }
      },
      embeddingProvider: createFakeEmbeddingProvider({
        model: "fake-embedding-v1",
        version: "fake-embedding-v1@phase3.retrieval.v1",
        dimension: 8
      }),
      rerankProvider: createFakeRerankProvider({
        model: "fake-rerank-v1",
        version: "fake-rerank-v1@phase3.retrieval.v1"
      }),
      qdrantWriter
    });

    const result = await indexer.indexDocument({
      run: evidenceRun(),
      content: Buffer.from("# 差评处理\n\n先联系客户，再登记处置结果。", "utf8")
    });

    expect(result).toMatchObject({
      retrievalConfigVersion: "phase3.retrieval.v1",
      qdrantCollection: "enterprise_hub_evidence_test",
      embeddingModel: "fake-embedding-v1",
      embeddingVersion: "fake-embedding-v1@phase3.retrieval.v1",
      lexicalIndexVersion: "lexical.v1",
      rerankVersion: "fake-rerank-v1@phase3.retrieval.v1"
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      documentId: "doc_evidence",
      chunkIndex: 0,
      indexType: "evidence",
      retrievalConfigVersion: "phase3.retrieval.v1",
      modelName: "fake-embedding-v1",
      modelVersion: "fake-embedding-v1@phase3.retrieval.v1"
    });
    expect(result.chunks[0]?.chunkId).toMatch(/^chk_/);
    expect(result.chunks[0]?.qdrantPointId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(points).toHaveLength(1);
    const firstPoint = points[0];
    expect(firstPoint).toBeDefined();

    if (!firstPoint) {
      throw new Error("Expected first Qdrant point.");
    }

    expect(firstPoint).toMatchObject({
      id: result.chunks[0]?.qdrantPointId,
      payload: {
        orgId: "default-org",
        documentId: "doc_evidence",
        chunkId: result.chunks[0]?.chunkId,
        contentVersion: 1,
        retrievalConfigVersion: "phase3.retrieval.v1"
      }
    });
    expect(firstPoint.denseVector).toHaveLength(8);
    expect(firstPoint.sparseVector.indices.length).toBeGreaterThan(0);
    expect(firstPoint.sparseVector.indices).toHaveLength(firstPoint.sparseVector.values.length);
  });
});
