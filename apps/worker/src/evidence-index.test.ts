import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildRetrievalConfigSeed, loadActiveRetrievalConfig } from "@smedc/domain";
import {
  HttpQdrantEvidenceWriter,
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
    attemptNumber: 1,
    jobType: "evidence_document_index",
    lockedBy: "worker-a",
    lockedUntil: new Date("2026-07-20T00:02:00.000Z"),
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
      confidentialityLevel: 0,
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
          sparseModel: "qdrant-native-sparse-v1",
          strategy: "legacy_hash_tf"
        },
        rerank: {
          enabled: true,
          provider: "fake",
          model: "fake-rerank-v1",
          version: "fake-rerank-v1@phase3.retrieval.v1"
        },
        relevance: {
          version: "relevance.disabled@phase3.retrieval.v1",
          mode: "disabled",
          rerankMinScore: 0.3,
          rerankMinGap: 0.3,
          rerankLowClusterMaxScore: 0.4
        },
        qdrant: {
          collection: "smedc_evidence_test"
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
      qdrantCollection: "smedc_evidence_test",
      embeddingProvider: "fake",
      embeddingModel: "fake-embedding-v1",
      embeddingVersion: "fake-embedding-v1@phase3.retrieval.v1",
      embeddingDimension: 8,
      lexicalIndexVersion: "lexical.v1",
      rerankProvider: "fake",
      rerankModel: "fake-rerank-v1",
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
    expect(firstPoint.lexicalVectorName).toBe("sparse");
    expect(firstPoint.lexicalVector).toMatchObject({
      indices: expect.any(Array),
      values: expect.any(Array)
    });
  });

  it("writes V2 chunk text as the shared multilingual BM25 document", async () => {
    const points: QdrantEvidencePoint[] = [];
    const indexer = createEvidenceIndexer({
      retrievalConfig: loadActiveRetrievalConfig(
        buildRetrievalConfigSeed({ retrievalConfigVersion: "phase3.retrieval.v2-bm25" }),
        "phase3.retrieval.v2-bm25"
      ),
      embeddingProvider: createFakeEmbeddingProvider({
        model: "fake-embedding-v1",
        version: "fake-embedding-v1@phase3.retrieval.v2-bm25",
        dimension: 8
      }),
      rerankProvider: null,
      qdrantWriter: {
        async upsertEvidencePoints(input) {
          points.push(...input.points);
        }
      }
    });

    await indexer.indexDocument({
      run: evidenceRun(),
      content: Buffer.from("# 肉夹馍\n\n肉夹馍制作步骤", "utf8")
    });

    expect(points[0]?.lexicalVectorName).toBe("bm25");
    expect(points[0]?.lexicalVector).toMatchObject({
      model: "qdrant/bm25",
      options: { tokenizer: "multilingual", stemmer: { type: "none" }, stopwords: {} }
    });
    expect(JSON.stringify(points[0]?.lexicalVector)).toContain("肉夹馍制作步骤");
  });
});

describe("PDF evidence candidate indexing", () => {
  const content = Buffer.from("%PDF synthetic source");
  async function harness() {
    const dto = JSON.parse(
      await readFile("fixtures/evidence/pdf/contracts/valid-mixed.json", "utf8")
    );
    dto.sourceChecksumSha256 = createHash("sha256").update(content).digest("hex");
    const attempts: import("./evidence-artifacts.js").PdfEvidenceAttempt[] = [];
    const points: QdrantEvidencePoint[] = [];
    const objects = new Map<string, string>();
    const deleted: string[] = [];
    const indexer = createEvidenceIndexer({
      retrievalConfig: loadActiveRetrievalConfig(buildRetrievalConfigSeed(), "phase3.retrieval.v1"),
      embeddingProvider: createFakeEmbeddingProvider({
        model: "fake",
        version: "v1",
        dimension: 8
      }),
      rerankProvider: null,
      pdfParserClient: {
        async parse() {
          return dto;
        }
      },
      pdfArtifacts: {
        async stage({ attempt }) {
          attempts.push(attempt);
        },
        async listRecoverable() {
          return attempts;
        },
        async claimCleanup() {
          return "cleanup";
        },
        async finishCleanup() {}
      },
      storage: {
        async putObjectAtKey({ key, body }) {
          let data = "";
          for await (const chunk of body) data += chunk.toString();
          objects.set(key, data);
          return { key, size: data.length, hash: "synthetic" };
        },
        async deleteObject(key) {
          deleted.push(key);
          objects.delete(key);
        }
      },
      qdrantWriter: {
        async upsertEvidencePoints(input) {
          expect(attempts.length).toBeGreaterThan(0);
          points.push(...input.points);
        },
        async deleteEvidencePoints({ pointIds }) {
          deleted.push(...pointIds);
        }
      }
    });
    return { dto, attempts, points, objects, deleted, indexer };
  }
  it("stages exact ownership and parsed JSON before publishing unique PDF generation points", async () => {
    const h = await harness();
    const run = evidenceRun({
      fileType: "pdf",
      checksumSha256: createHash("sha256").update(content).digest("hex")
    });
    const first = await h.indexer.indexDocument({
      run,
      content,
      signal: new AbortController().signal
    });
    const second = await h.indexer.indexDocument({
      run: { ...run, attemptNumber: 2 },
      content,
      signal: new AbortController().signal
    });
    expect(first.parserFingerprint).toBe(h.dto.parserFingerprint);
    expect(first.parseSummary).toMatchObject({ pageCount: 3, complete: true });
    expect(first.chunks.length).toBeGreaterThan(0);
    expect(first.chunks.map((c) => c.qdrantPointId)).not.toEqual(
      second.chunks.map((c) => c.qdrantPointId)
    );
    expect(
      first.chunks.find((c) => (c.sourceLocation.blockTypes as string[]).includes("table"))
        ?.chunkText
    ).toContain("表头:");
    expect(h.attempts[0]?.pointIds).toEqual(first.chunks.map((c) => c.qdrantPointId));
    expect(h.objects.has(first.parsedObjectKey!)).toBe(true);
    expect(h.deleted).toEqual([]);
  });
  it("rejects checksum mismatch before parsing or creating artifacts", async () => {
    const h = await harness();
    await expect(
      h.indexer.indexDocument({
        run: evidenceRun({ fileType: "pdf", checksumSha256: "b".repeat(64) }),
        content
      })
    ).rejects.toMatchObject({ code: "PDF_SOURCE_MISMATCH" });
    expect(h.attempts).toEqual([]);
  });
  it("rejects failed pages without activating partial output", async () => {
    const h = await harness();
    h.dto.pages[0].outcome = "failed";
    await expect(
      h.indexer.indexDocument({ run: evidenceRun({ fileType: "pdf" }), content })
    ).rejects.toMatchObject({ code: "PDF_INCOMPLETE" });
    expect(h.points).toEqual([]);
  });
  it("returns a clear error for an entirely blank PDF", async () => {
    const h = await harness();
    Object.assign(h.dto, {
      pageCount: 1,
      pages: [{ pageNumber: 1, outcome: "blank" }],
      blocks: [],
      tables: [],
      pictures: [],
      warnings: []
    });
    await expect(
      h.indexer.indexDocument({ run: evidenceRun({ fileType: "pdf" }), content })
    ).rejects.toMatchObject({ code: "PDF_NO_SEARCHABLE_TEXT" });
  });
  it("rejects cancellation before external artifacts are written", async () => {
    const h = await harness();
    const abort = new AbortController();
    abort.abort();
    await expect(
      h.indexer.indexDocument({
        run: evidenceRun({ fileType: "pdf" }),
        content,
        signal: abort.signal
      })
    ).rejects.toThrow();
    expect(h.objects.size).toBe(0);
  });
});

describe("exact candidate Qdrant cleanup", () => {
  it("deletes bounded recorded point IDs with no document or org filters", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const writer = new HttpQdrantEvidenceWriter({
      url: "http://qdrant.invalid",
      apiKey: null,
      timeoutMs: 1000,
      fetch: async (url, options) => {
        requests.push({ url: String(url), body: JSON.parse(String(options?.body)) });
        return new Response("{}", { status: 200 });
      }
    });
    const ids = Array.from({ length: 257 }, (_, index) => `synthetic-${index}`);
    await writer.deleteEvidencePoints({ collection: "owned collection", pointIds: ids });
    expect(requests.map((request) => request.url)).toEqual([
      "http://qdrant.invalid/collections/owned%20collection/points/delete?wait=true",
      "http://qdrant.invalid/collections/owned%20collection/points/delete?wait=true"
    ]);
    expect(requests.map((request) => request.body)).toEqual([
      { points: ids.slice(0, 256) },
      { points: ids.slice(256) }
    ]);
  });
});
